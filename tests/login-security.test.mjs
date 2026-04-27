import test from "node:test";
import assert from "node:assert/strict";
import {
  LOGIN_ATTEMPT_WINDOW_MS,
  MAX_LOGIN_FAILURES,
  buildLoginThrottleKey,
  clearTrackedLoginAttemptState,
  createLoginLockedMessage,
  isLoginLocked,
  readTrackedLoginAttemptState,
  resetTrackedLoginAttemptsForTests,
  trackFailedLoginAttempt,
} from "../src/lib/loginSecurity.js";

test("login attempts lock after repeated failures for one identifier and client", () => {
  resetTrackedLoginAttemptsForTests();
  const key = buildLoginThrottleKey("aarav_mehta", "203.0.113.5");
  const now = 2_000_000;
  let state = null;

  for (let index = 0; index < MAX_LOGIN_FAILURES; index += 1) {
    state = trackFailedLoginAttempt(key, now + index);
  }

  assert.equal(isLoginLocked(state, now + MAX_LOGIN_FAILURES), true);
  assert.equal(
    readTrackedLoginAttemptState(key, now + MAX_LOGIN_FAILURES)?.count,
    MAX_LOGIN_FAILURES
  );
  assert.match(createLoginLockedMessage(state), /Too many login attempts/);

  clearTrackedLoginAttemptState(key);
  assert.equal(readTrackedLoginAttemptState(key), null);
});

test("login attempt tracking expires after the rolling window", () => {
  resetTrackedLoginAttemptsForTests();
  const key = buildLoginThrottleKey("aarav_mehta", "203.0.113.5");
  const now = 3_000_000;

  trackFailedLoginAttempt(key, now);

  assert.equal(
    readTrackedLoginAttemptState(key, now + LOGIN_ATTEMPT_WINDOW_MS + 1),
    null
  );
});
