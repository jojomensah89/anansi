import { runAiSchedule } from "./server/ai-schedule.ts";
export { runAiSchedule } from "./server/ai-schedule.ts";
import { runPreviewPass } from "./server/link-preview.ts";
import startEntry from "@tanstack/react-start/server-entry";
import { openD1 } from "@anansi/db/d1";
import { type AiBinding, type VectorizeBinding } from "./server/ai.ts";
import { limitPublicRequest, secureResponse, type SecurityBindings } from "./server/worker-security.ts";

type WorkerBindings = Pick<Env, "DB" | "MEDIA"> & {
  AI?: AiBinding;
  VECTORIZE?: VectorizeBinding;
};

export async function runMediaSchedule(env: WorkerBindings): Promise<void> {
  await runPreviewPass(openD1(env.DB), { bucket: env.MEDIA, runtime: "worker" });
}


export default {
  async fetch(request: Request, env: WorkerBindings & SecurityBindings): Promise<Response> {
    const denied = await limitPublicRequest(request, env);
    return secureResponse(denied ?? await startEntry.fetch(request));
  },
  async scheduled(_controller: ScheduledController, env: WorkerBindings): Promise<void> {
    // Media network failures must not prevent durable AI work from running.
    const results = await Promise.allSettled([runMediaSchedule(env), runAiSchedule(env)]);
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
  },
};
