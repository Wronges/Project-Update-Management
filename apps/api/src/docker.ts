import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectDefinition, RuntimeStatus } from "@pum/shared";

const execFileAsync = promisify(execFile);
const maxBuffer = 10 * 1024 * 1024;

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export class DockerAdapter {
  async runtimeStatuses(): Promise<Map<string, RuntimeStatus>> {
    const result = await this.run("docker", [
      "ps",
      "-a",
      "--format",
      "{{.Names}}|{{.State}}"
    ]);
    const statuses = new Map<string, RuntimeStatus>();

    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line) continue;
      const separator = line.lastIndexOf("|");
      if (separator < 0) continue;
      const name = line.slice(0, separator);
      const state = line.slice(separator + 1);
      statuses.set(name, mapRuntimeStatus(state));
    }

    return statuses;
  }

  async containerImageId(containerName: string): Promise<string | null> {
    try {
      const result = await this.run("docker", [
        "inspect",
        containerName,
        "--format",
        "{{.Image}}"
      ]);
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async taggedImageId(image: string): Promise<string | null> {
    try {
      const result = await this.run("docker", [
        "image",
        "inspect",
        image,
        "--format",
        "{{.Id}}"
      ]);
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async runtimeStatus(containerName: string): Promise<RuntimeStatus> {
    try {
      const result = await this.run("docker", [
        "inspect",
        containerName,
        "--format",
        "{{.State.Status}}"
      ]);
      return mapRuntimeStatus(result.stdout.trim());
    } catch {
      return "missing";
    }
  }

  pull(project: ProjectDefinition): Promise<CommandResult> {
    return this.compose(project, ["pull", project.composeService]);
  }

  recreate(project: ProjectDefinition): Promise<CommandResult> {
    return this.compose(project, [
      "up",
      "-d",
      "--force-recreate",
      project.composeService
    ]);
  }

  async rollback(
    project: ProjectDefinition,
    previousImageId: string
  ): Promise<CommandResult> {
    await this.run("docker", ["image", "tag", previousImageId, project.image]);
    return this.compose(project, [
      "up",
      "-d",
      "--force-recreate",
      "--pull",
      "never",
      project.composeService
    ]);
  }

  private compose(
    project: ProjectDefinition,
    args: string[]
  ): Promise<CommandResult> {
    return this.run("docker", ["compose", ...args], project.composeDirectory);
  }

  private async run(
    executable: string,
    args: string[],
    cwd?: string
  ): Promise<CommandResult> {
    const result = await execFileAsync(executable, args, {
      cwd,
      windowsHide: true,
      maxBuffer
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr
    };
  }
}

function mapRuntimeStatus(state: string): RuntimeStatus {
  if (state === "running" || state === "paused" || state === "restarting") {
    return state;
  }
  return "stopped";
}
