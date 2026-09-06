import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const source = fileURLToPath(new URL("../../db/drizzle/", import.meta.url));
const target = fileURLToPath(new URL("../.alchemy/migrations/", import.meta.url));

await mkdir(target, { recursive: true });

const sourceFiles = (await readdir(source)).filter((name) => name.endsWith(".sql"));
const expected = new Set(sourceFiles);

for (const name of await readdir(target)) {
  if (name.endsWith(".sql") && !expected.has(name)) await unlink(join(target, name));
}

await Promise.all(sourceFiles.map(async (name) => {
  const sql = await readFile(join(source, name), "utf8");
  await writeFile(join(target, name), sql.replace(/\r\n/g, "\n"), "utf8");
}));

console.log(`Prepared ${sourceFiles.length} LF-normalized D1 migrations.`);
