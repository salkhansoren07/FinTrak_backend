const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

function normalizeRedisUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

export function hasSharedRedisConfig() {
  return Boolean(REDIS_URL && REDIS_TOKEN);
}

async function runRedisRequest(pathname = "", body) {
  if (!hasSharedRedisConfig()) {
    throw new Error("Shared Redis is not configured.");
  }

  const response = await fetch(`${normalizeRedisUrl(REDIS_URL)}${pathname}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) {
    throw new Error(payload?.error || "Shared Redis request failed.");
  }

  return payload?.result;
}

export async function getSharedJson(key) {
  const raw = await runRedisRequest("", ["GET", key]);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function deleteSharedKey(key) {
  return runRedisRequest("", ["DEL", key]);
}

export async function evalSharedScript(script, keys = [], args = []) {
  const keyArgs = Array.isArray(keys) ? keys : [];
  const valueArgs = Array.isArray(args) ? args : [];

  return runRedisRequest("", [
    "EVAL",
    script,
    String(keyArgs.length),
    ...keyArgs,
    ...valueArgs.map((value) => String(value)),
  ]);
}
