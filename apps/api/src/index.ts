import { buildApp } from "./app.js";
import { appConfig } from "./config.js";

const app = await buildApp();

await app.listen({
  host: appConfig.host,
  port: appConfig.port
});

