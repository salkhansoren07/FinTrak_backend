import { parseTransaction } from "../lib/parseTransaction.js";
import { getUserFromAccessToken } from "../lib/googleIdentity.js";
import {
  buildGoogleAuthUrl,
  createCodeVerifier,
  createOAuthState,
  exchangeGoogleCode,
  getFrontendBaseUrl,
  hasGoogleOAuthConfig,
} from "../lib/googleOAuth.js";
import { getServerGmailAccessToken } from "../lib/googleSession.js";
import {
  clearFintrakUserGmailConnection,
  getFintrakUserById,
  updateFintrakUserGmailConnection,
} from "../lib/fintrakUsers.js";
import {
  applyOAuthFlowCookie,
  clearOAuthFlowCookie,
  readOAuthFlowFromRequest,
  readSessionFromRequest,
} from "../lib/serverAuth.js";
import { encryptSecretValue } from "../lib/serverSecrets.js";
import {
  getSharedJson,
  hasSharedRedisConfig,
} from "../lib/sharedRedis.js";
import { getSupabaseAdmin, hasSupabaseAdminConfig } from "../lib/supabaseAdmin.js";

const QUERY =
  '(debited OR credited OR transaction OR txn OR upi OR utr OR withdrawn OR deposited OR "available bal" OR "a/c")';
const PAGE_SIZE = 100;
const MAX_MESSAGES = 200;
const DETAIL_CONCURRENCY = 8;
const SERVER_CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_TRANSACTION_CACHE_ENTRIES = 200;
const TRANSACTION_PARSER_VERSION = 2;

const transactionCache = new Map();

function buildFrontendRedirect(params = {}) {
  const url = new URL("/", getFrontendBaseUrl());
  Object.entries(params).forEach(([key, value]) => {
    if (value) {
      url.searchParams.set(key, value);
    }
  });
  return url.toString();
}

function pruneExpiredTransactionCache(now = Date.now()) {
  for (const [key, entry] of transactionCache.entries()) {
    if (!entry?.savedAt || now - entry.savedAt > SERVER_CACHE_TTL_MS) {
      transactionCache.delete(key);
    }
  }
}

function getCachedTransactions(userKey) {
  pruneExpiredTransactionCache();
  const entry = transactionCache.get(userKey);
  if (!entry) {
    return null;
  }
  if (entry.parserVersion !== TRANSACTION_PARSER_VERSION) {
    transactionCache.delete(userKey);
    return null;
  }

  return entry;
}

function setCachedTransactions(userKey, payload) {
  pruneExpiredTransactionCache();
  transactionCache.delete(userKey);
  transactionCache.set(userKey, {
    ...payload,
    parserVersion: TRANSACTION_PARSER_VERSION,
    savedAt: Date.now(),
  });

  while (transactionCache.size > MAX_TRANSACTION_CACHE_ENTRIES) {
    const oldestKey = transactionCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    transactionCache.delete(oldestKey);
  }
}

function buildSharedTransactionCacheKey(userKey) {
  return `gmail-cache:${userKey}`;
}

