import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectDefinition, RuntimeStatus } from "@pum/shared";

const execFileAsync = promisify(execFile);
const maxBuffer = 10 * 1024 * 1024;
const queryTimeoutMs = 15_000;
const composeTimeoutMs = 10 * 60_000;

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface RuntimeSnapshot {
  status: RuntimeStatus;
  imageId: string | null;
}

export class DockerAdapter {
  async runtimeSnapshots(): Promise<Map<string, RuntimeSnapshot>> {
    const result = await this.run("docker", [
      "ps",
      "-a",
      "--format",
      "{{.Names}}|{{.State}}"
    ]);
    const snapshots = new Map<string, RuntimeSnapshot>();

    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line) continue;
      const separator = line.lastIndexOf("|");
      if (separator < 0) continue;
      const name = line.slice(0, separator);
      const state = line.slice(separator + 1);
      snapshots.set(name, {
        status: mapRuntimeStatus(state),
        imageId: null
      });
    }

    const names = [...snapshots.keys()];
    if (!names.length) return snapshots;

    let inspectOutput = "";
    try {
      const inspect = await this.run("docker", [
        "inspect",
        "--format",
        "{{.Name}}|{{.Image}}",
        ...names
      ]);
      inspectOutput = inspect.stdout;
    } catch (error) {
      inspectOutput = commandOutput(error);
      if (!inspectOutput) throw error;
    }
    for (const line of inspectOutput.split(/\r?\n/)) {
      if (!line) continue;
      const separator = line.lastIndexOf("|");
      if (separator < 0) continue;
      const name = line.slice(0, separator).replace(/^\//, "");
      const snapshot = snapshots.get(name);
      if (snapshot) snapshot.imageId = line.slice(separator + 1) || null;
    }

    return snapshots;
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
    return this.compose(project, ["pull", project.composeService], composeTimeoutMs);
  }

  recreate(project: ProjectDefinition): Promise<CommandResult> {
    return this.compose(
      project,
      ["up", "-d", "--force-recreate", project.composeService],
      composeTimeoutMs
    );
  }

  async rollback(
    project: ProjectDefinition,
    previousImageId: string
  ): Promise<CommandResult> {
    await this.run("docker", ["image", "tag", previousImageId, project.image]);
    return this.compose(
      project,
      [
        "up",
        "-d",
        "--force-recreate",
        "--pull",
        "never",
        project.composeService
      ],
      composeTimeoutMs
    );
  }

  private compose(
    project: ProjectDefinition,
    args: string[],
    timeout = queryTimeoutMs
  ): Promise<CommandResult> {
    return this.run(
      "docker",
      ["compose", ...args],
      project.composeDirectory,
      timeout
    );
  }

  private async run(
    executable: string,
    args: string[],
    cwd?: string,
    timeout = queryTimeoutMs
  ): Promise<CommandResult> {
    const result = await execFileAsync(executable, args, {
      cwd,
      windowsHide: true,
      maxBuffer,
      timeout
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

function commandOutput(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "stdout" in error &&
    typeof error.stdout === "string"
  ) {
    return error.stdout;
  }
  return "";
}
