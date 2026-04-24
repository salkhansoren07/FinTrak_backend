import {
  deleteSharedKey,
  evalSharedScript,
  getSharedJson,
  hasSharedRedisConfig,
} from "./sharedRedis.js";

export const MAX_LOGIN_FAILURES = 5;
export const LOGIN_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
export const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
export const MAX_TRACKED_LOGIN_ATTEMPTS = 2000;

const LOGIN_ATTEMPT_STORE = globalThis.__fintrakApiLoginAttemptStore || new Map();

if (!globalThis.__fintrakApiLoginAttemptStore) {
  globalThis.__fintrakApiLoginAttemptStore = LOGIN_ATTEMPT_STORE;
}

function toSafeTimestamp(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function normalizeLoginAttemptState(state) {
  if (!state || typeof state !== "object") {
    return null;
  }

  const count = Number.isInteger(state.count) && state.count > 0 ? state.count : 0;
  const windowStartedAt = toSafeTimestamp(state.windowStartedAt);
  const lockedUntil = toSafeTimestamp(state.lockedUntil);

  if (!count || !windowStartedAt) {
    return null;
  }

  return {
    count,
    windowStartedAt,
    lockedUntil,
  };
}

export function getLoginLockRemainingMs(state, now = Date.now()) {
  const normalized = normalizeLoginAttemptState(state);
  if (!normalized?.lockedUntil) {
    return 0;
  }

  return Math.max(0, normalized.lockedUntil - now);
}

export function isLoginLocked(state, now = Date.now()) {
  return getLoginLockRemainingMs(state, now) > 0;
}

export function registerFailedLoginAttempt(state, now = Date.now()) {
  const normalized = normalizeLoginAttemptState(state);

  if (
    !normalized ||
    now - normalized.windowStartedAt >= LOGIN_ATTEMPT_WINDOW_MS
  ) {
    return {
      count: 1,
      windowStartedAt: now,
      lockedUntil: null,
    };
  }

  const count = normalized.count + 1;

  return {
    count,
    windowStartedAt: normalized.windowStartedAt,
    lockedUntil: count >= MAX_LOGIN_FAILURES ? now + LOGIN_LOCKOUT_MS : null,
  };
}

export function createLoginLockedMessage(state, now = Date.now()) {
  const remainingMs = getLoginLockRemainingMs(state, now);
  const retryAfterMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));

  return `Too many login attempts. Try again in about ${retryAfterMinutes} minute${retryAfterMinutes === 1 ? "" : "s"}.`;
}

function cleanupExpiredLoginAttempts(now = Date.now()) {
  for (const [key, value] of LOGIN_ATTEMPT_STORE.entries()) {
    const normalized = normalizeLoginAttemptState(value);

    if (
      !normalized ||
      Math.max(
        normalized.windowStartedAt + LOGIN_ATTEMPT_WINDOW_MS,
        normalized.lockedUntil || 0
      ) <= now
    ) {
      LOGIN_ATTEMPT_STORE.delete(key);
    }
  }
}

function enforceLoginAttemptLimit() {
  while (LOGIN_ATTEMPT_STORE.size > MAX_TRACKED_LOGIN_ATTEMPTS) {
    const oldestKey = LOGIN_ATTEMPT_STORE.keys().next().value;
    if (!oldestKey) {
      break;
    }
    LOGIN_ATTEMPT_STORE.delete(oldestKey);
  }
}

export function buildLoginThrottleKey(identifier, clientAddress = "") {
  const normalizedIdentifier = String(identifier || "").trim().toLowerCase();
  const normalizedAddress =
    String(clientAddress || "").trim().toLowerCase() || "unknown";
  return `${normalizedIdentifier}::${normalizedAddress}`;
}

export function readTrackedLoginAttemptState(key, now = Date.now()) {
  cleanupExpiredLoginAttempts(now);
  return normalizeLoginAttemptState(LOGIN_ATTEMPT_STORE.get(key));
}

export function trackFailedLoginAttempt(key, now = Date.now()) {
  cleanupExpiredLoginAttempts(now);

  const nextState = registerFailedLoginAttempt(
    LOGIN_ATTEMPT_STORE.get(key),
    now
  );

  LOGIN_ATTEMPT_STORE.set(key, nextState);
  enforceLoginAttemptLimit();
  return nextState;
}

export function clearTrackedLoginAttemptState(key) {
  LOGIN_ATTEMPT_STORE.delete(key);
}

export function resetTrackedLoginAttemptsForTests() {
  LOGIN_ATTEMPT_STORE.clear();
}

function buildLoginAttemptRedisKey(key) {
  return `login-throttle:${key}`;
}

const TRACK_FAILED_LOGIN_ATTEMPT_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local lockoutMs = tonumber(ARGV[3])
local maxFailures = tonumber(ARGV[4])
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

if count >= maxFailures then
  nextState.lockedUntil = now + lockoutMs
end

local expiry = math.max(windowStartedAt + windowMs, nextState.lockedUntil or 0)
local ttlSeconds = math.floor((expiry - now + 999) / 1000)

if ttlSeconds < 1 then
  ttlSeconds = 1
end

redis.call("SET", KEYS[1], cjson.encode(nextState), "EX", ttlSeconds)
return cjson.encode(nextState)
`;

export async function readDistributedLoginAttemptState(key, now = Date.now()) {
  if (!hasSharedRedisConfig()) {
    return readTrackedLoginAttemptState(key, now);
  }

  try {
    return normalizeLoginAttemptState(
      await getSharedJson(buildLoginAttemptRedisKey(key))
    );
  } catch {
    return readTrackedLoginAttemptState(key, now);
  }
}

export async function trackDistributedFailedLoginAttempt(key, now = Date.now()) {
  if (!hasSharedRedisConfig()) {
    return trackFailedLoginAttempt(key, now);
  }

  try {
    const result = await evalSharedScript(
      TRACK_FAILED_LOGIN_ATTEMPT_SCRIPT,
      [buildLoginAttemptRedisKey(key)],
      [now, LOGIN_ATTEMPT_WINDOW_MS, LOGIN_LOCKOUT_MS, MAX_LOGIN_FAILURES]
    );

    if (!result) {
      return null;
    }

    try {
      return normalizeLoginAttemptState(JSON.parse(result));
    } catch {
      return null;
    }
  } catch {
    return trackFailedLoginAttempt(key, now);
  }
}

export async function clearDistributedLoginAttemptState(key) {
  if (!hasSharedRedisConfig()) {
    clearTrackedLoginAttemptState(key);
    return;
  }

  try {
    await deleteSharedKey(buildLoginAttemptRedisKey(key));
  } catch {
    clearTrackedLoginAttemptState(key);
  }
}
