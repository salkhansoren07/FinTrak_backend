import {
  buildPasscodeAttemptCookiePayload,
  createPasscodeLockedMessage,
  isPasscodeLocked,
  registerFailedPasscodeAttempt,
} from "../lib/passcodeSecurity.js";
import { verifyPassword, hashPassword } from "../lib/passwords.js";
import {
  applyPasscodeAttemptStateCookie,
  clearPasscodeAttemptStateCookie,
  readPasscodeAttemptStateFromRequest,
  readSessionFromRequest,
} from "../lib/serverAuth.js";
import {
  clearFintrakUserPasscode,
  getFintrakUserById,
  updateFintrakUserPasscode,
} from "../lib/fintrakUsers.js";
import {
  getSupabaseAdmin,
  hasSupabaseAdminConfig,
} from "../lib/supabaseAdmin.js";

function getSessionUser(request) {
  const session = readSessionFromRequest(request);
  return session?.id ? session : null;
}

function isValidPasscode(passcode) {
  return /^\d{6}$/.test(passcode);
}

export async function registerPasscodeRoutes(app) {
  app.post("/passcode", async (request, reply) => {
    try {
      const session = getSessionUser(request);
      if (!session) {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      if (!hasSupabaseAdminConfig()) {
        return reply.code(500).send({
          error: "Supabase is not configured for passcodes.",
        });
      }

      const passcode = String(request.body?.passcode || "");

      if (!isValidPasscode(passcode)) {
        return reply.code(400).send({
          error: "Passcode must be exactly 6 digits.",
        });
      }

      const supabase = getSupabaseAdmin();
      const passcodeHash = await hashPassword(passcode);
      const { error } = await updateFintrakUserPasscode(
        supabase,
        session.id,
        passcodeHash
      );

      if (error) {
        request.log.error(
          {
            error,
            sessionUserId: session.id,
          },
          "Failed to save FinTrak passcode."
        );
        return reply.code(500).send({
          error: "Could not save your passcode.",
        });
      }

      clearPasscodeAttemptStateCookie(reply);
      return reply.send({ ok: true, hasPasscode: true });
    } catch (error) {
      request.log.error({ error }, "Unexpected passcode save error.");
      return reply.code(500).send({
        error: "Unexpected passcode save error.",
      });
    }
  });

  app.delete("/passcode", async (request, reply) => {
    try {
      const session = getSessionUser(request);
      if (!session) {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      if (!hasSupabaseAdminConfig()) {
        return reply.code(500).send({
          error: "Supabase is not configured for passcodes.",
        });
      }

      const password = String(request.body?.password || "");

      if (!password) {
        return reply.code(400).send({
          error: "Current account password is required to reset your passcode.",
        });
      }

      const supabase = getSupabaseAdmin();
      const { user, error: userError } = await getFintrakUserById(
        supabase,
        session.id
      );

      if (userError || !user) {
        if (userError) {
          request.log.error(
            {
              error: userError,
              sessionUserId: session.id,
            },
            "Failed to load FinTrak user for passcode reset."
          );
        }
        return reply.code(500).send({
          error: "Could not verify your account before resetting the passcode.",
        });
      }

      const passwordMatches = await verifyPassword(password, user.passwordHash);
      if (!passwordMatches) {
        return reply.code(401).send({ error: "Incorrect account password." });
      }

      const { error } = await clearFintrakUserPasscode(supabase, session.id);

      if (error) {
        request.log.error(
          {
            error,
            sessionUserId: session.id,
          },
          "Failed to clear FinTrak passcode."
        );
        return reply.code(500).send({
          error: "Could not clear your passcode.",
        });
      }

      clearPasscodeAttemptStateCookie(reply);
      return reply.send({ ok: true, hasPasscode: false });
    } catch (error) {
      request.log.error({ error }, "Unexpected passcode clear error.");
      return reply.code(500).send({
        error: "Unexpected passcode clear error.",
      });
    }
  });

  app.post("/passcode/verify", async (request, reply) => {
    try {
      const session = readSessionFromRequest(request);
      if (!session?.id) {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      if (!hasSupabaseAdminConfig()) {
        return reply.code(500).send({
          error: "Supabase is not configured for passcodes.",
        });
      }

      const attemptState = readPasscodeAttemptStateFromRequest(request);
      if (isPasscodeLocked(attemptState)) {
        applyPasscodeAttemptStateCookie(
          reply,
          buildPasscodeAttemptCookiePayload(attemptState)
        );
        return reply.code(429).send({
          error: createPasscodeLockedMessage(attemptState),
        });
      }

      const passcode = String(request.body?.passcode || "");
      if (!isValidPasscode(passcode)) {
        return reply.code(400).send({
          error: "Passcode must be exactly 6 digits.",
        });
      }

      const supabase = getSupabaseAdmin();
      const { user, error } = await getFintrakUserById(supabase, session.id);

      if (error || !user) {
        if (error) {
          request.log.error(
            {
              error,
              sessionUserId: session.id,
            },
            "Failed to load user for passcode verification."
          );
        }
        return reply.code(500).send({ error: "Could not verify passcode." });
      }

      if (!user.passcodeHash) {
        return reply.code(400).send({
          error: "No passcode has been set for this account.",
        });
      }

      const matches = await verifyPassword(passcode, user.passcodeHash);
      if (!matches) {
        const nextAttemptState = registerFailedPasscodeAttempt(attemptState);
        const locked = isPasscodeLocked(nextAttemptState);
        applyPasscodeAttemptStateCookie(
          reply,
          buildPasscodeAttemptCookiePayload(nextAttemptState)
        );
        return reply.code(locked ? 429 : 401).send({
          error: locked
            ? createPasscodeLockedMessage(nextAttemptState)
            : "Incorrect passcode.",
        });
      }

      clearPasscodeAttemptStateCookie(reply);
      return reply.send({ ok: true });
    } catch (error) {
      request.log.error({ error }, "Unexpected passcode verify error.");
      return reply.code(500).send({
        error: "Unexpected passcode verify error.",
      });
    }
  });
}
