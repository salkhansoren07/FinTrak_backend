import { probeSupabaseConnection } from "../lib/debugSupabase.js";

export async function registerDebugSupabaseRoutes(app) {
  app.get("/debug/supabase", async (request, reply) => {
    if (process.env.NODE_ENV === "production") {
      return reply.code(404).send({
        ok: false,
        issue: "disabled_in_production",
        message:
          "Supabase debug route is available only outside production.",
      });
    }

    const result = await probeSupabaseConnection();
    return reply.code(result.status).send(result.body);
  });
}
