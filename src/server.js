import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function loadLocalEnvFiles() {
  const currentFile = fileURLToPath(import.meta.url);
  const projectRoot = path.resolve(path.dirname(currentFile), "../..");
  const envSearchRoots = [
    projectRoot,
    path.join(projectRoot, "TCP"),
    path.join(projectRoot, "backend"),
    path.join(projectRoot, "backend", "api"),
  ];
  const envFiles = [".env.local", ".env"];

  for (const rootDir of envSearchRoots) {
    for (const fileName of envFiles) {
      const filePath = path.join(rootDir, fileName);
      if (!existsSync(filePath)) {
        continue;
      }

      process.loadEnvFile(filePath);
    }
  }
}

loadLocalEnvFiles();

const { buildApp } = await import("./app.js");

const port = Number(process.env.PORT || 4000);
const host = process.env.HOST || "0.0.0.0";

const app = buildApp();

try {
  await app.listen({ port, host });
  app.log.info(`FinTrak API listening on ${host}:${port}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
