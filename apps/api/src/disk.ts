import { statfsSync } from "node:fs";

const decimalUnits: Record<string, number> = {
  B: 1,
  KB: 1000,
  MB: 1000 ** 2,
  GB: 1000 ** 3,
  TB: 1000 ** 4
};

const binaryUnits: Record<string, number> = {
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3
};

export function freeDiskBytes(path = "/"): number {
  const stats = statfsSync(path);
  return stats.bavail * stats.bsize;
}

export function parseDockerSize(value: string): number {
  const normalized = value.split("(", 1)[0].trim();
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*([kmgt]?i?b)$/i);
  if (!match) return 0;
  const amount = Number.parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const multiplier = decimalUnits[unit] ?? binaryUnits[unit];
  return Number.isFinite(amount) && multiplier
    ? Math.round(amount * multiplier)
    : 0;
}
