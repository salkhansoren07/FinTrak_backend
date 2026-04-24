import crypto from "node:crypto";
import { deriveSecret } from "./serverSecrets.js";

const SESSION_COOKIE_NAME = "fintrak_session";
const OAUTH_COOKIE_NAME = "fintrak_oauth";
const PASSCODE_ATTEMPTS_COOKIE_NAME = "fintrak_passcode_attempts";
const SESSION_DURATION_SECONDS = 60 * 60 * 24 * 30;
const OAUTH_DURATION_SECONDS = 60 * 10;

function isProduction() {
  return process.env.NODE_ENV === "production";
}

function getCookieDomain() {
  const domain = String(process.env.COOKIE_DOMAIN || "").trim();
  return domain || undefined;
}

function sign(value) {
  return crypto
    .createHmac("sha256", deriveSecret("session-signing"))
    .update(value)
    .digest("base64url");
}

function encodeSignedPayload(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

function decodeSignedPayload(value) {
  if (!value) {
    return null;
  }

  const [encoded, signature] = String(value).split(".");
  if (!encoded || !signature) {
    return null;
  }

  const expected = sign(encoded);
  const matches =
    signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));

  if (!matches) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!parsed?.exp || Date.now() > parsed.exp) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function setCookie(reply, name, value, maxAge) {
  reply.setCookie(name, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
    maxAge,
    domain: getCookieDomain(),
  });
}

function readSignedCookie(request, name) {
  return decodeSignedPayload(request.cookies?.[name] || null);
}

export function readSessionFromRequest(request) {
  return readSignedCookie(request, SESSION_COOKIE_NAME);
}

export function applySessionCookie(reply, user) {
  const payload = {
    id: user.id,
    username: user.username || null,
    email: user.email || null,
    exp: Date.now() + SESSION_DURATION_SECONDS * 1000,
  };

  setCookie(
    reply,
    SESSION_COOKIE_NAME,
    encodeSignedPayload(payload),
    SESSION_DURATION_SECONDS
  );
}

export function clearSessionCookie(reply) {
  setCookie(reply, SESSION_COOKIE_NAME, "", 0);
}

export function readOAuthFlowFromRequest(request) {
  return readSignedCookie(request, OAUTH_COOKIE_NAME);
}

export function applyOAuthFlowCookie(reply, payload) {
  setCookie(
    reply,
    OAUTH_COOKIE_NAME,
    encodeSignedPayload({
      ...payload,
      exp: Date.now() + OAUTH_DURATION_SECONDS * 1000,
    }),
    OAUTH_DURATION_SECONDS
  );
}

export function clearOAuthFlowCookie(reply) {
  setCookie(reply, OAUTH_COOKIE_NAME, "", 0);
}

export function readPasscodeAttemptStateFromRequest(request) {
  return readSignedCookie(request, PASSCODE_ATTEMPTS_COOKIE_NAME);
}

export function applyPasscodeAttemptStateCookie(reply, payload) {
  if (!payload?.exp) {
    clearPasscodeAttemptStateCookie(reply);
    return;
  }

  const maxAge = Math.max(1, Math.ceil((payload.exp - Date.now()) / 1000));
  setCookie(
    reply,
    PASSCODE_ATTEMPTS_COOKIE_NAME,
    encodeSignedPayload(payload),
    maxAge
  );
}

export function clearPasscodeAttemptStateCookie(reply) {
  setCookie(reply, PASSCODE_ATTEMPTS_COOKIE_NAME, "", 0);
}
