import { describe, expect, it, vi } from "vitest";
import type { ProjectStatus, UpdateTask } from "@pum/shared";
import { ProjectCheckScheduler } from "./scheduler.js";

describe("ProjectCheckScheduler", () => {
  it("runs scheduled checks for every project in sequence", async () => {
    const projects = createProjects(["one", "two"]);
    const tasks = { prune: vi.fn(() => 3) };
    const docker = createDocker();
    const waits: number[] = [];
    const scheduler = new ProjectCheckScheduler(projects, tasks, {
      intervalMinutes: 30,
      wait: createTestWait(waits),
      now: () => new Date("2026-06-10T00:00:00.000Z"),
      logger: silentLogger,
      docker
    });

    scheduler.start();
    await waitFor(() => projects.createTask.mock.calls.length === 2);
    await scheduler.stop();

    expect(projects.createTask.mock.calls).toEqual([
      ["one", "check", "scheduled"],
      ["two", "check", "scheduled"]
    ]);
    expect(waits).toContain(60_000);
    expect(waits.filter((value) => value === 10_000)).toHaveLength(2);
    expect(tasks.prune).toHaveBeenCalledWith(
      new Date("2026-05-11T00:00:00.000Z")
    );
    expect(docker.pruneImages).toHaveBeenCalledTimes(1);
  });

  it("skips projects that already have an active task", async () => {
    const projects = createProjects(["locked", "free"]);
    projects.isLocked.mockImplementation((id: string) => id === "locked");
    const scheduler = new ProjectCheckScheduler(
      projects,
      { prune: vi.fn(() => 0) },
      {
        intervalMinutes: 30,
        wait: createTestWait([]),
        logger: silentLogger,
        docker: createDocker()
      }
    );

    scheduler.start();
    await waitFor(() => projects.createTask.mock.calls.length === 1);
    await scheduler.stop();

    expect(projects.createTask).toHaveBeenCalledWith(
      "free",
      "check",
      "scheduled"
    );
  });

  it("prunes images at most once every seven days", async () => {
    let now = new Date("2026-06-01T00:00:00Z");
    const docker = createDocker();
    const scheduler = new ProjectCheckScheduler(
      createProjects([]),
      { prune: vi.fn(() => 0) },
      {
        intervalMinutes: 60,
        wait: async () => undefined,
        now: () => now,
        logger: silentLogger,
        docker
      }
    );
    const runRound = scheduler as unknown as { runRound(): Promise<void> };

    await runRound.runRound();
    await runRound.runRound();
    expect(docker.pruneImages).toHaveBeenCalledTimes(1);

    now = new Date("2026-06-08T00:00:01Z");
    await runRound.runRound();
    expect(docker.pruneImages).toHaveBeenCalledTimes(2);
  });

  it("skips image prune while any project is locked", async () => {
    const projects = createProjects(["locked"]);
    projects.isLocked.mockReturnValue(true);
    const docker = createDocker();
    const scheduler = new ProjectCheckScheduler(
      projects,
      { prune: vi.fn(() => 0) },
      {
        intervalMinutes: 60,
        wait: async () => undefined,
        logger: silentLogger,
        docker
      }
    );

    await (scheduler as unknown as { runRound(): Promise<void> }).runRound();
    expect(docker.pruneImages).not.toHaveBeenCalled();
  });
});

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
};

function createProjects(ids: string[]) {
  return {
    list: vi.fn(
      () =>
        ids.map(
          (id) =>
            ({
              id
            }) as ProjectStatus
        )
    ),
    isLocked: vi.fn((_projectId: string) => false),
    createTask: vi.fn((projectId: string) => createCompletedTask(projectId))
  };
}

function createDocker() {
  return {
    pruneImages: vi.fn(async () => ({
      reclaimedBytes: 123,
      stdout: "",
      stderr: ""
    }))
  };
}

function createCompletedTask(projectId: string): UpdateTask {
  return {
    id: `${projectId}-task`,
    projectId,
    kind: "check",
    trigger: "scheduled",
    status: "succeeded",
    previousImageId: null,
    nextImageId: null,
    startedAt: null,
    finishedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    error: null,
    log: ""
  };
}

function createTestWait(delays: number[]) {
  let initialWaitCompleted = false;
  return (milliseconds: number, signal: AbortSignal): Promise<void> => {
    delays.push(milliseconds);
    if (!initialWaitCompleted && milliseconds === 60_000) {
      initialWaitCompleted = true;
      return Promise.resolve();
    }
    if (milliseconds === 10_000 || milliseconds === 1_000) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met");
}
