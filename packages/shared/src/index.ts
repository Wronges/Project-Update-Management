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
  updatePolicy: z.enum(["manual", "scheduled"]).default("manual")
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

export type RuntimeStatus = "running" | "stopped" | "missing" | "unknown";

export interface ProjectStatus extends ProjectDefinition {
  runtimeStatus: RuntimeStatus;
  updateStatus: UpdateStatus;
  runningImageId: string | null;
  latestImageId: string | null;
  lastCheckedAt: string | null;
  lastUpdatedAt: string | null;
}

export interface UpdateTask {
  id: string;
  projectId: string;
  kind: "check" | "update";
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

