import { getFintrakUserById, updateFintrakUserDataProfile } from "../lib/fintrakUsers.js";
import { normalizeCategoryRules } from "../lib/categoryRules.js";
import {
  getSupabaseAdmin,
  hasSupabaseAdminConfig,
} from "../lib/supabaseAdmin.js";
import { readSessionFromRequest } from "../lib/serverAuth.js";

function isObjectRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function registerUserDataRoutes(app) {
  app.get("/user-data", async (request, reply) => {
    try {
      const user = readSessionFromRequest(request);
      if (!user) {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      if (!hasSupabaseAdminConfig()) {
        return reply.send({
          categoryOverrides: {},
          budgetTargets: {},
          categoryRules: [],
          userKey: user.id,
          cloudSyncAvailable: false,
        });
      }

      const supabase = getSupabaseAdmin();
      const { user: appUser, error } = await getFintrakUserById(supabase, user.id);

      if (error) {
        request.log.warn(
          {
            error,
            sessionUserId: user.id,
          },
          "Failed to read user profile from Supabase."
        );
        return reply.send({
          categoryOverrides: {},
          budgetTargets: {},
          categoryRules: [],
          userKey: user.id,
          cloudSyncAvailable: false,
        });
      }

      return reply.send({
        categoryOverrides: appUser?.categoryOverrides || {},
        budgetTargets: appUser?.budgetTargets || {},
        categoryRules: appUser?.categoryRules || [],
        userKey: user.id,
        cloudSyncAvailable: true,
      });
    } catch (error) {
      request.log.error({ error }, "Failed to load user data.");
      return reply.send({
        categoryOverrides: {},
        budgetTargets: {},
        categoryRules: [],
        userKey: null,
        cloudSyncAvailable: false,
      });
    }
  });

  app.put("/user-data", async (request, reply) => {
    try {
      const user = readSessionFromRequest(request);
      if (!user) {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      const body = request.body || {};
      const categoryOverrides = isObjectRecord(body?.categoryOverrides)
        ? body.categoryOverrides
        : null;
      const budgetTargets = isObjectRecord(body?.budgetTargets)
        ? body.budgetTargets
        : null;
      const categoryRules = Array.isArray(body?.categoryRules)
        ? normalizeCategoryRules(body.categoryRules)
        : null;

      if (!categoryOverrides || !budgetTargets || categoryRules === null) {
        return reply.code(400).send({
          ok: false,
          cloudSyncAvailable: true,
          error:
            "categoryOverrides, budgetTargets, and categoryRules are required for cloud sync saves.",
        });
      }

      if (!hasSupabaseAdminConfig()) {
        return reply.code(503).send({
          ok: false,
          cloudSyncAvailable: false,
          error: "Cloud sync is not configured on the server.",
        });
      }

      const supabase = getSupabaseAdmin();
      const { error } = await updateFintrakUserDataProfile(supabase, user.id, {
        categoryOverrides,
        budgetTargets,
        categoryRules,
      });

      if (error) {
        request.log.error(
          {
            error,
            sessionUserId: user.id,
          },
          "Failed to save user profile to Supabase."
        );
        return reply.code(503).send({
          ok: false,
          cloudSyncAvailable: false,
          error: "Could not save your data to cloud storage.",
        });
      }

      return reply.send({ ok: true, cloudSyncAvailable: true });
    } catch (error) {
      request.log.error({ error }, "Failed to save user data.");
      return reply.code(500).send({
        ok: false,
        cloudSyncAvailable: false,
        error: "Unexpected cloud sync error.",
      });
    }
  });
}
