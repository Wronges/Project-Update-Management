import { randomUUID } from "node:crypto";
import type {
  DashboardSummary,
  ProjectDefinition,
  ProjectStatus,
  UpdateTask
} from "@pum/shared";
import { DockerAdapter } from "./docker.js";
import { TaskDatabase } from "./database.js";

export class ProjectService {
  private readonly locks = new Set<string>();
  private readonly statuses = new Map<string, ProjectStatus>();

  constructor(
    private readonly projects: ProjectDefinition[],
    private readonly docker: DockerAdapter,
    private readonly tasks: TaskDatabase
  ) {}

  async initialize(): Promise<void> {
    await Promise.all(this.projects.map((project) => this.refreshRuntime(project)));
  }

  async refreshRuntimeStatuses(): Promise<void> {
    const runtimeStatuses = await this.docker.runtimeStatuses();

    for (const project of this.projects) {
      if (this.locks.has(project.id)) continue;
      const current = this.getStatus(project);
      this.statuses.set(project.id, {
        ...current,
        runtimeStatus: runtimeStatuses.get(project.containerName) ?? "missing"
      });
    }
  }

  list(): ProjectStatus[] {
    return this.projects.map((project) => this.getStatus(project));
  }

  get(projectId: string): ProjectStatus {
    return this.getStatus(this.requireProject(projectId));
  }

  summary(): DashboardSummary {
    const projects = this.list();
    const today = new Date().toISOString().slice(0, 10);
    const updatedTodayCount = this.tasks
      .list(200)
      .filter(
        (task) =>
          task.kind === "update" &&
          task.status === "succeeded" &&
          task.finishedAt?.startsWith(today)
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
      throw new Error(
        project.manualUpdateNote ?? `Project ${projectId} requires a manual update`
      );
    }
    if (this.locks.has(projectId)) {
      throw new Error(`Project ${projectId} already has an active task`);
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
    void this.execute(project, task);
    return task;
  }

  private async execute(
    project: ProjectDefinition,
    task: UpdateTask
  ): Promise<void> {
    task.status = "running";
    task.startedAt = new Date().toISOString();
    this.setOperationStatus(project, task.kind);
    this.tasks.update(task);

    try {
      const pull = await this.docker.pull(project);
      appendLog(task, "pull", pull.stdout, pull.stderr);
      task.nextImageId = await this.docker.taggedImageId(project.image);

      if (task.kind === "update") {
        const recreate = await this.docker.recreate(project);
        appendLog(task, "recreate", recreate.stdout, recreate.stderr);
        await wait(3000);
        await this.verifyHealth(project);
      }

      await this.refreshRuntime(project, task.nextImageId);
      task.status = "succeeded";
    } catch (error) {
      task.status = "failed";
      task.error = error instanceof Error ? error.message : String(error);
      task.log += `\n[error]\n${task.error}\n`;
      const current = this.getStatus(project);
      this.statuses.set(project.id, {
        ...current,
        updateStatus: "failed",
        lastCheckedAt: new Date().toISOString()
      });
    } finally {
      task.finishedAt = new Date().toISOString();
      this.tasks.update(task);
      this.locks.delete(project.id);
    }
  }

  private async verifyHealth(project: ProjectDefinition): Promise<void> {
    if (!project.healthUrl) return;

    const healthUrl = rewriteHealthHost(
      project.healthUrl,
      process.env.PUM_HEALTH_HOST_ALIAS ?? ""
    );
    let lastError = "health check failed";

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      try {
        const response = await fetch(healthUrl, {
          signal: AbortSignal.timeout(5000)
        });
        if (response.ok) return;
        lastError = `health check returned HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await wait(2000);
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
      throw new Error(`Unknown project: ${projectId}`);
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
