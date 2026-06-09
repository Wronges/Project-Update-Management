import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

function resolveFromRoot(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(repositoryRoot, value);
}

export const appConfig = {
  host: process.env.PUM_HOST ?? "127.0.0.1",
  port: Number(process.env.PUM_PORT ?? 8787),
  inventoryPath: resolveFromRoot(process.env.PUM_INVENTORY ?? "./config/projects.json"),
  databasePath: resolveFromRoot(process.env.PUM_DATABASE ?? "./data/project-update.db"),
  webRoot: resolveFromRoot(process.env.PUM_WEB_ROOT ?? "./apps/web/dist"),
  adminToken: process.env.PUM_ADMIN_TOKEN ?? "",
  healthHostAlias: process.env.PUM_HEALTH_HOST_ALIAS ?? ""
};
