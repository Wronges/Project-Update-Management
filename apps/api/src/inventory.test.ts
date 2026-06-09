import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadInventory } from "./inventory.js";

describe("loadInventory", () => {
  it("loads a valid project definition", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pum-"));
    const file = path.join(directory, "projects.json");
    await writeFile(
      file,
      JSON.stringify([
        {
          id: "demo",
          name: "Demo",
          repository: "https://github.com/example/demo",
          server: "primary",
          composeDirectory: "/opt/demo",
          composeService: "app",
          containerName: "demo",
          image: "example/demo:latest",
          updatePolicy: "manual"
        }
      ])
    );

    const inventory = await loadInventory(file);
    expect(inventory[0]?.id).toBe("demo");
  });
});

