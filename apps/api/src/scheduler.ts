import type { UpdateTask } from "@pum/shared";
import { ProjectConflictError } from "./errors.js";
import { ProjectService } from "./project-service.js";
import { TaskDatabase } from "./database.js";
import { DockerAdapter } from "./docker.js";

const initialDelayMs = 60_000;
const projectDelayMs = 10_000;
const taskPollMs = 1_000;
const retentionMs = 30 * 24 * 60 * 60_000;
const imagePruneIntervalMs = 7 * 24 * 60 * 60_000;

type ProjectSchedulerService = Pick<
  ProjectService,
  "list" | "isLocked" | "createTask"
>;
type SchedulerTaskStore = Pick<TaskDatabase, "prune">;
type SchedulerDocker = Pick<DockerAdapter, "pruneImages">;

interface SchedulerOptions {
  intervalMinutes: number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now?: () => Date;
  logger?: Pick<Console, "info" | "warn" | "error">;
  docker: SchedulerDocker;
}

export class ProjectCheckScheduler {
  private readonly abortController = new AbortController();
  private readonly wait: (
    milliseconds: number,
    signal: AbortSignal
  ) => Promise<void>;
  private readonly now: () => Date;
  private readonly logger: Pick<Console, "info" | "warn" | "error">;
  private runPromise: Promise<void> | null = null;
  private lastImagePruneAt: number | null = null;

  constructor(
    private readonly projects: ProjectSchedulerService,
    private readonly tasks: SchedulerTaskStore,
    private readonly options: SchedulerOptions
  ) {
    this.wait = options.wait ?? abortableWait;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? console;
  }

  start(): void {
    if (this.options.intervalMinutes <= 0 || this.runPromise) return;
    this.runPromise = this.run().catch((error) => {
      if (!this.abortController.signal.aborted) {
        this.logger.error("Project check scheduler stopped unexpectedly", error);
      }
    });
  }

  async stop(): Promise<void> {
    this.abortController.abort();
    await this.runPromise;
  }

  private async run(): Promise<void> {
    await this.wait(initialDelayMs, this.abortController.signal);
    while (!this.abortController.signal.aborted) {
      await this.runRound();
      await this.wait(
        this.options.intervalMinutes * 60_000,
        this.abortController.signal
      );
    }
  }

  private async runRound(): Promise<void> {
    this.logger.info("Scheduled project check round started");
    for (const project of this.projects.list()) {
      if (this.abortController.signal.aborted) return;
      if (this.projects.isLocked(project.id)) {
        this.logger.info(`Scheduled check skipped locked project ${project.id}`);
        continue;
      }

      try {
        const task = this.projects.createTask(project.id, "check", "scheduled");
        await this.waitForTask(task);
      } catch (error) {
        if (!(error instanceof ProjectConflictError)) {
          this.logger.warn(`Scheduled check failed for ${project.id}`, error);
        }
      }

      await this.wait(projectDelayMs, this.abortController.signal);
    }

    const cutoff = new Date(this.now().getTime() - retentionMs);
    const deleted = this.tasks.prune(cutoff);
    await this.pruneImagesIfDue();
    this.logger.info(`Scheduled project check round finished; pruned ${deleted} tasks`);
  }

  private async pruneImagesIfDue(): Promise<void> {
    const now = this.now().getTime();
    if (
      this.lastImagePruneAt !== null &&
      now - this.lastImagePruneAt < imagePruneIntervalMs
    ) {
      return;
    }
    if (this.projects.list().some((project) => this.projects.isLocked(project.id))) {
      this.logger.info("Scheduled image prune skipped because a project is locked");
      return;
    }
    try {
      const result = await this.options.docker.pruneImages();
      this.lastImagePruneAt = now;
      this.logger.info(
        `Scheduled image prune completed; reclaimed ${result.reclaimedBytes} bytes`
      );
    } catch (error) {
      this.logger.warn("Scheduled image prune failed", error);
    }
  }

  private async waitForTask(task: UpdateTask): Promise<void> {
    while (
      !this.abortController.signal.aborted &&
      (task.status === "queued" || task.status === "running")
    ) {
      await this.wait(taskPollMs, this.abortController.signal);
    }
  }
}

function abortableWait(
  milliseconds: number,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}
