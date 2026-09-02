import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** Everything the importer writes lands under one directory, gitignored. */
export function dataDir(): string {
  const configured = process.env.ANANSI_DATA_DIR ?? "./data";
  return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
}

export function dataPath(...parts: string[]): string {
  return join(dataDir(), ...parts);
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function readJson<T>(relative: string): Promise<T | undefined> {
  const file = Bun.file(dataPath(relative));
  if (!(await file.exists())) return undefined;
  try {
    return (await file.json()) as T;
  } catch {
    return undefined;
  }
}

export async function writeJson(relative: string, value: unknown): Promise<void> {
  const path = dataPath(relative);
  await ensureDir(dirname(path));
  await Bun.write(path, JSON.stringify(value, null, 2) + "\n");
}

/** Line-delimited JSON: append-only, streamable, diffable, no library. */
export async function writeJsonl(relative: string, rows: unknown[]): Promise<void> {
  const path = dataPath(relative);
  await ensureDir(dirname(path));
  await Bun.write(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

export async function readJsonl<T>(relative: string): Promise<T[]> {
  const file = Bun.file(dataPath(relative));
  if (!(await file.exists())) return [];
  const text = await file.text();
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}
