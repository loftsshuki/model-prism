import type { JudgeResult } from "./fusion";
import type { ModelInfo } from "./types";

// Shared shapes for the durable, server-side review runs (`review_jobs` table).
// Kept in their own module so src/lib/db.ts (rows) and src/lib/jobs.ts (step
// machine) can both import them without a circular dependency.

export type ReviewJobStatus = "queued" | "running" | "synthesizing" | "completed" | "failed" | "cancelled";
export type ReviewJobMode = "legacy" | "fusion";
export type ReviewJobPhase = "council" | "judge" | "synth" | "done";

/** Persisted progress. Every worker invocation reads this, advances one step, writes it back. */
export interface ReviewJobStep {
  /** Model ids still to be invoked. */
  pending: string[];
  /** Model ids whose review is saved in `responses`. */
  done: string[];
  /** Model ids that errored (their error row is saved in `responses`). */
  failed: string[];
  phase: ReviewJobPhase;
  /** Fusion only: the judge output, stashed between the "judge" and "synth" steps. */
  judge?: JudgeResult;
}

export interface ReviewJob {
  id: string;
  status: ReviewJobStatus;
  content: string;
  prompt: string;
  models: ModelInfo[];
  mode: ReviewJobMode;
  /** The `runs` row the responses/synthesis are saved under (created at enqueue). */
  run_id: string;
  context: string | null;
  step: ReviewJobStep;
  /** Accumulated council + synthesis spend in USD. */
  cost: number;
  error: string | null;
  /** Failed step attempts so far; the job is marked failed at MAX_JOB_ATTEMPTS. */
  attempts: number;
  locked_until: string | null;
  created_at: string;
  updated_at: string;
}

/** What one step writes back. Every mutable column is set explicitly so a step never leaves stale state behind. */
export interface ReviewJobPatch {
  status: ReviewJobStatus;
  step: ReviewJobStep;
  cost: number;
  error: string | null;
  attempts: number;
  /** "extend" keeps the row claimed (heartbeat) while a step is still running; "release" hands it back to the queue. */
  lock: "extend" | "release";
}

export const ACTIVE_JOB_STATUSES: readonly ReviewJobStatus[] = ["queued", "running", "synthesizing"];

export function isActiveJobStatus(status: string): status is "queued" | "running" | "synthesizing" {
  return (ACTIVE_JOB_STATUSES as readonly string[]).includes(status);
}

export function emptyStep(modelIds: string[]): ReviewJobStep {
  return { pending: [...modelIds], done: [], failed: [], phase: "council" };
}