async function setSharedJson(key, value, ttlSeconds) {
  if (!hasSharedRedisConfig()) {
    throw new Error("Shared Redis is not configured.");
  }

  const redisUrl = String(process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || "";

  const response = await fetch(redisUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${redisToken}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
    body: JSON.stringify([
      "SET",
      key,
      JSON.stringify(value),
      "EX",
      Math.max(1, Math.floor(ttlSeconds)),
    ]),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) {
    throw new Error(payload?.error || "Shared Redis request failed.");
  }
}

async function readTransactionCache(userKey) {
  if (hasSharedRedisConfig()) {
    try {
      const shared = await getSharedJson(buildSharedTransactionCacheKey(userKey));
      if (shared?.parserVersion !== TRANSACTION_PARSER_VERSION) {
        return getCachedTransactions(userKey);
      }
      return shared;
    } catch {
      return getCachedTransactions(userKey);
    }
  }

  return getCachedTransactions(userKey);
}

async function writeTransactionCache(userKey, payload) {
  if (hasSharedRedisConfig()) {
    try {
      await setSharedJson(
        buildSharedTransactionCacheKey(userKey),
        {
          ...payload,
          parserVersion: TRANSACTION_PARSER_VERSION,
          savedAt: Date.now(),
        },
        SERVER_CACHE_TTL_MS / 1000
      );
      return;
    } catch {
      setCachedTransactions(userKey, payload);
      return;
    }
  }

  setCachedTransactions(userKey, payload);
}

async function listMessageIds(accessToken) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const messages = [];
  let pageToken = null;

  do {
    const params = new URLSearchParams({
      q: QUERY,
      maxResults: String(Math.min(PAGE_SIZE, MAX_MESSAGES - messages.length)),
    });
    if (pageToken) {
      params.set("pageToken", pageToken);
    }

    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`,
      { headers, cache: "no-store" }
    );

    if (!res.ok) {
      const errorBody = await res.json().catch(() => ({}));
      const gmailMessage = errorBody?.error?.message || "Gmail list fetch failed";
      const gmailStatus = errorBody?.error?.status || "";
      const error = new Error(
        `Gmail list fetch failed: ${res.status}${gmailStatus ? ` ${gmailStatus}` : ""}${gmailMessage ? ` - ${gmailMessage}` : ""}`
      );
      error.status = res.status;
      throw error;
    }

    const data = await res.json();
    if (Array.isArray(data.messages)) {
      messages.push(...data.messages);
    }
    pageToken = data.nextPageToken || null;
  } while (pageToken && messages.length < MAX_MESSAGES);

  return messages;
}

async function fetchMessageDetail(accessToken, id, attempt = 0) {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    }
  );

  if (!res.ok) {
    if (attempt < 1 && res.status >= 500) {
      return fetchMessageDetail(accessToken, id, attempt + 1);
    }

    const error = new Error(`Gmail message fetch failed: ${res.status} (${id})`);
    error.status = res.status;
    throw error;
  }

  return res.json();
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const current = index;
      index += 1;

      try {
        results[current] = await mapper(items[current], current);
      } catch (error) {
        results[current] = { error };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );

  return results;
}

export async function registerGmailRoutes(app) {
  app.get("/auth/google/start", async (request, reply) => {
    try {
      const session = readSessionFromRequest(request);
      if (!session?.id) {
        return reply.redirect(buildFrontendRedirect({ authError: "login_required" }));
      }

      if (!hasGoogleOAuthConfig()) {
        return reply.redirect(
          buildFrontendRedirect({ authError: "google_oauth_not_configured" })
        );
      }

      const forceConsent = String(request.query?.consent || "") === "1";
      const state = createOAuthState();
      const verifier = createCodeVerifier();
      const authUrl = buildGoogleAuthUrl(request, {
        state,
        verifier,
        forceConsent,
      });

      applyOAuthFlowCookie(reply, {
        state,
        verifier,
        forceConsent,
        userId: session.id,
      });

      return reply.redirect(authUrl);
    } catch (error) {
      request.log.error({ error }, "Google OAuth start failed.");
      return reply.redirect(buildFrontendRedirect({ authError: "oauth_start_failed" }));
    }
  });

  app.get("/auth/google/callback", async (request, reply) => {
    const state = String(request.query?.state || "");
    const code = String(request.query?.code || "");
    const authError = String(request.query?.error || "");
    const oauthFlow = readOAuthFlowFromRequest(request);

    function finalizeRedirect(params = {}) {
      clearOAuthFlowCookie(reply);
      return reply.redirect(buildFrontendRedirect(params));
    }

    if (authError) {
      return finalizeRedirect({ authError });
    }

    if (!state || !code || !oauthFlow || oauthFlow.state !== state) {
      return finalizeRedirect({ authError: "oauth_state_invalid" });
    }

    const session = readSessionFromRequest(request);
    if (!session?.id || oauthFlow.userId !== session.id) {
      return finalizeRedirect({ authError: "login_required" });
    }

    if (!hasSupabaseAdminConfig()) {
      return finalizeRedirect({ authError: "supabase_not_configured" });
    }

    try {
      const tokenResponse = await exchangeGoogleCode(request, code, oauthFlow.verifier);
      const user = await getUserFromAccessToken(tokenResponse.access_token);

      if (!user?.sub) {
        return finalizeRedirect({ authError: "google_user_missing" });
      }

      const supabase = getSupabaseAdmin();
      const { user: appUser, error: appUserError } = await getFintrakUserById(
        supabase,
        session.id
      );

      if (appUserError || !appUser) {
        request.log.error(
          {
            error: appUserError,
            sessionUserId: session.id,
          },
          "Failed to read FinTrak account before Gmail connect."
        );
        return finalizeRedirect({ authError: "profile_read_failed" });
      }

      const storedEncryptedRefreshToken = appUser.gmailRefreshToken || "";
      const hasFreshRefreshToken = Boolean(tokenResponse.refresh_token);
      const nextEncryptedRefreshToken = hasFreshRefreshToken
        ? encryptSecretValue(tokenResponse.refresh_token)
        : storedEncryptedRefreshToken;

      if (!nextEncryptedRefreshToken || (oauthFlow.forceConsent && !hasFreshRefreshToken)) {
        if (!oauthFlow.forceConsent) {
          clearOAuthFlowCookie(reply);
          return reply.redirect(
            new URL("/auth/google/start?consent=1", request.url).toString()
          );
        }

        request.log.error(
          {
            sessionUserId: session.id,
          },
          "Google OAuth callback did not return a reusable refresh token."
        );
        return finalizeRedirect({ authError: "refresh_token_missing" });
      }

      const upsertResult = await updateFintrakUserGmailConnection(supabase, {
        userId: appUser.id,
        encryptedRefreshToken: nextEncryptedRefreshToken,
        gmailEmail: user.email || null,
        gmailSubject: user.sub,
      });

      if (upsertResult.error) {
        request.log.error(
          {
            error: upsertResult.error,
            sessionUserId: session.id,
          },
          "Failed to save Google refresh token."
        );
        return finalizeRedirect({ authError: "profile_write_failed" });
      }

      clearOAuthFlowCookie(reply);
      return reply.redirect(buildFrontendRedirect());
    } catch (error) {
      request.log.error(
        {
          error,
          sessionUserId: session?.id || null,
        },
        "Google OAuth callback failed."
      );
      return finalizeRedirect({ authError: "oauth_callback_failed" });
    }
  });

  app.get("/gmail-transactions", async (request, reply) => {
    try {
      const user = readSessionFromRequest(request);

      if (!user) {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      if (!hasSupabaseAdminConfig()) {
        return reply.code(500).send({
          error:
            "Server-side Gmail sync is not configured. Add Supabase and Google OAuth server credentials.",
        });
      }

      const supabase = getSupabaseAdmin();
      const accessToken = await getServerGmailAccessToken(supabase, user);

      const cached = await readTransactionCache(user.id);
      if (cached) {
        return reply.send({
          transactions: cached.transactions,
          userKey: user.id,
          cached: true,
          meta: cached.meta,
        });
      }

      const messages = await listMessageIds(accessToken);
      const details = await mapWithConcurrency(
        messages,
        DETAIL_CONCURRENCY,
        (message) => fetchMessageDetail(accessToken, message.id)
      );

      const successfulDetails = details
        .filter((entry) => entry && !entry.error)
        .map((entry) => entry);

      const transactions = successfulDetails
        .map(parseTransaction)
        .filter(Boolean)
        .sort((a, b) => {
          if (b.timestamp !== a.timestamp) {
            return b.timestamp - a.timestamp;
          }
          return a.id.localeCompare(b.id);
        });

      const meta = {
        matchedMessages: messages.length,
        fetchedMessages: successfulDetails.length,
        parsedTransactions: transactions.length,
        detailFailures: details.filter((entry) => entry?.error).length,
      };

      await writeTransactionCache(user.id, {
        transactions,
        meta,
      });

      return reply.send({
        transactions,
        userKey: user.id,
        cached: false,
        meta,
      });
    } catch (error) {
      const message = error?.message || "Failed to sync Gmail";
      const normalized = message.toLowerCase();
      const status =
        error?.status === 401
          ? 401
          : normalized.includes("quota exceeded") ||
              normalized.includes("queries per minute") ||
              normalized.includes("rate limit")
            ? 429
            : 500;

      if (status === 429) {
        request.log.warn({ error }, "Gmail sync was rate limited.");
      } else if (status >= 500) {
        request.log.error({ error }, "Gmail sync failed.");
      }

      if (status === 401 && readSessionFromRequest(request)?.id && hasSupabaseAdminConfig()) {
        const supabase = getSupabaseAdmin();
        await clearFintrakUserGmailConnection(supabase, readSessionFromRequest(request).id).catch(
          () => null
        );
      }

      return reply.code(status).send({ error: message });
    }
  });
}
