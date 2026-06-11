import { z } from "zod";

export const projectDefinitionSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  repository: z.string().url(),
  server: z.string().min(1),
  composeDirectory: z.string().min(1),
  composeService: z.string().min(1),
  containerName: z.string().min(1),
  image: z.string().min(1),
  healthUrl: z.string().url().optional(),
  updatePolicy: z.enum(["manual", "scheduled"]).default("manual"),
  updateStrategy: z.enum(["image", "manual"]).default("image"),
  manualUpdateNote: z.string().optional()
});

export const projectInventorySchema = z.array(projectDefinitionSchema);

export type ProjectDefinition = z.infer<typeof projectDefinitionSchema>;

export type UpdateStatus =
  | "unknown"
  | "checking"
  | "latest"
  | "update_available"
  | "updating"
  | "failed";

export type RuntimeStatus =
  | "running"
  | "stopped"
  | "paused"
  | "restarting"
  | "missing"
  | "unknown";

export interface ProjectStatus extends ProjectDefinition {
  runtimeStatus: RuntimeStatus;
  updateStatus: UpdateStatus;
  runningImageId: string | null;
  latestImageId: string | null;
  runningVersion: string | null;
  latestVersion: string | null;
  runningImageCreatedAt: string | null;
  latestImageCreatedAt: string | null;
  lastCheckedAt: string | null;
  lastUpdatedAt: string | null;
}

export interface ProjectRelease {
  tagName: string;
  name: string;
  publishedAt: string | null;
  htmlUrl: string;
  body: string;
  isNewerThanCurrent: boolean | null;
}

export interface ProjectReleasesPayload {
  repository: string;
  source: "github" | "github-tags" | "none";
  currentVersion: string | null;
  latestLocalVersion: string | null;
  releases: ProjectRelease[];
  fetchedAt: string;
  stale?: boolean;
  error?: string;
}

export interface UpdateTask {
  id: string;
  projectId: string;
  kind: "check" | "update";
  trigger: "manual" | "scheduled";
  status: "queued" | "running" | "succeeded" | "failed";
  previousImageId: string | null;
  nextImageId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  error: string | null;
  log: string;
}

export interface DashboardSummary {
  projectCount: number;
  updateAvailableCount: number;
  runningCount: number;
  failedCount: number;
  updatedTodayCount: number;
}

export interface ServerResourceUsage {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPercent: number;
}

export interface ContainerResourceStatus {
  id: string;
  name: string;
  state: string;
  status: string;
  cpuPercent: number;
  memoryPercent: number;
  memoryUsage: string;
  networkIo: string;
  blockIo: string;
  pids: number;
}

export interface ServerStatusPayload {
  collectedAt: string;
  hostname: string;
  platform: string;
  uptimeSeconds: number;
  cpuCount: number;
  loadAverage: [number, number, number];
  loadPercent: number;
  memory: ServerResourceUsage;
  disk: ServerResourceUsage;
  dockerDisk: Array<{
    type: string;
    totalCount: number;
    active: number;
    sizeBytes: number;
    reclaimableBytes: number;
  }> | null;
  containers: {
    total: number;
    running: number;
    stopped: number;
    items: ContainerResourceStatus[];
  };
}
