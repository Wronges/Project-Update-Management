import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
