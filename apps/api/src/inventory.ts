import { readFile } from "node:fs/promises";
import {
  projectInventorySchema,
  type ProjectDefinition
} from "@pum/shared";

export async function loadInventory(filePath: string): Promise<ProjectDefinition[]> {
  const raw = await readFile(filePath, "utf8");
  return projectInventorySchema.parse(JSON.parse(raw));
}

