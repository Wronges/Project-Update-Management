import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { appConfig } from "./config.js";
import { TaskDatabase } from "./database.js";
import { DockerAdapter } from "./docker.js";
import { ProjectConflictError, ProjectNotFoundError } from "./errors.js";
import { loadInventory } from "./inventory.js";
import { ProjectService } from "./project-service.js";
import { ProjectCheckScheduler } from "./scheduler.js";
import { collectServerStatus } from "./server-status.js";

export async function buildApp() {
  const app = Fastify({ logger: true });
  if (existsSync(appConfig.webRoot)) {
    await app.register(fastifyStatic, {
      root: appConfig.webRoot,
      wildcard: false
    });
  }

  const inventory = await loadInventory(appConfig.inventoryPath);
  const tasks = new TaskDatabase(appConfig.databasePath);
  const projects = new ProjectService(inventory, new DockerAdapter(), tasks, {
    healthHostAlias: appConfig.healthHostAlias,
    timeZone: appConfig.timeZone,
    rollbackOnFailure: appConfig.rollbackOnFailure
  });
  await projects.initialize();
  const scheduler = new ProjectCheckScheduler(projects, tasks, {
    intervalMinutes: appConfig.checkIntervalMinutes,
    logger: app.log
  });
  scheduler.start();
  app.addHook("onClose", async () => {
    await scheduler.stop();
    tasks.close();
  });

  app.addHook("preHandler", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD") return;
    if (!appConfig.adminToken) {
      return reply.code(503).send({
        error: "PUM_ADMIN_TOKEN is not configured; update operations are disabled"
      });
    }
    if (!tokensEqual(request.headers["x-pum-token"], appConfig.adminToken)) {
      return reply.code(401).send({ error: "Invalid administrator token" });
    }
  });

  app.get("/api/health", async () => ({
    status: "ok",
    mutationsEnabled: Boolean(appConfig.adminToken)
  }));
  app.get("/api/dashboard", async () => {
    await projects.refreshRuntimeStatuses();
    return {
      summary: projects.summary(),
      projects: projects.list(),
      recentTasks: tasks.listVisible(20)
    };
  });
  app.get("/api/server-status", async () => collectServerStatus());
  app.get("/api/projects", async () => {
    await projects.refreshRuntimeStatuses();
    return projects.list();
  });
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id",
    async (request, reply) => {
      try {
        await projects.refreshRuntimeStatuses();
        return {
          project: projects.get(request.params.id),
          history: tasks.listForProject(request.params.id, 20)
        };
      } catch (error) {
        return sendProjectError(reply, error);
      }
    }
  );
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/check",
    async (request, reply) => {
      try {
        return reply
          .code(202)
          .send(projects.createTask(request.params.id, "check", "manual"));
      } catch (error) {
        return sendProjectError(reply, error);
      }
    }
  );
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/update",
    async (request, reply) => {
      try {
        return reply
          .code(202)
          .send(projects.createTask(request.params.id, "update", "manual"));
      } catch (error) {
        return sendProjectError(reply, error);
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

function tokensEqual(
  provided: string | string[] | undefined,
  expected: string
): boolean {
  if (typeof provided !== "string") return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

function sendProjectError(
  reply: { code(statusCode: number): { send(payload: object): unknown } },
  error: unknown
) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ProjectNotFoundError) {
    return reply.code(404).send({ error: message });
  }
  if (error instanceof ProjectConflictError) {
    return reply.code(409).send({ error: message });
  }
  throw error;
}
