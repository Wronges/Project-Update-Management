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
        trigger: "manual",
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

  it("keeps a failed update status during runtime polling", async () => {
    const docker = createDocker();
    docker.pull.mockRejectedValue(new Error("registry unavailable"));
    docker.runtimeSnapshots.mockResolvedValue(
      new Map([
        [
          imageProject.containerName,
          { status: "running" as RuntimeStatus, imageId: "sha256:current" }
        ]
      ])
    );
    let now = Date.now();
    const tasks = createTaskStore();
    const service = new ProjectService([imageProject], docker, tasks, {
      now: () => new Date(now)
    });
    await service.initialize();

    const task = service.createTask(imageProject.id, "update");
    await waitFor(() => task.status === "failed");
    now += 5_000;
    await service.refreshRuntimeStatuses();

    expect(service.get(imageProject.id).updateStatus).toBe("failed");
    expect(service.summary().failedCount).toBe(1);
  });

  it("reuses runtime snapshots within the refresh TTL", async () => {
    const docker = createDocker();
    docker.runtimeSnapshots.mockResolvedValue(
      new Map([
        [
          imageProject.containerName,
          { status: "running" as RuntimeStatus, imageId: "sha256:current" }
        ]
      ])
    );
    let now = Date.now();
    const service = new ProjectService(
      [imageProject],
      docker,
      createTaskStore(),
      { now: () => new Date(now) }
    );
    await service.initialize();

    await service.refreshRuntimeStatuses();
    await service.refreshRuntimeStatuses();
    expect(docker.runtimeSnapshots).toHaveBeenCalledTimes(1);

    now += 3_001;
    await service.refreshRuntimeStatuses();
    expect(docker.runtimeSnapshots).toHaveBeenCalledTimes(2);
  });

  it("tags the rollback image after pull and before recreate", async () => {
    const docker = createDocker();
    docker.taggedImageId
      .mockResolvedValueOnce("sha256:previous")
      .mockResolvedValueOnce("sha256:next");
    docker.containerImageId.mockResolvedValue("sha256:previous");
    const project = { ...imageProject, healthUrl: undefined };
    const service = new ProjectService([project], docker, createTaskStore(), {
      freeDiskBytes: () => 10 * 1000 ** 3,
      wait: async () => undefined
    });
    await service.initialize();

    const task = service.createTask(project.id, "update");
    await waitFor(() => task.status === "succeeded");

    expect(docker.pull.mock.invocationCallOrder[0]).toBeLessThan(
      docker.tagRollbackImage.mock.invocationCallOrder[0]
    );
    expect(docker.tagRollbackImage.mock.invocationCallOrder[0]).toBeLessThan(
      docker.recreate.mock.invocationCallOrder[0]
    );
    expect(docker.tagRollbackImage).toHaveBeenCalledWith(
      project,
      "sha256:previous"
    );
    expect(task.log).toContain("[rollback-tag]");
  });

  it("continues an update when rollback image tagging fails", async () => {
    const docker = createDocker();
    docker.taggedImageId
      .mockResolvedValueOnce("sha256:previous")
      .mockResolvedValueOnce("sha256:next");
    docker.containerImageId.mockResolvedValue("sha256:previous");
    docker.tagRollbackImage.mockRejectedValue(new Error("tag failed"));
    const project = { ...imageProject, healthUrl: undefined };
    const service = new ProjectService([project], docker, createTaskStore(), {
      freeDiskBytes: () => 10 * 1000 ** 3,
      wait: async () => undefined
    });
    await service.initialize();

    const task = service.createTask(project.id, "update");
    await waitFor(() => task.status === "succeeded");

    expect(docker.recreate).toHaveBeenCalled();
    expect(task.log).toContain("[rollback-tag-warning]");
  });

  it("fails before pull when free disk space is below the configured minimum", async () => {
    const docker = createDocker();
    const service = new ProjectService(
      [imageProject],
      docker,
      createTaskStore(),
      {
        minFreeDiskGb: 2,
        freeDiskBytes: () => 1.4 * 1000 ** 3
      }
    );
    await service.initialize();

    const task = service.createTask(imageProject.id, "check");
    await waitFor(() => task.status === "failed");

    expect(task.error).toBe(
      "insufficient disk space: 1.4 GB free, 2 GB required"
    );
    expect(docker.pull).not.toHaveBeenCalled();
  });
});

function createDocker() {
  return {
    runtimeSnapshots: vi.fn(
      async () =>
        new Map<
          string,
          { status: RuntimeStatus; imageId: string | null }
        >()
    ),
    runtimeStatus: vi.fn(async () => "running" as RuntimeStatus),
    containerImageId: vi.fn(async () => "sha256:current"),
    taggedImageId: vi.fn(async () => "sha256:current"),
    imageInfo: vi.fn(async (ref: string) => ({
      id: ref,
      createdAt: "2026-06-01T00:00:00Z",
      version: "1.0.0",
      revision: null
    })),
    tagRollbackImage: vi.fn(async () => ({ stdout: "tagged", stderr: "" })),
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
    }),
    latestSuccessfulUpdateForProject: vi.fn((projectId: string) => {
      return (
        [...stored]
          .reverse()
          .find(
            (task) =>
              task.projectId === projectId &&
              task.kind === "update" &&
              task.status === "succeeded"
          ) ?? null
      );
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
