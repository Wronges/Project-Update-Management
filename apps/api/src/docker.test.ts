import { describe, expect, it } from "vitest";
import {
  parseImageInfoOutput,
  parsePruneReclaimedBytes
} from "./docker.js";

describe("parseImageInfoOutput", () => {
  it("parses OCI version and revision labels", () => {
    expect(
      parseImageInfoOutput(
        'sha256:abc\t2026-06-01T12:00:00Z\t{"org.opencontainers.image.version":"1.2.3","org.opencontainers.image.revision":"deadbeef"}\n'
      )
    ).toEqual({
      id: "sha256:abc",
      createdAt: "2026-06-01T12:00:00Z",
      version: "1.2.3",
      revision: "deadbeef"
    });
  });

  it("accepts images whose Labels value is null", () => {
    expect(
      parseImageInfoOutput("sha256:def\t2026-06-02T12:00:00Z\tnull\n")
    ).toEqual({
      id: "sha256:def",
      createdAt: "2026-06-02T12:00:00Z",
      version: null,
      revision: null
    });
  });

  it("parses reclaimed bytes from Docker prune output", () => {
    expect(
      parsePruneReclaimedBytes("Total reclaimed space: 1.5MB\n")
    ).toBe(1_500_000);
    expect(parsePruneReclaimedBytes("Deleted Images:\n")).toBe(0);
  });
});
