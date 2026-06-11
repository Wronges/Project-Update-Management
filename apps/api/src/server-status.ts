import { execFile } from "node:child_process";
import { statfsSync } from "node:fs";
import os from "node:os";
import { promisify } from "node:util";
import type {
  ContainerResourceStatus,
  ServerResourceUsage,
  ServerStatusPayload
} from "@pum/shared";
import { parseDockerSize } from "./disk.js";

const execFileAsync = promisify(execFile);
const maxBuffer = 10 * 1024 * 1024;
const dockerTimeoutMs = 15_000;
const cacheTtlMs = 3_000;
let cachedStatus: ServerStatusPayload | null = null;
let cachedAt = 0;
let collectionPromise: Promise<ServerStatusPayload> | null = null;

interface DockerStatsRow {
  ID?: string;
  Name?: string;
  CPUPerc?: string;
  MemPerc?: string;
  MemUsage?: string;
  NetIO?: string;
  BlockIO?: string;
  PIDs?: string;
}

interface DockerPsRow {
  ID?: string;
  Names?: string;
  State?: string;
  Status?: string;
}

interface DockerDiskRow {
  Type?: string;
  TotalCount?: string;
  Active?: string;
  Size?: string;
  Reclaimable?: string;
}

export async function collectServerStatus(): Promise<ServerStatusPayload> {
  const now = Date.now();
  if (cachedStatus && now - cachedAt < cacheTtlMs) return cachedStatus;
  if (collectionPromise) return collectionPromise;
  collectionPromise = collectServerStatusOnce();
  try {
    cachedStatus = await collectionPromise;
    cachedAt = Date.now();
    return cachedStatus;
  } finally {
    collectionPromise = null;
  }
}

async function collectServerStatusOnce(): Promise<ServerStatusPayload> {
  const [statsResult, psResult, diskResult] = await Promise.all([
    runDocker(["stats", "--all", "--no-stream", "--format", "{{json .}}"]),
    runDocker(["ps", "-a", "--no-trunc", "--format", "{{json .}}"]),
    runDocker(["system", "df", "--format", "{{json .}}"]).catch(() => null)
  ]);
  const stats = parseJsonLines<DockerStatsRow>(statsResult.stdout);
  const containers = parseContainerRows(stats, parseJsonLines<DockerPsRow>(psResult.stdout));
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const loadAverage = os.loadavg() as [number, number, number];
  const cpuCount = Math.max(os.cpus().length, 1);

  return {
    collectedAt: new Date().toISOString(),
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    uptimeSeconds: os.uptime(),
    cpuCount,
    loadAverage,
    loadPercent: roundPercent((loadAverage[0] / cpuCount) * 100),
    memory: resourceUsage(totalMemory, freeMemory),
    disk: diskUsage("/"),
    dockerDisk: diskResult
      ? parseJsonLines<DockerDiskRow>(diskResult.stdout).map((row) => ({
          type: row.Type ?? "Unknown",
          totalCount: Number(row.TotalCount ?? 0),
          active: Number(row.Active ?? 0),
          sizeBytes: parseDockerSize(row.Size ?? ""),
          reclaimableBytes: parseDockerSize(row.Reclaimable ?? "")
        }))
      : null,
    containers: {
      total: containers.length,
      running: containers.filter((container) => container.state === "running").length,
      stopped: containers.filter((container) => container.state !== "running").length,
      items: containers.sort((a, b) => b.memoryPercent - a.memoryPercent)
    }
  };
}

export { parseDockerSize } from "./disk.js";

export function parseContainerRows(
  stats: DockerStatsRow[],
  processes: DockerPsRow[]
): ContainerResourceStatus[] {
  const statsByName = new Map(stats.map((row) => [row.Name ?? "", row]));

  return processes.map((process) => {
    const name = process.Names ?? "unknown";
    const resource = statsByName.get(name);
    return {
      id: (process.ID ?? resource?.ID ?? "").slice(0, 12),
      name,
      state: process.State ?? "unknown",
      status: process.Status ?? "unknown",
      cpuPercent: parsePercent(resource?.CPUPerc),
      memoryPercent: parsePercent(resource?.MemPerc),
      memoryUsage: resource?.MemUsage ?? "—",
      networkIo: resource?.NetIO ?? "—",
      blockIo: resource?.BlockIO ?? "—",
      pids: Number(resource?.PIDs ?? 0)
    };
  });
}

export function parseJsonLines<T>(value: string): T[] {
  return value
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function diskUsage(path: string): ServerResourceUsage {
  const stats = statfsSync(path);
  const totalBytes = stats.blocks * stats.bsize;
  const freeBytes = stats.bavail * stats.bsize;
  return resourceUsage(totalBytes, freeBytes);
}

function resourceUsage(totalBytes: number, freeBytes: number): ServerResourceUsage {
  const usedBytes = Math.max(totalBytes - freeBytes, 0);
  return {
    totalBytes,
    usedBytes,
    freeBytes,
    usedPercent: totalBytes ? roundPercent((usedBytes / totalBytes) * 100) : 0
  };
}

function parsePercent(value = "0"): number {
  const parsed = Number.parseFloat(value.replace("%", ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

async function runDocker(args: string[]) {
  return execFileAsync("docker", args, {
    windowsHide: true,
    maxBuffer,
    timeout: dockerTimeoutMs
  });
}
