export const MAX_PASSCODE_FAILURES = 5;
export const PASSCODE_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
export const PASSCODE_LOCKOUT_MS = 15 * 60 * 1000;

function toSafeTimestamp(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function normalizePasscodeAttemptState(state) {
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

export function getPasscodeLockRemainingMs(state, now = Date.now()) {
  const normalized = normalizePasscodeAttemptState(state);
  if (!normalized?.lockedUntil) {
    return 0;
  }

  return Math.max(0, normalized.lockedUntil - now);
}

export function isPasscodeLocked(state, now = Date.now()) {
  return getPasscodeLockRemainingMs(state, now) > 0;
}

export function getPasscodeRetryAfterSeconds(state, now = Date.now()) {
  const remainingMs = getPasscodeLockRemainingMs(state, now);
  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
}

export function registerFailedPasscodeAttempt(state, now = Date.now()) {
  const normalized = normalizePasscodeAttemptState(state);

  if (
    !normalized ||
    now - normalized.windowStartedAt >= PASSCODE_ATTEMPT_WINDOW_MS
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
    lockedUntil:
      count >= MAX_PASSCODE_FAILURES ? now + PASSCODE_LOCKOUT_MS : null,
  };
}

export function buildPasscodeAttemptCookiePayload(state, now = Date.now()) {
  const normalized = normalizePasscodeAttemptState(state);
  if (!normalized) {
    return null;
  }

  const expiry = Math.max(
    normalized.windowStartedAt + PASSCODE_ATTEMPT_WINDOW_MS,
    normalized.lockedUntil || 0
  );

  if (expiry <= now) {
    return null;
  }

  return {
    ...normalized,
    exp: expiry,
  };
}

export function createPasscodeLockedMessage(state, now = Date.now()) {
  const retryAfterSeconds = getPasscodeRetryAfterSeconds(state, now);
  const retryAfterMinutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many incorrect passcode attempts. Try again in about ${retryAfterMinutes} minute${retryAfterMinutes === 1 ? "" : "s"}.`;
}
