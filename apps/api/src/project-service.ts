import { randomUUID } from "node:crypto";
import type {
  DashboardSummary,
  ProjectDefinition,
  ProjectStatus,
  UpdateTask
} from "@pum/shared";
import { DockerAdapter } from "./docker.js";
import { TaskDatabase } from "./database.js";
import { ProjectConflictError, ProjectNotFoundError } from "./errors.js";

type DockerClient = Pick<
  DockerAdapter,
  | "runtimeStatuses"
  | "runtimeStatus"
  | "containerImageId"
  | "taggedImageId"
  | "pull"
  | "recreate"
  | "rollback"
>;

type TaskStore = Pick<
  TaskDatabase,
  "create" | "update" | "list" | "latestForProject"
>;

interface ProjectServiceOptions {
  healthHostAlias?: string;
  timeZone?: string;
  rollbackOnFailure?: boolean;
  fetcher?: typeof fetch;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
}

export class ProjectService {
  private readonly locks = new Set<string>();
  private readonly statuses = new Map<string, ProjectStatus>();
  private readonly healthHostAlias: string;
  private readonly timeZone: string;
  private readonly rollbackOnFailure: boolean;
  private readonly fetcher: typeof fetch;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly now: () => Date;
  private runtimeRefreshPromise: Promise<void> | null = null;

  constructor(
    private readonly projects: ProjectDefinition[],
    private readonly docker: DockerClient,
    private readonly tasks: TaskStore,
    options: ProjectServiceOptions = {}
  ) {
    this.healthHostAlias = options.healthHostAlias ?? "";
    this.timeZone = options.timeZone ?? "Asia/Shanghai";
    this.rollbackOnFailure = options.rollbackOnFailure ?? true;
    this.fetcher = options.fetcher ?? fetch;
    this.wait = options.wait ?? wait;
    this.now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    await Promise.all(this.projects.map((project) => this.refreshRuntime(project)));
  }

  async refreshRuntimeStatuses(): Promise<void> {
    if (this.runtimeRefreshPromise) return this.runtimeRefreshPromise;
    this.runtimeRefreshPromise = this.refreshRuntimeStatusesOnce();
    try {
      await this.runtimeRefreshPromise;
    } finally {
      this.runtimeRefreshPromise = null;
    }
  }

  private async refreshRuntimeStatusesOnce(): Promise<void> {
    const runtimeStatuses = await this.docker.runtimeStatuses();

    await Promise.all(
      this.projects.map(async (project) => {
        if (this.locks.has(project.id)) return;
        const current = this.getStatus(project);
        const runningImageId = await this.docker.containerImageId(
          project.containerName
        );
        this.statuses.set(project.id, {
          ...current,
          runtimeStatus: runtimeStatuses.get(project.containerName) ?? "missing",
          runningImageId,
          updateStatus: resolveUpdateStatus(
            runningImageId,
            current.latestImageId,
            current.updateStatus
          )
        });
      })
    );
  }

  list(): ProjectStatus[] {
    return this.projects.map((project) => this.getStatus(project));
  }

  get(projectId: string): ProjectStatus {
    return this.getStatus(this.requireProject(projectId));
  }

  summary(): DashboardSummary {
    const projects = this.list();
    const today = dateInTimeZone(this.now(), this.timeZone);
    const updatedTodayCount = this.tasks
      .list(200)
      .filter(
        (task) =>
          task.kind === "update" &&
          task.status === "succeeded" &&
          task.finishedAt &&
          dateInTimeZone(new Date(task.finishedAt), this.timeZone) === today
      ).length;

    return {
      projectCount: projects.length,
      updateAvailableCount: projects.filter(
        (project) => project.updateStatus === "update_available"
      ).length,
      runningCount: projects.filter(
        (project) => project.runtimeStatus === "running"
      ).length,
      failedCount: projects.filter(
        (project) => project.updateStatus === "failed"
      ).length,
      updatedTodayCount
    };
  }

  createTask(projectId: string, kind: UpdateTask["kind"]): UpdateTask {
    const project = this.requireProject(projectId);
    if (kind === "update" && project.updateStrategy === "manual") {
      throw new ProjectConflictError(
        project.manualUpdateNote ?? `Project ${projectId} requires a manual update`
      );
    }
    if (this.locks.has(projectId)) {
      throw new ProjectConflictError(
        `Project ${projectId} already has an active task`
      );
    }

    const now = new Date().toISOString();
    const task: UpdateTask = {
      id: randomUUID(),
      projectId,
      kind,
      status: "queued",
      previousImageId: this.getStatus(project).runningImageId,
      nextImageId: null,
      startedAt: null,
      finishedAt: null,
      createdAt: now,
      error: null,
      log: ""
    };
    this.tasks.create(task);
    this.locks.add(projectId);
    void this.execute(project, task).catch(() => {
      this.locks.delete(project.id);
    });
    return task;
  }

