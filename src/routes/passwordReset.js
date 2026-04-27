import {
  getFintrakUserByEmail,
  updateFintrakUserPassword,
} from "../lib/fintrakUsers.js";
import {
  hasTransactionalEmailConfig,
  sendPasswordResetEmail,
} from "../lib/emailService.js";
import { reportServerError, reportServerWarning } from "../lib/observability.js";
import {
  buildPasswordResetUrl,
  canRequestPasswordReset,
  createPasswordResetRecord,
  createPasswordResetToken,
  deletePasswordResetTokensForUser,
  getPasswordResetClientAddress,
  isPasswordResetRecordUsable,
  markPasswordResetRecordUsed,
  readPasswordResetRecordByToken,
} from "../lib/passwordReset.js";
import { hashPassword } from "../lib/passwords.js";
import {
  getSupabaseAdmin,
  hasSupabaseAdminConfig,
} from "../lib/supabaseAdmin.js";

const GENERIC_SUCCESS_MESSAGE =
  "If an account exists for that email, a password reset link has been sent.";

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function isValidPassword(password) {
  return String(password || "").length >= 8;
}

export async function registerPasswordResetRoutes(app) {
  app.post("/auth/forgot-password", async (request, reply) => {
    try {
      if (!hasSupabaseAdminConfig()) {
        return reply.code(503).send({
          error: "Supabase is not configured for password resets.",
        });
      }

      if (!hasTransactionalEmailConfig()) {
        await reportServerWarning({
          event: "email.config.missing",
          message: "Transactional email configuration is missing.",
          request,
        });
        return reply.code(503).send({
          error: "Password reset email delivery is not configured on the server.",
        });
      }

      const body = request.body || {};
      const email = String(body?.email || "").trim().toLowerCase();

      if (!isValidEmail(email)) {
        return reply.code(400).send({
          error: "Please enter a valid email address.",
        });
      }

      const clientAddress = getPasswordResetClientAddress(request);
      const allowed = await canRequestPasswordReset(email, clientAddress);

      if (!allowed) {
        await reportServerWarning({
          event: "auth.forgot_password.rate_limited",
          message: "Password reset request was rate limited.",
          request,
          context: { email, clientAddress },
        });
        return reply.send({ ok: true, message: GENERIC_SUCCESS_MESSAGE });
      }

      const supabase = getSupabaseAdmin();
      const { user, error } = await getFintrakUserByEmail(supabase, email);

      if (error) {
        await reportServerError({
          event: "auth.forgot_password.user_lookup_failed",
          message: "Failed to look up FinTrak user during password reset request.",
          error,
          request,
          context: { email },
        });
        return reply.code(500).send({
          error: "Could not process your password reset request right now.",
        });
      }

      if (!user?.id || !user.email) {
        return reply.send({ ok: true, message: GENERIC_SUCCESS_MESSAGE });
      }

      const { token, tokenHash, expiresAt } = createPasswordResetToken();

      const deleteResult = await deletePasswordResetTokensForUser(supabase, user.id);
      if (deleteResult.error) {
        await reportServerError({
          event: "auth.forgot_password.delete_existing_failed",
          message: "Failed to clear existing password reset tokens.",
          error: deleteResult.error,
          request,
          context: { sessionUserId: user.id, email },
        });
        return reply.send({ ok: true, message: GENERIC_SUCCESS_MESSAGE });
      }

      if (deleteResult.missingTable) {
        await reportServerWarning({
          event: "auth.forgot_password.storage_missing",
          message: "Password reset storage table is not configured on the server.",
          request,
          context: { sessionUserId: user.id, email },
        });
        return reply.send({ ok: true, message: GENERIC_SUCCESS_MESSAGE });
      }

      const createResult = await createPasswordResetRecord(supabase, {
        userId: user.id,
        email: user.email,
        tokenHash,
        expiresAt,
        requestedIp: clientAddress,
      });

      if (createResult.error || !createResult.record) {
        await reportServerError({
          event: "auth.forgot_password.create_token_failed",
          message: "Failed to create password reset token.",
          error: createResult.error,
          request,
          context: { sessionUserId: user.id, email },
        });
        return reply.send({ ok: true, message: GENERIC_SUCCESS_MESSAGE });
      }

      if (createResult.missingTable) {
        await reportServerWarning({
          event: "auth.forgot_password.storage_missing",
          message: "Password reset storage table is not configured on the server.",
          request,
          context: { sessionUserId: user.id, email },
        });
        return reply.send({ ok: true, message: GENERIC_SUCCESS_MESSAGE });
      }

      try {
        await sendPasswordResetEmail({
          to: user.email,
          resetUrl: buildPasswordResetUrl(token),
        });
      } catch (emailError) {
        await reportServerError({
          event: "auth.forgot_password.email_send_failed",
          message: "Failed to send password reset email.",
          error: emailError,
          request,
          context: { sessionUserId: user.id, email },
        });
        return reply.send({ ok: true, message: GENERIC_SUCCESS_MESSAGE });
      }

      return reply.send({ ok: true, message: GENERIC_SUCCESS_MESSAGE });
    } catch (error) {
      await reportServerError({
        event: "auth.forgot_password.unexpected_error",
        message: "Unexpected forgot-password error.",
        error,
        request,
      });
      return reply.code(500).send({
        error: "Unexpected password reset request error.",
      });
    }
  });

  app.post("/auth/reset-password", async (request, reply) => {
    try {
      if (!hasSupabaseAdminConfig()) {
        return reply.code(503).send({
          error: "Supabase is not configured for password resets.",
        });
      }

      const body = request.body || {};
      const token = String(body?.token || "").trim();
      const password = String(body?.password || "");

      if (!token) {
        return reply.code(400).send({
          error: "Reset token is required.",
        });
      }

      if (!isValidPassword(password)) {
        return reply.code(400).send({
          error: "Password must be at least 8 characters long.",
        });
      }

      const supabase = getSupabaseAdmin();
      const { record, error, missingTable } = await readPasswordResetRecordByToken(
        supabase,
        token
      );

      if (missingTable) {
        return reply.code(503).send({
          error: "Password reset storage is not configured on the server.",
        });
      }

      if (error) {
        await reportServerError({
          event: "auth.reset_password.token_lookup_failed",
          message: "Failed to look up password reset token.",
          error,
          request,
        });
        return reply.code(500).send({
          error: "Could not reset your password right now.",
        });
      }

      if (!isPasswordResetRecordUsable(record)) {
        return reply.code(400).send({
          error: "This reset link is invalid or has expired.",
        });
      }

      const passwordHash = await hashPassword(password);
      const updateResult = await updateFintrakUserPassword(
        supabase,
        record.user_id,
        passwordHash
      );

      if (updateResult.error) {
        await reportServerError({
          event: "auth.reset_password.user_update_failed",
          message: "Failed to update password during password reset.",
          error: updateResult.error,
          request,
          context: { sessionUserId: record.user_id },
        });
        return reply.code(500).send({
          error: "Could not reset your password right now.",
        });
      }

      const markUsedResult = await markPasswordResetRecordUsed(supabase, record.id);
      if (markUsedResult.error) {
        await reportServerError({
          event: "auth.reset_password.mark_used_failed",
          message: "Failed to mark password reset token as used.",
          error: markUsedResult.error,
          request,
          context: { sessionUserId: record.user_id },
        });
        return reply.code(500).send({
          error: "Could not finalize your password reset right now.",
        });
      }

      const deleteResult = await deletePasswordResetTokensForUser(
        supabase,
        record.user_id
      );
      if (deleteResult.error) {
        await reportServerError({
          event: "auth.reset_password.delete_remaining_failed",
          message:
            "Failed to clear remaining password reset tokens after reset.",
          error: deleteResult.error,
          request,
          context: { sessionUserId: record.user_id },
        });
      }

      return reply.send({
        ok: true,
        message: "Your password has been reset successfully.",
      });
    } catch (error) {
      await reportServerError({
        event: "auth.reset_password.unexpected_error",
        message: "Unexpected reset-password error.",
        error,
        request,
      });
      return reply.code(500).send({
        error: "Unexpected password reset error.",
      });
    }
  });
}
