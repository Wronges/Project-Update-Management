import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { UpdateTask } from "@pum/shared";

export class TaskDatabase {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS update_tasks (
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
      );
      CREATE INDEX IF NOT EXISTS idx_update_tasks_project_created
      ON update_tasks(project_id, created_at DESC);
    `);
  }

  create(task: UpdateTask): void {
    this.database
      .prepare(`
        INSERT INTO update_tasks (
          id, project_id, kind, status, previous_image_id, next_image_id,
          started_at, finished_at, created_at, error, log
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        task.id,
        task.projectId,
        task.kind,
        task.status,
        task.previousImageId,
        task.nextImageId,
        task.startedAt,
        task.finishedAt,
        task.createdAt,
        task.error,
        task.log
      );
  }

  update(task: UpdateTask): void {
    this.database
      .prepare(`
        UPDATE update_tasks SET
          status = ?, previous_image_id = ?, next_image_id = ?,
          started_at = ?, finished_at = ?, error = ?, log = ?
        WHERE id = ?
      `)
      .run(
        task.status,
        task.previousImageId,
        task.nextImageId,
        task.startedAt,
        task.finishedAt,
        task.error,
        task.log,
        task.id
      );
  }

  get(id: string): UpdateTask | null {
    const row = this.database
      .prepare("SELECT * FROM update_tasks WHERE id = ?")
      .get(id) as TaskRow | undefined;
    return row ? mapTask(row) : null;
  }

  list(limit = 50): UpdateTask[] {
    const rows = this.database
      .prepare("SELECT * FROM update_tasks ORDER BY created_at DESC LIMIT ?")
      .all(limit) as unknown as TaskRow[];
    return rows.map(mapTask);
  }

  latestForProject(projectId: string): UpdateTask | null {
    const row = this.database
      .prepare(`
        SELECT * FROM update_tasks
        WHERE project_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `)
      .get(projectId) as TaskRow | undefined;
    return row ? mapTask(row) : null;
  }
}

interface TaskRow {
  id: string;
  project_id: string;
  kind: "check" | "update";
  status: UpdateTask["status"];
  previous_image_id: string | null;
  next_image_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  error: string | null;
  log: string;
}

function mapTask(row: TaskRow): UpdateTask {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    status: row.status,
    previousImageId: row.previous_image_id,
    nextImageId: row.next_image_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    error: row.error,
    log: row.log
  };
}

