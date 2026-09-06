import type { AnansiDb } from "./types.ts";

/** A Drizzle SQLite statement which has been built but not executed yet. */
export type AtomicStatement = PromiseLike<unknown> & {
  run(): unknown;
};

type AtomicExecutor = (
  build: (db: AnansiDb) => AtomicStatement[],
) => Promise<void>;

const executors = new WeakMap<object, AtomicExecutor>();

/**
 * Register the transaction primitive supplied by a concrete database driver.
 * SQLite executes statements inside a callback transaction; D1 submits the
 * same statement list as one rollback-on-failure batch.
 */
export function registerAtomicExecutor(
  db: AnansiDb,
  execute: AtomicExecutor,
): void {
  executors.set(db as object, execute);
}

/** Execute one predeclared group of writes atomically on either adapter. */
export async function atomicWrite(
  db: AnansiDb,
  build: (db: AnansiDb) => AtomicStatement[],
): Promise<void> {
  const execute = executors.get(db as object);
  if (!execute) {
    throw new Error("database adapter has no atomic-write implementation");
  }
  await execute(build);
}
