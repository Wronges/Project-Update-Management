import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { UpdateTask } from "@pum/shared";
import { TaskDatabase } from "./database.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("TaskDatabase", () => {
  it("marks interrupted tasks as failed when reopened", () => {
    const databasePath = createDatabasePath();
    const database = new TaskDatabase(databasePath);
    const task = createTask({ status: "running", log: "pull started" });
    database.create(task);
    database.close();

    const reopened = new TaskDatabase(databasePath);
    const recovered = reopened.get(task.id);

    expect(recovered?.status).toBe("failed");
    expect(recovered?.error).toBe("interrupted by restart");
    expect(recovered?.finishedAt).not.toBeNull();
    expect(recovered?.log).toContain("interrupted by restart");
    reopened.close();
  });

  it("omits logs from list queries but keeps them in task details", () => {
    const database = new TaskDatabase(createDatabasePath());
    const task = createTask({ log: "large docker output" });
    database.create(task);

    expect(database.list(10)[0]?.log).toBe("");
    expect(database.listForProject(task.projectId, 10)[0]?.log).toBe("");
    expect(database.get(task.id)?.log).toBe("large docker output");
    database.close();
  });

  it("migrates existing databases and stores scheduled triggers", () => {
    const databasePath = createDatabasePath();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE update_tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        previous_image_id TEXT,
        next_image_id TEXT,
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        error TEXT,
        log TEXT NOT NULL DEFAULT ''
      )
    `);
    legacy.close();

    const database = new TaskDatabase(databasePath);
    const task = createTask({ trigger: "scheduled" });
    database.create(task);

    expect(database.get(task.id)?.trigger).toBe("scheduled");
    database.close();
  });

  it("prunes tasks older than the retention cutoff", () => {
    const database = new TaskDatabase(createDatabasePath());
    database.create(
      createTask({
        id: "old",
        createdAt: "2026-04-01T00:00:00.000Z"
      })
    );
    database.create(
      createTask({
        id: "recent",
        createdAt: "2026-06-01T00:00:00.000Z"
      })
    );

    expect(database.prune(new Date("2026-05-01T00:00:00.000Z"))).toBe(1);
    expect(database.get("old")).toBeNull();
    expect(database.get("recent")).not.toBeNull();
    database.close();
  });

  it("keeps successful scheduled checks out of visible history", () => {
    const database = new TaskDatabase(createDatabasePath());
    database.create(
      createTask({
        id: "scheduled-success",
        trigger: "scheduled",
        status: "succeeded",
        createdAt: "2026-06-10T00:00:00.000Z"
      })
    );
    database.create(
      createTask({
        id: "scheduled-failure",
        trigger: "scheduled",
        status: "failed",
        createdAt: "2026-06-10T00:01:00.000Z"
      })
    );
    database.create(
      createTask({
        id: "manual-success",
        status: "succeeded",
        createdAt: "2026-06-10T00:02:00.000Z"
      })
    );

    expect(database.listVisible(20).map((task) => task.id)).toEqual([
      "manual-success",
      "scheduled-failure"
    ]);
    database.close();
  });
});

function createDatabasePath(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pum-database-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "tasks.db");
}

function createTask(overrides: Partial<UpdateTask> = {}): UpdateTask {
  return {
    id: crypto.randomUUID(),
    projectId: "test-project",
    kind: "check",
    trigger: "manual",
    status: "queued",
    previousImageId: null,
    nextImageId: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date().toISOString(),
    error: null,
    log: "",
    ...overrides
  };
}
