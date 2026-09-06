import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { media } from "./schema.ts";
export const mediaJobs = sqliteTable("media_jobs", {
  mediaId: text("media_id").primaryKey().references(() => media.id, { onDelete: "cascade" }),
  attempts: integer("attempts").notNull().default(0),
  nextRunAt: integer("next_run_at").notNull().default(0),
  leaseUntil: integer("lease_until").notNull().default(0),
  claimToken: text("claim_token"),
  lastError: text("last_error"),
}, t => [index("media_jobs_due").on(t.nextRunAt, t.leaseUntil)]);
