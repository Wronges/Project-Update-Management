import cors from "@fastify/cors";
import Fastify from "fastify";
import { appConfig } from "./config.js";
import { TaskDatabase } from "./database.js";
import { DockerAdapter } from "./docker.js";
import { loadInventory } from "./inventory.js";
import { ProjectService } from "./project-service.js";

export async function buildApp() {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });

  const inventory = await loadInventory(appConfig.inventoryPath);
  const tasks = new TaskDatabase(appConfig.databasePath);
  const projects = new ProjectService(inventory, new DockerAdapter(), tasks);
  await projects.initialize();

  app.get("/api/health", async () => ({ status: "ok" }));
  app.get("/api/dashboard", async () => ({
    summary: projects.summary(),
    projects: projects.list(),
    recentTasks: tasks.list(20)
  }));
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

  return app;
}

