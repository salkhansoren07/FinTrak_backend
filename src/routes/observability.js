import { reportServerEvent } from "../lib/observability.js";

const OBSERVABILITY_WINDOW_MS = 60 * 1000;
const MAX_OBSERVABILITY_REPORTS_PER_WINDOW = 20;
const OBSERVABILITY_REQUEST_STORE =
  globalThis.__fintrakObservabilityRequestStore || new Map();

if (!globalThis.__fintrakObservabilityRequestStore) {
  globalThis.__fintrakObservabilityRequestStore = OBSERVABILITY_REQUEST_STORE;
}

function sanitizeClientEvent(body = {}) {
  return {
    level: ["info", "warn", "error"].includes(body?.level) ? body.level : "error",
    event: body?.event || "client.event",
    message: body?.message || "Client event reported.",
    context:
      body?.context && typeof body.context === "object" ? body.context : {},
    error:
      body?.error && typeof body.error === "object" ? body.error : body?.error || null,
  };
}

function getClientAddress(request) {
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

function cleanupExpiredObservabilityEntries(now = Date.now()) {
  for (const [key, entry] of OBSERVABILITY_REQUEST_STORE.entries()) {
    if (
      !entry?.windowStartedAt ||
      now - entry.windowStartedAt >= OBSERVABILITY_WINDOW_MS
    ) {
      OBSERVABILITY_REQUEST_STORE.delete(key);
    }
  }
}

export function resetObservabilityRequestStateForTests() {
  OBSERVABILITY_REQUEST_STORE.clear();
}

function isObservabilityRateLimited(request, now = Date.now()) {
  cleanupExpiredObservabilityEntries(now);

  const key = getClientAddress(request);
  const current =
    OBSERVABILITY_REQUEST_STORE.get(key) || {
      count: 0,
      windowStartedAt: now,
    };

  const nextEntry =
    now - current.windowStartedAt >= OBSERVABILITY_WINDOW_MS
      ? { count: 1, windowStartedAt: now }
      : {
          count: current.count + 1,
          windowStartedAt: current.windowStartedAt,
        };

  OBSERVABILITY_REQUEST_STORE.set(key, nextEntry);
  return nextEntry.count > MAX_OBSERVABILITY_REPORTS_PER_WINDOW;
}

function readTrustedOrigins() {
  const configured = String(process.env.CORS_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const frontendBaseUrl = String(
    process.env.FRONTEND_BASE_URL || process.env.APP_BASE_URL || ""
  ).trim();

  const trustedOrigins = new Set(configured);

  if (frontendBaseUrl) {
    trustedOrigins.add(frontendBaseUrl.replace(/\/+$/, ""));
  }

  if (trustedOrigins.size === 0) {
    trustedOrigins.add("http://localhost:3000");
    trustedOrigins.add("http://127.0.0.1:3000");
    trustedOrigins.add("https://app.fintrak.online");
    trustedOrigins.add("https://www.fintrak.online");
  }

  return trustedOrigins;
}

function isTrustedClientReportRequest(request) {
  const origin = String(request.headers.origin || "").trim();
  const fetchSite = String(request.headers["sec-fetch-site"] || "")
    .trim()
    .toLowerCase();

  if (origin) {
    return readTrustedOrigins().has(origin);
  }

  return ["same-origin", "same-site", "none"].includes(fetchSite);
}

export async function registerObservabilityRoutes(app) {
  app.post("/observability", async (request, reply) => {
    try {
      if (!isTrustedClientReportRequest(request)) {
        return reply.code(403).send({ ok: false });
      }

      if (isObservabilityRateLimited(request)) {
        return reply.code(429).send({ ok: false });
      }

      const payload = sanitizeClientEvent(request.body || {});

      await reportServerEvent({
        level: payload.level,
        event: payload.event,
        message: payload.message,
        context: {
          source: "client",
          ...payload.context,
        },
        error: payload.error,
        request,
      });

      return reply.send({ ok: true });
    } catch (error) {
      await reportServerEvent({
        level: "error",
        event: "observability.client_report_failed",
        message: "Failed to ingest client observability event.",
        error,
        request,
      });

      return reply.code(500).send({ ok: false });
    }
  });
}
