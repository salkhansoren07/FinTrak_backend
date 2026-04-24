import {
  USERNAME_REQUIREMENTS_MESSAGE,
  isValidEmail,
  isValidUsername,
} from "../lib/authValidation.js";
import {
  createFintrakUser,
  getFintrakUserById,
  getFintrakUserByIdentifier,
  isEmailTaken,
  isUsernameTaken,
  normalizeLoginIdentifier,
} from "../lib/fintrakUsers.js";
import {
  buildLoginThrottleKey,
  clearDistributedLoginAttemptState,
  createLoginLockedMessage,
  isLoginLocked,
  readDistributedLoginAttemptState,
  resetTrackedLoginAttemptsForTests,
  trackDistributedFailedLoginAttempt,
} from "../lib/loginSecurity.js";
import { hashPassword, verifyPassword } from "../lib/passwords.js";
import {
  getSupabaseAdmin,
  hasSupabaseAdminConfig,
} from "../lib/supabaseAdmin.js";
import {
  applySessionCookie,
  clearSessionCookie,
  readSessionFromRequest,
} from "../lib/serverAuth.js";

const INVALID_CREDENTIALS_MESSAGE = "Invalid username/email or password.";

function normalizeInput(value) {
  return String(value || "").trim();
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

function buildAuthenticatedPayload(user) {
  return {
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      isAdmin: Boolean(user.isAdmin),
    },
    gmailConnected: Boolean(user.gmailRefreshToken ?? user.gmailConnected),
    hasPasscode: Boolean(user.passcodeHash ?? user.hasPasscode),
  };
}

function buildAnonymousSessionPayload() {
  return {
    authenticated: false,
    user: null,
    gmailConnected: false,
    hasPasscode: false,
  };
}

export async function registerAuthRoutes(app) {
  app.post("/auth/login", async (request, reply) => {
    try {
      if (!hasSupabaseAdminConfig()) {
        return reply.code(500).send({
          error: "Supabase is not configured for FinTrak accounts.",
        });
      }

      const body = request.body || {};
      const identifier = normalizeLoginIdentifier(body?.identifier);
      const password = String(body?.password || "");
      const throttleKey = buildLoginThrottleKey(
        identifier,
        getClientAddress(request)
      );

      if (!identifier || !password) {
        return reply.code(400).send({
          error: "Username/email and password are required.",
        });
      }

      const attemptState = await readDistributedLoginAttemptState(throttleKey);
      if (isLoginLocked(attemptState)) {
        return reply.code(429).send({
          error: createLoginLockedMessage(attemptState),
        });
      }

      const supabase = getSupabaseAdmin();
      const { user, error } = await getFintrakUserByIdentifier(
        supabase,
        identifier
      );

      if (error) {
        request.log.error(
          {
            error,
            identifier,
          },
          "Failed to read FinTrak account during login."
        );
        return reply.code(500).send({
          error: "Could not sign in right now.",
        });
      }

      if (!user) {
        const nextAttemptState = await trackDistributedFailedLoginAttempt(
          throttleKey
        );
        return reply.code(isLoginLocked(nextAttemptState) ? 429 : 401).send({
          error: isLoginLocked(nextAttemptState)
            ? createLoginLockedMessage(nextAttemptState)
            : INVALID_CREDENTIALS_MESSAGE,
        });
      }

      const passwordMatches = await verifyPassword(password, user.passwordHash);
      if (!passwordMatches) {
        const nextAttemptState = await trackDistributedFailedLoginAttempt(
          throttleKey
        );
        return reply.code(isLoginLocked(nextAttemptState) ? 429 : 401).send({
          error: isLoginLocked(nextAttemptState)
            ? createLoginLockedMessage(nextAttemptState)
            : INVALID_CREDENTIALS_MESSAGE,
        });
      }

      await clearDistributedLoginAttemptState(throttleKey);
      applySessionCookie(reply, user);
      return reply.send(buildAuthenticatedPayload(user));
    } catch (error) {
      request.log.error({ error }, "FinTrak login failed.");
      return reply.code(500).send({
        error: "Unexpected login error.",
      });
    }
  });

  app.post("/auth/signup", async (request, reply) => {
    try {
      if (!hasSupabaseAdminConfig()) {
        return reply.code(500).send({
          error: "Supabase is not configured for FinTrak accounts.",
        });
      }

      const body = request.body || {};
      const username = normalizeInput(body?.username);
      const email = normalizeInput(body?.email).toLowerCase();
      const password = String(body?.password || "");

      if (!isValidUsername(username)) {
        return reply.code(400).send({
          error: USERNAME_REQUIREMENTS_MESSAGE,
        });
      }

      if (!isValidEmail(email)) {
        return reply.code(400).send({
          error: "Please enter a valid email address.",
        });
      }

      if (password.length < 8) {
        return reply.code(400).send({
          error: "Password must be at least 8 characters long.",
        });
      }

      const supabase = getSupabaseAdmin();
      const [usernameCheck, emailCheck] = await Promise.all([
        isUsernameTaken(supabase, username),
        isEmailTaken(supabase, email),
      ]);

      if (usernameCheck.error || emailCheck.error) {
        request.log.error(
          {
            error: usernameCheck.error || emailCheck.error,
            username,
            email,
          },
          "Failed to validate FinTrak signup uniqueness."
        );
        return reply.code(500).send({
          error: "Could not validate account details. Please try again.",
        });
      }

      if (usernameCheck.taken) {
        return reply.code(409).send({
          error: "That username is already taken.",
        });
      }

      if (emailCheck.taken) {
        return reply.code(409).send({
          error: "That email is already in use.",
        });
      }

      const passwordHash = await hashPassword(password);
      const { user, error } = await createFintrakUser(supabase, {
        username,
        email,
        passwordHash,
      });

      if (error || !user) {
        request.log.error(
          {
            error,
            username,
            email,
          },
          "Failed to create FinTrak account."
        );
        return reply.code(500).send({
          error: "Could not create your FinTrak account.",
        });
      }

      applySessionCookie(reply, user);
      return reply.send(buildAuthenticatedPayload(user));
    } catch (error) {
      request.log.error({ error }, "FinTrak signup failed.");
      return reply.code(500).send({
        error: "Unexpected signup error.",
      });
    }
  });

  app.get("/auth/session", async (request, reply) => {
    const session = readSessionFromRequest(request);

    if (!session?.id) {
      if (session) {
        clearSessionCookie(reply);
      }
      return reply.send(buildAnonymousSessionPayload());
    }

    if (!hasSupabaseAdminConfig()) {
      return reply.send({
        authenticated: true,
        user: {
          id: session.id,
          username: session.username,
          email: session.email,
          isAdmin: false,
        },
        gmailConnected: false,
        hasPasscode: false,
      });
    }

    const { user, error } = await getFintrakUserById(getSupabaseAdmin(), session.id);
    if (error || !user) {
      if (error) {
        request.log.error(
          {
            error,
            sessionUserId: session.id,
          },
          "Failed to load FinTrak session user."
        );
      }

      clearSessionCookie(reply);
      return reply.send(buildAnonymousSessionPayload());
    }

    return reply.send({
      authenticated: true,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        isAdmin: Boolean(user.isAdmin),
      },
      gmailConnected: Boolean(user.gmailRefreshToken),
      hasPasscode: Boolean(user.passcodeHash),
    });
  });

  app.post("/auth/logout", async (_request, reply) => {
    clearSessionCookie(reply);
    return reply.send({ ok: true });
  });
}

export function resetAuthRouteStateForTests() {
  resetTrackedLoginAttemptsForTests();
}
