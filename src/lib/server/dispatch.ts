import { start } from "workflow/api";
import { backgroundReview } from "../../workflows/review";
import { awaitingDispatch } from "./background-store";

export const DISPATCH_WARNING = "Dispatch could not be confirmed. The durable review is saved; inspect its status before retrying.";

/**
 * Start (or restart) the workflow for a saved review job.
 *
 * A failed or lost dispatch used to leave the job queued until the daily cron:
 * every retry found the existing job and skipped dispatch. A job that is still
 * queued with no claiming workflow after a short grace period is dispatched
 * again. A duplicate dispatch is harmless because claimWorkflow admits one.
 */
export async function ensureDispatched(job: { id: string; execution: number; started: boolean }): Promise<{ dispatched: boolean; warning?: string }> {
  if (!job.started && !await awaitingDispatch(job.id, job.execution)) return { dispatched: false };
  try {
    await start(backgroundReview, [job.id, job.execution]);
    return { dispatched: true };
  } catch {
    return { dispatched: false, warning: DISPATCH_WARNING };
  }
}
