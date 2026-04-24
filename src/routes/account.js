import { revokeGoogleToken } from "../lib/googleOAuth.js";
import {
  clearSessionCookie,
  readSessionFromRequest,
} from "../lib/serverAuth.js";
import {
  getSupabaseAdmin,
  hasSupabaseAdminConfig,
} from "../lib/supabaseAdmin.js";
import {
  deleteFintrakUserById,
  getFintrakUserById,
} from "../lib/fintrakUsers.js";
import { verifyPassword } from "../lib/passwords.js";
import { decryptSecretValue } from "../lib/serverSecrets.js";

function normalizeConfirmation(value) {
  return String(value || "").trim().toLowerCase();
}

export async function registerAccountRoutes(app) {
  app.delete("/account", async (request, reply) => {
    try {
      const session = readSessionFromRequest(request);
      if (!session?.id) {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      if (!hasSupabaseAdminConfig()) {
        return reply.code(500).send({
          error: "Supabase is not configured for account deletion.",
        });
      }

      const body = request.body || {};
      const password = String(body?.password || "");
      const confirmation = normalizeConfirmation(body?.confirmation);

      if (!password) {
        return reply.code(400).send({
          error: "Password is required to delete your account.",
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
            "Failed to load FinTrak user during account deletion."
          );
        }
        return reply.code(500).send({
          error: "Could not load your account for deletion.",
        });
      }

      const allowedConfirmations = [user.username, user.email]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase());
      if (!allowedConfirmations.includes(confirmation)) {
        return reply.code(400).send({
          error: "Type your username or account email exactly to confirm deletion.",
        });
      }

      const passwordMatches = await verifyPassword(password, user.passwordHash);
      if (!passwordMatches) {
        return reply.code(401).send({ error: "Incorrect password." });
      }

      let warning = "";

      if (user.gmailRefreshToken) {
        let refreshToken = "";

        try {
          refreshToken = decryptSecretValue(user.gmailRefreshToken);
        } catch (decryptError) {
          request.log.error(
            {
              error: decryptError,
              sessionUserId: session.id,
            },
            "Failed to decrypt Gmail refresh token during account deletion."
          );
          warning =
            "Your account was deleted, but Gmail access could not be revoked automatically.";
        }

        if (refreshToken) {
          try {
            await revokeGoogleToken(refreshToken);
          } catch (revokeError) {
            const message =
              revokeError instanceof Error
                ? revokeError.message
                : "Google token revocation failed";

            if (revokeError?.status !== 400) {
              request.log.error(
                {
                  error: revokeError,
                  sessionUserId: session.id,
                },
                "Failed to revoke Gmail access during account deletion."
              );
              warning =
                "Your account was deleted, but Gmail access may still need to be removed from your Google account manually.";
            } else {
              request.log.warn(
                {
                  sessionUserId: session.id,
                  googleMessage: message,
                },
                "Google reported the Gmail token was already invalid during account deletion."
              );
            }
          }
        }
      }

      const { error: deleteError } = await deleteFintrakUserById(supabase, user.id);

      if (deleteError) {
        request.log.error(
          {
            error: deleteError,
            sessionUserId: session.id,
          },
          "Failed to delete FinTrak user."
        );
        return reply.code(500).send({
          error: "Could not delete your account right now.",
        });
      }

      clearSessionCookie(reply);
      return reply.send({ ok: true, warning: warning || null });
    } catch (error) {
      request.log.error({ error }, "Unexpected account deletion error.");
      return reply.code(500).send({
        error: "Unexpected account deletion error.",
      });
    }
  });
}
