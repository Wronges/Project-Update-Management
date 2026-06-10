import { describe, expect, it, vi } from "vitest";
import type {
  ProjectDefinition,
  RuntimeStatus,
  UpdateTask
} from "@pum/shared";
import { ProjectConflictError, ProjectNotFoundError } from "./errors.js";
import { ProjectService } from "./project-service.js";

const manualProject: ProjectDefinition = {
  id: "manual-project",
  name: "manual-project",
  repository: "https://github.com/example/manual-project",
  server: "primary",
  composeDirectory: "/opt/manual-project",
  composeService: "app",
  containerName: "manual-project",
  image: "manual-project:local",
  updatePolicy: "manual",
  updateStrategy: "manual"
};

const imageProject: ProjectDefinition = {
  ...manualProject,
  id: "image-project",
  name: "image-project",
  containerName: "image-project",
  image: "example/image-project:latest",
  updateStrategy: "image",
  healthUrl: "http://127.0.0.1:3000/health"
};

describe("ProjectService", () => {
  it("releases the task lock when the initial database update fails", async () => {
    const docker = createDocker();
    const tasks = createTaskStore();
    tasks.update
      .mockImplementationOnce(() => {
        throw new Error("database is locked");
      })
      .mockImplementation(() => undefined);
    const service = new ProjectService([manualProject], docker, tasks);
    await service.initialize();

    service.createTask(manualProject.id, "check");
    await waitFor(() => tasks.update.mock.calls.length >= 2);

    expect(() => service.createTask(manualProject.id, "check")).not.toThrow();
  });

  it("checks manual projects without pulling an unavailable registry image", async () => {
    const docker = createDocker();
    const tasks = createTaskStore();
    const service = new ProjectService([manualProject], docker, tasks);
    await service.initialize();

    const task = service.createTask(manualProject.id, "check");
    await waitFor(() => task.status === "succeeded");

    expect(docker.pull).not.toHaveBeenCalled();
    expect(task.status).toBe("succeeded");
    expect(service.get(manualProject.id).runtimeStatus).toBe("running");
  });

  it("returns typed errors for missing and conflicting projects", async () => {
    const docker = createDocker();
    const tasks = createTaskStore();
    const service = new ProjectService([manualProject], docker, tasks);
    await service.initialize();

    expect(() => service.get("missing")).toThrow(ProjectNotFoundError);
    expect(() => service.createTask(manualProject.id, "update")).toThrow(
      ProjectConflictError
    );
  });

  it("rolls back to the previous image when the updated service stays unhealthy", async () => {
    const docker = createDocker();
    docker.taggedImageId
      .mockResolvedValueOnce("sha256:previous")
      .mockResolvedValueOnce("sha256:next")
      .mockResolvedValueOnce("sha256:previous");
    docker.containerImageId.mockResolvedValue("sha256:previous");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValue(new Response("", { status: 200 }));
    const tasks = createTaskStore();
    const service = new ProjectService([imageProject], docker, tasks, {
      fetcher,
      wait: async () => undefined
    });
    await service.initialize();

    const task = service.createTask(imageProject.id, "update");
    await waitFor(() => task.status === "failed" && task.finishedAt !== null);

    expect(docker.rollback).toHaveBeenCalledWith(
      imageProject,
      "sha256:previous"
    );
    expect(task.log).toContain("[rollback]");
  });

  it("counts successful updates using the configured local time zone", async () => {
    const docker = createDocker();
    const tasks = createTaskStore();
    tasks.list.mockReturnValue([
      {
        id: "task-1",
        projectId: imageProject.id,
        kind: "update",
        status: "succeeded",
        previousImageId: null,
        nextImageId: null,
        startedAt: null,
        finishedAt: "2026-06-09T16:30:00.000Z",
        createdAt: "2026-06-09T16:00:00.000Z",
        error: null,
        log: ""
      }
    ]);
    const service = new ProjectService([imageProject], docker, tasks, {
      timeZone: "Asia/Shanghai",
      now: () => new Date("2026-06-10T01:00:00.000Z")
    });
    await service.initialize();

    expect(service.summary().updatedTodayCount).toBe(1);
  });
});

function createDocker() {
  return {
    runtimeStatuses: vi.fn(async () => new Map<string, RuntimeStatus>()),
    runtimeStatus: vi.fn(async () => "running" as RuntimeStatus),
    containerImageId: vi.fn(async () => "sha256:current"),
    taggedImageId: vi.fn(async () => "sha256:current"),
    pull: vi.fn(async () => ({ stdout: "", stderr: "" })),
    recreate: vi.fn(async () => ({ stdout: "", stderr: "" })),
    rollback: vi.fn(async () => ({ stdout: "", stderr: "" }))
  };
}

function createTaskStore() {
  const stored: UpdateTask[] = [];
  return {
    create: vi.fn((task: UpdateTask) => stored.push(task)),
    update: vi.fn((_task: UpdateTask) => undefined),
    list: vi.fn(() => stored),
    latestForProject: vi.fn((projectId: string) => {
      return [...stored].reverse().find((task) => task.projectId === projectId) ?? null;
    })
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met");
}