  private async execute(
    project: ProjectDefinition,
    task: UpdateTask
  ): Promise<void> {
    let deploymentStarted = false;

    try {
      task.status = "running";
      task.startedAt = new Date().toISOString();
      this.setOperationStatus(project, task.kind);
      this.tasks.update(task);

      if (task.kind === "check" && project.updateStrategy === "manual") {
        await this.refreshRuntime(project);
        task.nextImageId = this.getStatus(project).latestImageId;
        task.status = "succeeded";
        return;
      }

      const pull = await this.docker.pull(project);
      appendLog(task, "pull", pull.stdout, pull.stderr);
      task.nextImageId = await this.docker.taggedImageId(project.image);
      this.tasks.update(task);

      if (task.kind === "update") {
        deploymentStarted = true;
        const recreate = await this.docker.recreate(project);
        appendLog(task, "recreate", recreate.stdout, recreate.stderr);
        this.tasks.update(task);
        await this.wait(3000);
        await this.verifyHealth(project);
      }

      await this.refreshRuntime(project, task.nextImageId);
      task.status = "succeeded";
    } catch (error) {
      task.status = "failed";
      task.error = error instanceof Error ? error.message : String(error);
      task.log += `\n[error]\n${task.error}\n`;
      if (
        deploymentStarted &&
        this.rollbackOnFailure &&
        task.previousImageId &&
        task.previousImageId !== task.nextImageId
      ) {
        await this.tryRollback(project, task);
      }
      const current = this.getStatus(project);
      this.statuses.set(project.id, {
        ...current,
        updateStatus: "failed",
        lastCheckedAt: new Date().toISOString()
      });
    } finally {
      task.finishedAt = new Date().toISOString();
      try {
        this.tasks.update(task);
      } finally {
        this.locks.delete(project.id);
      }
    }
  }

  private async tryRollback(
    project: ProjectDefinition,
    task: UpdateTask
  ): Promise<void> {
    try {
      const rollback = await this.docker.rollback(
        project,
        task.previousImageId as string
      );
      appendLog(task, "rollback", rollback.stdout, rollback.stderr);
      await this.wait(3000);
      await this.verifyHealth(project);
      await this.refreshRuntime(project);
    } catch (rollbackError) {
      const message =
        rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      task.log += `\n[rollback-error]\n${message}\n`;
    }
  }

  private async verifyHealth(project: ProjectDefinition): Promise<void> {
    if (!project.healthUrl) return;

    const healthUrl = rewriteHealthHost(
      project.healthUrl,
      this.healthHostAlias
    );
    let lastError = "health check failed";

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      try {
        const response = await this.fetcher(healthUrl, {
          signal: AbortSignal.timeout(5000)
        });
        if (response.ok) return;
        lastError = `health check returned HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await this.wait(2000);
    }

    throw new Error(lastError);
  }

  private async refreshRuntime(
    project: ProjectDefinition,
    latestOverride?: string | null
  ): Promise<void> {
    const [runtimeStatus, runningImageId, localImageId] = await Promise.all([
      this.docker.runtimeStatus(project.containerName),
      this.docker.containerImageId(project.containerName),
      latestOverride === undefined
        ? this.docker.taggedImageId(project.image)
        : Promise.resolve(latestOverride)
    ]);
    const lastTask = this.tasks.latestForProject(project.id);

    this.statuses.set(project.id, {
      ...project,
      runtimeStatus,
      updateStatus:
        runningImageId && localImageId && runningImageId !== localImageId
          ? "update_available"
          : runningImageId && localImageId
            ? "latest"
            : "unknown",
      runningImageId,
      latestImageId: localImageId,
      lastCheckedAt: lastTask?.finishedAt ?? null,
      lastUpdatedAt:
        lastTask?.kind === "update" && lastTask.status === "succeeded"
          ? lastTask.finishedAt
          : null
    });
  }

  private setOperationStatus(
    project: ProjectDefinition,
    kind: UpdateTask["kind"]
  ): void {
    this.statuses.set(project.id, {
      ...this.getStatus(project),
      updateStatus: kind === "check" ? "checking" : "updating"
    });
  }

  private getStatus(project: ProjectDefinition): ProjectStatus {
    return (
      this.statuses.get(project.id) ?? {
        ...project,
        runtimeStatus: "unknown",
        updateStatus: "unknown",
        runningImageId: null,
        latestImageId: null,
        lastCheckedAt: null,
        lastUpdatedAt: null
      }
    );
  }

  private requireProject(projectId: string): ProjectDefinition {
    const project = this.projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      throw new ProjectNotFoundError(projectId);
    }
    return project;
  }
}

function appendLog(
  task: UpdateTask,
  stage: string,
  stdout: string,
  stderr: string
): void {
  task.log += `\n[${stage}]\n${stdout}${stderr}\n`;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function rewriteHealthHost(url: string, alias: string): string {
  if (!alias) return url;
  const parsed = new URL(url);
  if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
    parsed.hostname = alias;
  }
  return parsed.toString();
}

function resolveUpdateStatus(
  runningImageId: string | null,
  latestImageId: string | null,
  currentStatus: ProjectStatus["updateStatus"]
): ProjectStatus["updateStatus"] {
  if (currentStatus === "checking" || currentStatus === "updating") {
    return currentStatus;
  }
  if (!runningImageId || !latestImageId) return "unknown";
  return runningImageId === latestImageId ? "latest" : "update_available";
}

function dateInTimeZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}
