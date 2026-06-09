import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import { appConfig } from "./config.js";
import { TaskDatabase } from "./database.js";
import { DockerAdapter } from "./docker.js";
import { loadInventory } from "./inventory.js";
import { ProjectService } from "./project-service.js";
import { collectServerStatus } from "./server-status.js";

export async function buildApp() {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  if (existsSync(appConfig.webRoot)) {
    await app.register(fastifyStatic, {
      root: appConfig.webRoot,
      wildcard: false
    });
  }

  const inventory = await loadInventory(appConfig.inventoryPath);
  const tasks = new TaskDatabase(appConfig.databasePath);
  const projects = new ProjectService(inventory, new DockerAdapter(), tasks);
  await projects.initialize();

  app.addHook("preHandler", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD") return;
    if (!appConfig.adminToken) {
      return reply.code(503).send({
        error: "PUM_ADMIN_TOKEN is not configured; update operations are disabled"
      });
    }
    if (request.headers["x-pum-token"] !== appConfig.adminToken) {
      return reply.code(401).send({ error: "Invalid administrator token" });
    }
  });

  app.get("/api/health", async () => ({
    status: "ok",
    mutationsEnabled: Boolean(appConfig.adminToken)
  }));
  app.get("/api/dashboard", async () => ({
    summary: projects.summary(),
    projects: projects.list(),
    recentTasks: tasks.list(20)
  }));
  app.get("/api/server-status", async () => collectServerStatus());
  app.get("/api/projects", async () => projects.list());
  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request) => ({
    project: projects.get(request.params.id),
    history: tasks
      .list(200)
      .filter((task) => task.projectId === request.params.id)
      .slice(0, 20)
  }));
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/check",
    async (request, reply) => {
      try {
        return reply.code(202).send(projects.createTask(request.params.id, "check"));
      } catch (error) {
        return reply.code(409).send({
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  );
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/update",
    async (request, reply) => {
      try {
        return reply
          .code(202)
          .send(projects.createTask(request.params.id, "update"));
      } catch (error) {
        return reply.code(409).send({
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  );
  app.get("/api/tasks", async () => tasks.list(100));
  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    const task = tasks.get(request.params.id);
    return task ? task : reply.code(404).send({ error: "Task not found" });
  });
  if (existsSync(appConfig.webRoot)) {
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "Route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
