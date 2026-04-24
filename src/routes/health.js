export async function registerHealthRoutes(app) {
  app.get("/health", async () => ({
    ok: true,
    service: "fintrak-api",
    timestamp: new Date().toISOString(),
  }));
}
