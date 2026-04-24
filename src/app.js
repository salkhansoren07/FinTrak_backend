import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { registerAccountRoutes } from "./routes/account.js";
import { registerAiInsightsRoutes } from "./routes/aiInsights.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerDebugSupabaseRoutes } from "./routes/debugSupabase.js";
import { registerGmailRoutes } from "./routes/gmail.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerPasscodeRoutes } from "./routes/passcode.js";
import { registerTestimonialRoutes } from "./routes/testimonials.js";
import { registerUserDataRoutes } from "./routes/userData.js";

function readAllowedOrigins() {
  const configured = String(process.env.CORS_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (configured.length > 0) {
    return configured;
  }

  return [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://app.fintrak.online",
  ];
}

export function buildApp() {
  const app = Fastify({
    logger: true,
  });

  app.register(cookie);
  app.register(cors, {
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      callback(null, readAllowedOrigins().includes(origin));
    },
    credentials: true,
  });

  app.register(registerHealthRoutes);
  app.register(registerAuthRoutes);
  app.register(registerPasscodeRoutes);
  app.register(registerUserDataRoutes);
  app.register(registerAccountRoutes);
  app.register(registerTestimonialRoutes);
  app.register(registerGmailRoutes);
  app.register(registerAiInsightsRoutes);
  app.register(registerDebugSupabaseRoutes);

  return app;
}
