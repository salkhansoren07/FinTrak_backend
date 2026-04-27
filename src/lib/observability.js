import crypto from "node:crypto";

const SERVICE_NAME = "fintrak-api";
const OBSERVABILITY_WEBHOOK_URL =
  String(process.env.OBSERVABILITY_WEBHOOK_URL || "").trim();
const OBSERVABILITY_LOG_LEVEL =
  String(process.env.OBSERVABILITY_LOG_LEVEL || "info").trim().toLowerCase();

const LEVEL_PRIORITY = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function normalizeLevel(level) {
  return LEVEL_PRIORITY[level] ? level : "error";
}

function shouldEmit(level) {
  const normalizedLevel = normalizeLevel(level);
  const configuredLevel = LEVEL_PRIORITY[OBSERVABILITY_LOG_LEVEL]
    ? OBSERVABILITY_LOG_LEVEL
    : "info";

  return LEVEL_PRIORITY[normalizedLevel] >= LEVEL_PRIORITY[configuredLevel];
}

function sanitizeString(value, maxLength = 500) {
  const normalized = String(value || "").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized;
}

function sanitizeContext(value, depth = 0) {
  if (depth > 3) {
    return "[truncated]";
  }

  if (value == null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 25).map((entry) => sanitizeContext(entry, depth + 1));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 40)
        .map(([key, entry]) => [key, sanitizeContext(entry, depth + 1)])
    );
  }

  if (typeof value === "string") {
    return sanitizeString(value, 300);
  }

  return value;
}

function serializeError(error) {
  if (!error) {
    return null;
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: sanitizeString(error.message, 500),
      stack:
        process.env.NODE_ENV === "development"
          ? sanitizeString(error.stack || "", 2000)
          : undefined,
      status: typeof error.status === "number" ? error.status : undefined,
    };
  }

  return {
    message: sanitizeString(error, 500),
  };
}

function buildRequestContext(request) {
  if (!request?.url) {
    return null;
  }

  return {
    method: request.method || "GET",
    path: request.url,
    requestId: request.id || crypto.randomUUID(),
  };
}

function writeStructuredLog(payload) {
  const serialized = JSON.stringify(payload);

  switch (payload.level) {
    case "warn":
      console.warn(serialized);
      break;
    case "info":
      console.info(serialized);
      break;
    default:
      console.error(serialized);
      break;
  }
}

async function deliverWebhook(payload) {
  if (!OBSERVABILITY_WEBHOOK_URL || !["warn", "error"].includes(payload.level)) {
    return;
  }

  try {
    await fetch(OBSERVABILITY_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
    });
  } catch (error) {
    writeStructuredLog({
      timestamp: new Date().toISOString(),
      level: "warn",
      event: "observability.webhook_delivery_failed",
      message: "Failed to deliver observability event to webhook.",
      service: SERVICE_NAME,
      environment: process.env.NODE_ENV || "development",
      error: serializeError(error),
      context: {
        originalEvent: payload.event,
        originalEventId: payload.eventId,
      },
    });
  }
}

export async function reportServerEvent({
  level = "error",
  event,
  message,
  error = null,
  context = {},
  request = null,
} = {}) {
  const normalizedLevel = normalizeLevel(level);
  if (!shouldEmit(normalizedLevel)) {
    return null;
  }

  const payload = {
    timestamp: new Date().toISOString(),
    eventId: crypto.randomUUID(),
    level: normalizedLevel,
    event: sanitizeString(event || "application.event", 120),
    message: sanitizeString(message || "Application event reported.", 500),
    service: SERVICE_NAME,
    environment: process.env.NODE_ENV || "development",
    request: buildRequestContext(request),
    context: sanitizeContext(context),
    error: serializeError(error),
  };

  writeStructuredLog(payload);
  await deliverWebhook(payload);
  return payload.eventId;
}

export function reportServerError(options) {
  return reportServerEvent({ ...options, level: "error" });
}

export function reportServerWarning(options) {
  return reportServerEvent({ ...options, level: "warn" });
}
