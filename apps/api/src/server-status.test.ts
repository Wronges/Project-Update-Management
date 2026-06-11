import { describe, expect, it } from "vitest";
import {
  parseContainerRows,
  parseDockerSize,
  parseJsonLines
} from "./server-status.js";

describe("server status parsing", () => {
  it("merges docker process and resource rows", () => {
    const stats = parseJsonLines<Record<string, string>>(
      '{"Name":"api","CPUPerc":"1.25%","MemPerc":"4.50%","MemUsage":"90MiB / 2GiB","NetIO":"1MB / 2MB","BlockIO":"3MB / 4MB","PIDs":"12"}\n'
    );
    const processes = parseJsonLines<Record<string, string>>(
      '{"ID":"1234567890abcdef","Names":"api","State":"running","Status":"Up 2 hours"}\n'
    );

    expect(parseContainerRows(stats, processes)).toEqual([
      {
        id: "1234567890ab",
        name: "api",
        state: "running",
        status: "Up 2 hours",
        cpuPercent: 1.25,
        memoryPercent: 4.5,
        memoryUsage: "90MiB / 2GiB",
        networkIo: "1MB / 2MB",
        blockIo: "3MB / 4MB",
        pids: 12
      }
    ]);
  });

  it.each([
    ["5.265GB (32%)", 5_265_000_000],
    ["0B", 0],
    ["1.5kB", 1500],
    ["716.5MiB", Math.round(716.5 * 1024 ** 2)],
    ["invalid", 0]
  ])("parses Docker size %s", (value, expected) => {
    expect(parseDockerSize(value)).toBe(expected);
  });
});
