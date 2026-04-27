import crypto from "node:crypto";
import { getFrontendBaseUrl } from "./googleOAuth.js";
import { deriveSecret } from "./serverSecrets.js";
import { evalSharedScript, hasSharedRedisConfig } from "./sharedRedis.js";

export const PASSWORD_RESET_TOKEN_TTL_MS = 20 * 60 * 1000;
export const PASSWORD_RESET_REQUEST_WINDOW_MS = 15 * 60 * 1000;
export const MAX_PASSWORD_RESET_REQUESTS = 5;
const PASSWORD_RESET_TOKENS_TABLE = "password_reset_tokens";
const PASSWORD_RESET_REQUEST_STORE =
  globalThis.__fintrakPasswordResetRequestStore || new Map();

if (!globalThis.__fintrakPasswordResetRequestStore) {
  globalThis.__fintrakPasswordResetRequestStore = PASSWORD_RESET_REQUEST_STORE;
}

function normalizeString(value) {
  return String(value || "").trim();
}

function getTokenHash(token) {
  return crypto
    .createHmac("sha256", deriveSecret("password-reset-token"))
    .update(normalizeString(token))
    .digest("base64url");
}

function isMissingPasswordResetTable(error) {
  const message = normalizeString(error?.message).toLowerCase();

  return (
    (error?.code === "42P01" || error?.code === "PGRST205") &&
    message.includes(PASSWORD_RESET_TOKENS_TABLE)
  );
}

export function createPasswordResetToken() {
  const token = crypto.randomBytes(32).toString("base64url");

  return {
    token,
    tokenHash: getTokenHash(token),
    expiresAt: new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS).toISOString(),
  };
}

export function getPasswordResetClientAddress(request) {
  const forwardedFor = request.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0]?.trim() || "unknown";
  }

  const realIp = request.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim()) {
    return realIp.trim();
  }

  return request.ip || "unknown";
}

function buildPasswordResetThrottleKey(identifier, clientAddress) {
  return `password-reset:${normalizeString(identifier).toLowerCase()}::${normalizeString(
    clientAddress
  ).toLowerCase()}`;
}

function cleanupExpiredPasswordResetRequests(now = Date.now()) {
  for (const [key, entry] of PASSWORD_RESET_REQUEST_STORE.entries()) {
    if (
      !entry?.windowStartedAt ||
      now - entry.windowStartedAt >= PASSWORD_RESET_REQUEST_WINDOW_MS
    ) {
      PASSWORD_RESET_REQUEST_STORE.delete(key);
    }
  }
}

export function resetPasswordResetRequestStateForTests() {
  PASSWORD_RESET_REQUEST_STORE.clear();
}

function trackPasswordResetRequestLocally(identifier, clientAddress, now = Date.now()) {
  cleanupExpiredPasswordResetRequests(now);

  const key = buildPasswordResetThrottleKey(identifier, clientAddress);
  const current = PASSWORD_RESET_REQUEST_STORE.get(key);
  const nextState =
    !current || now - current.windowStartedAt >= PASSWORD_RESET_REQUEST_WINDOW_MS
      ? {
          count: 1,
          windowStartedAt: now,
        }
      : {
          count: current.count + 1,
          windowStartedAt: current.windowStartedAt,
        };

  PASSWORD_RESET_REQUEST_STORE.set(key, nextState);
  return nextState.count <= MAX_PASSWORD_RESET_REQUESTS;
}

const TRACK_PASSWORD_RESET_REQUEST_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local maxRequests = tonumber(ARGV[3])
local state = nil

if raw then
  state = cjson.decode(raw)
end

local count = 1
local windowStartedAt = now

if state and state.count and state.windowStartedAt and (now - tonumber(state.windowStartedAt) < windowMs) then
  count = tonumber(state.count) + 1
  windowStartedAt = tonumber(state.windowStartedAt)
end

local nextState = {
  count = count,
  windowStartedAt = windowStartedAt,
}

