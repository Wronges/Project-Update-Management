import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerServerPruneRoute } from "./app.js";

describe("POST /api/server/prune", () => {
  it("returns reclaimed bytes and command output", async () => {
    const app = Fastify();
    registerServerPruneRoute(app, {
      pruneImages: vi.fn(async () => ({
        reclaimedBytes: 1_500_000,
        stdout: "Total reclaimed space: 1.5MB\n",
        stderr: ""
      }))
    });

    const response = await app.inject({ method: "POST", url: "/api/server/prune" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      reclaimedBytes: 1_500_000,
      output: "Total reclaimed space: 1.5MB\n"
    });
    await app.close();
  });

  it("returns 500 when Docker prune fails", async () => {
    const app = Fastify({ logger: false });
    registerServerPruneRoute(app, {
      pruneImages: vi.fn(async () => {
        throw new Error("docker unavailable");
      })
    });

    const response = await app.inject({ method: "POST", url: "/api/server/prune" });
    expect(response.statusCode).toBe(500);
    await app.close();
  });
});
