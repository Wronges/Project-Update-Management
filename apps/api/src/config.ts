import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

function resolveFromRoot(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(repositoryRoot, value);
}

function checkIntervalMinutes(value: string | undefined): number {
  const parsed = Number(value ?? 60);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.max(parsed, 30);
}

export const appConfig = {
  host: process.env.PUM_HOST ?? "127.0.0.1",
  port: Number(process.env.PUM_PORT ?? 8787),
  inventoryPath: resolveFromRoot(process.env.PUM_INVENTORY ?? "./config/projects.json"),
  databasePath: resolveFromRoot(process.env.PUM_DATABASE ?? "./data/project-update.db"),
  webRoot: resolveFromRoot(process.env.PUM_WEB_ROOT ?? "./apps/web/dist"),
  adminToken: process.env.PUM_ADMIN_TOKEN ?? "",
  githubToken: process.env.PUM_GITHUB_TOKEN ?? "",
  healthHostAlias: process.env.PUM_HEALTH_HOST_ALIAS ?? "",
  timeZone: process.env.PUM_TIME_ZONE ?? "Asia/Shanghai",
  rollbackOnFailure: process.env.PUM_ROLLBACK_ON_FAILURE !== "false",
  checkIntervalMinutes: checkIntervalMinutes(
    process.env.PUM_CHECK_INTERVAL_MINUTES
  )
};