local ttlSeconds = math.floor((windowStartedAt + windowMs - now + 999) / 1000)
if ttlSeconds < 1 then
  ttlSeconds = 1
end

redis.call("SET", KEYS[1], cjson.encode(nextState), "EX", ttlSeconds)
return cjson.encode({
  allowed = count <= maxRequests,
  count = count,
  windowStartedAt = windowStartedAt,
})
`;

export async function canRequestPasswordReset(identifier, clientAddress) {
  const normalizedIdentifier = normalizeString(identifier).toLowerCase();
  const normalizedAddress = normalizeString(clientAddress).toLowerCase() || "unknown";

  if (!hasSharedRedisConfig()) {
    return trackPasswordResetRequestLocally(
      normalizedIdentifier,
      normalizedAddress
    );
  }

  try {
    const result = await evalSharedScript(
      TRACK_PASSWORD_RESET_REQUEST_SCRIPT,
      [buildPasswordResetThrottleKey(normalizedIdentifier, normalizedAddress)],
      [Date.now(), PASSWORD_RESET_REQUEST_WINDOW_MS, MAX_PASSWORD_RESET_REQUESTS]
    );

    const parsed = JSON.parse(result);
    return Boolean(parsed?.allowed);
  } catch {
    return trackPasswordResetRequestLocally(
      normalizedIdentifier,
      normalizedAddress
    );
  }
}

export async function deletePasswordResetTokensForUser(supabase, userId) {
  const { error } = await supabase
    .from(PASSWORD_RESET_TOKENS_TABLE)
    .delete()
    .eq("user_id", normalizeString(userId));

  return {
    error: isMissingPasswordResetTable(error) ? null : error,
    missingTable: isMissingPasswordResetTable(error),
  };
}

export async function createPasswordResetRecord(
  supabase,
  { userId, email, tokenHash, expiresAt, requestedIp }
) {
  const { data, error } = await supabase
    .from(PASSWORD_RESET_TOKENS_TABLE)
    .insert({
      user_id: normalizeString(userId),
      email: normalizeString(email).toLowerCase() || null,
      token_hash: tokenHash,
      expires_at: expiresAt,
      requested_ip: normalizeString(requestedIp) || null,
      created_at: new Date().toISOString(),
      used_at: null,
    })
    .select("id, user_id, email, token_hash, expires_at, used_at, created_at")
    .single();

  return {
    record: data || null,
    error: isMissingPasswordResetTable(error) ? null : error,
    missingTable: isMissingPasswordResetTable(error),
  };
}

export async function readPasswordResetRecordByToken(supabase, token) {
  const { data, error } = await supabase
    .from(PASSWORD_RESET_TOKENS_TABLE)
    .select("id, user_id, email, token_hash, expires_at, used_at, created_at")
    .eq("token_hash", getTokenHash(token))
    .maybeSingle();

  return {
    record: data || null,
    error: isMissingPasswordResetTable(error) ? null : error,
    missingTable: isMissingPasswordResetTable(error),
  };
}

export async function markPasswordResetRecordUsed(supabase, recordId) {
  const { data, error } = await supabase
    .from(PASSWORD_RESET_TOKENS_TABLE)
    .update({
      used_at: new Date().toISOString(),
    })
    .eq("id", recordId)
    .select("id, used_at")
    .single();

  return {
    record: data || null,
    error: isMissingPasswordResetTable(error) ? null : error,
    missingTable: isMissingPasswordResetTable(error),
  };
}

export function isPasswordResetRecordUsable(record, now = Date.now()) {
  if (!record?.id || !record?.user_id || !record?.token_hash || !record?.expires_at) {
    return false;
  }

  if (record.used_at) {
    return false;
  }

  return new Date(record.expires_at).getTime() > now;
}

export function buildPasswordResetUrl(token) {
  const url = new URL("/reset-password", getFrontendBaseUrl());
  url.searchParams.set("token", token);
  return url.toString();
}
