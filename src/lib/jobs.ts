import { fanOut } from "./fan-out";
import { SYNTHESIZER_MODEL_ID, judgeViaOpenRouter, synthesizeFromJudge } from "./fusion";
import { OPENROUTER_SYNTHESIS_MODEL_ID, synthesizeViaOpenRouter } from "./synthesis";
import { getReviewJob, listRunResponses, saveResponse, saveSynthesis, updateReviewJob } from "./db";
import { isActiveJobStatus } from "./job-types";
import type { ReviewJob, ReviewJobStep } from "./job-types";
import type { ModelInfo, ModelResponse } from "./types";

// The step machine behind durable server-side runs.
//
// Every serverless invocation claims ONE job (src/lib/db.ts claimNextReviewJob),
// calls advanceJob once, and re-schedules itself. A step is bounded by `budgetMs`
// so it always finishes inside the function's maxDuration, and everything it
// learns is written back to the row before it returns — so a closed tab, a
// timeout, or a redeploy costs at most the in-flight batch, never the run.
//
// Phases: council (invoke models in small batches) → judge (fusion only) → synth → done.
// Each invocation advances exactly one phase; the council phase may run several
// batches while the budget allows.

/** Paid models are invoked two at a time; free-tier models one at a time (they share brutal rate limits). */
export const COUNCIL_BATCH_SIZE = 2;
/** Stop starting new council batches when this much of the budget is left, so the current batch can finish. */
export const BUDGET_TAIL_MS = 60_000;
/** A job whose steps have thrown this many times is marked failed rather than retried forever. */
export const MAX_JOB_ATTEMPTS = 3;
/** Council output cap for server-side runs. */
export const COUNCIL_MAX_TOKENS = 4096;

/** A completed council response in the shape the judge/synthesizer expect. */
export interface CouncilResponse {
  model: string;
  modelName: string;
  family: string;
  response: string;
}

// Everything with a side effect is injectable so the machine can be unit-tested
// without a database or OpenRouter. Defaults are the real functions.
export interface JobDeps {
  fanOut: typeof fanOut;
  judge: typeof judgeViaOpenRouter;
  synthesizeLegacy: typeof synthesizeViaOpenRouter;
  synthesizeFusion: typeof synthesizeFromJudge;
  saveResponse: typeof saveResponse;
  saveSynthesis: typeof saveSynthesis;
  listRunResponses: typeof listRunResponses;
  updateReviewJob: typeof updateReviewJob;
  getReviewJob: typeof getReviewJob;
  now: () => number;
}

export const defaultJobDeps: JobDeps = {
  fanOut,
  judge: judgeViaOpenRouter,
  synthesizeLegacy: synthesizeViaOpenRouter,
  synthesizeFusion: synthesizeFromJudge,
  saveResponse,
  saveSynthesis,
  listRunResponses,
  updateReviewJob,
  getReviewJob,
  now: () => Date.now(),
};

export interface AdvanceJobOptions {
  /** Server-side OpenRouter key. Missing → the job is failed with a clear error (never silently retried). */
  openrouterKey: string | undefined;
  /** Wall-clock budget for this invocation (derive from the route's maxDuration, leaving headroom). */
  budgetMs: number;
  deps?: Partial<JobDeps>;
}

interface StepContext {
  deps: JobDeps;
  openrouterKey: string;
  budgetMs: number;
  startedAt: number;
  /** Fires when the invocation's budget is spent, so no model call outlives the function. */
  signal: AbortSignal;
}

/**
 * A budget deadline as an AbortSignal. Hand-rolled rather than AbortSignal.timeout so
 * the timer is unref'd (it must not keep a test/CLI process alive) and can be cleared
 * once the step has finished.
 */
function createDeadline(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Step budget exhausted")), Math.max(1, ms));
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function cloneStep(step: ReviewJobStep): ReviewJobStep {
  return { ...step, pending: [...step.pending], done: [...step.done], failed: [...step.failed] };
}

/** Rows from the `responses` table → the judge/synthesizer input; error rows and empty bodies are dropped. */
export function toCouncilResponses(rows: Array<{ model: string; model_name: string | null; base_architecture: string | null; response: string | null; error: string | null }>): CouncilResponse[] {
  const out: CouncilResponse[] = [];
  for (const row of rows) {
    if (row.error || typeof row.response !== "string" || !row.response.trim()) continue;
    out.push({ model: row.model, modelName: row.model_name || row.model, family: row.base_architecture || "unknown", response: row.response });
  }
  return out;
}

/**
 * Pick the next council batch from `pending`: up to COUNCIL_BATCH_SIZE paid models,
 * or a single free-tier model. Ids that no longer resolve to a roster entry are
 * returned separately so they can be marked failed instead of blocking the queue.
 */
export function takeCouncilBatch(pending: string[], models: ModelInfo[]): { batch: ModelInfo[]; unknown: string[] } {
  const byId = new Map(models.map((m) => [m.id, m]));
  const batch: ModelInfo[] = [];
  const unknown: string[] = [];
  for (const id of pending) {
    const model = byId.get(id);
    if (!model) { unknown.push(id); continue; }
    const isFree = model.tier === "free";
    // A free model always runs alone; a paid batch never absorbs a free model.
    if (batch.length > 0 && (isFree || batch.some((m) => m.tier === "free"))) break;
    batch.push(model);
    if (isFree || batch.length >= COUNCIL_BATCH_SIZE) break;
  }
  return { batch, unknown };
}

async function persistCouncilResult(ctx: StepContext, job: ReviewJob, model: ModelInfo, result: ModelResponse) {
  await ctx.deps.saveResponse(
    job.run_id,
    model.id,
    result.modelName || model.name,
    model.family,
    result.response ?? null,
    result.error ?? null,
    result.timeMs ?? null,
    result.inputTokens ?? null,
    result.outputTokens ?? null,
    result.cost ?? null,
  );
}

async function runCouncilStep(job: ReviewJob, ctx: StepContext): Promise<ReviewJob> {
  const { deps } = ctx;
  const step = cloneStep(job.step);
  let cost = job.cost;
  let batches = 0;

  while (step.pending.length > 0) {
    const elapsed = deps.now() - ctx.startedAt;
    // Leave the tail of the budget for the batch in flight; the next invocation resumes.
    if (elapsed > ctx.budgetMs - BUDGET_TAIL_MS) break;

    // A cancel from the dashboard should stop spend between batches, not after the whole council.
    if (batches > 0) {
      const fresh = await deps.getReviewJob(job.id);
      if (fresh && fresh.status === "cancelled") {
        return deps.updateReviewJob(job.id, { status: "cancelled", step, cost, error: job.error, attempts: job.attempts, lock: "release" });
      }
    }

    const { batch, unknown } = takeCouncilBatch(step.pending, job.models);
    for (const id of unknown) {
      step.pending = step.pending.filter((p) => p !== id);
      step.failed.push(id);
    }
    if (batch.length === 0) continue;

    const results = await deps.fanOut({
      models: batch,
      content: job.content,
      prompt: job.prompt,
      apiKey: ctx.openrouterKey,
      // runId is passed for parity with the browser path; persistence is done
      // explicitly below because the fan-out's own save goes through a relative
      // /api URL that only resolves in a browser.
      runId: job.run_id,
      maxTokens: COUNCIL_MAX_TOKENS,
      context: job.context ?? undefined,
      isAborted: () => false,
      onUpdate: () => {},
      signal: ctx.signal,
    });
    batches++;

    const pendingBefore = step.pending.length;
    for (const model of batch) {
      const result = results.find((r) => r.model === model.id);
      // Cut off by the budget deadline: leave it pending so the next invocation retries it.
      if (!result || result.errorCode === "aborted") continue;
      step.pending = step.pending.filter((p) => p !== model.id);
      if (result.status === "complete") {
        step.done.push(model.id);
        cost += result.cost ?? 0;
      } else {
        step.failed.push(model.id);
      }
      await persistCouncilResult(ctx, job, model, result);
    }

    // Progress is durable after every batch; the lock is extended as a heartbeat.
    await deps.updateReviewJob(job.id, { status: "running", step, cost, error: job.error, attempts: job.attempts, lock: "extend" });

    // A batch that settled nothing (every call aborted) must not be re-run in a tight
    // loop; hand the remainder to the next invocation instead.
    if (step.pending.length === pendingBefore) break;
  }

  if (step.pending.length > 0) {
    return deps.updateReviewJob(job.id, { status: "running", step, cost, error: job.error, attempts: job.attempts, lock: "release" });
  }

  // Council finished: hand over to the judge (fusion) or straight to synthesis (legacy).
  step.phase = job.mode === "fusion" ? "judge" : "synth";
  return deps.updateReviewJob(job.id, { status: "synthesizing", step, cost, error: job.error, attempts: job.attempts, lock: "release" });
}

async function runJudgeStep(job: ReviewJob, ctx: StepContext): Promise<ReviewJob> {
  const { deps } = ctx;
  const responses = toCouncilResponses(await deps.listRunResponses(job.run_id));
  if (responses.length === 0) throw new Error("No completed council responses to judge");

  const judge = await deps.judge({
    openrouterKey: ctx.openrouterKey,
    draft: job.content,
    responses,
    reviewPrompt: job.prompt,
    context: job.context ?? undefined,
    signal: ctx.signal,
  });

  const step: ReviewJobStep = { ...cloneStep(job.step), judge, phase: "synth" };
  return deps.updateReviewJob(job.id, { status: "synthesizing", step, cost: job.cost, error: job.error, attempts: job.attempts, lock: "release" });
}

async function runSynthStep(job: ReviewJob, ctx: StepContext): Promise<ReviewJob> {
  const { deps } = ctx;
  let modelId: string;
  let result: unknown;

  if (job.mode === "fusion") {
    if (!job.step.judge) throw new Error("Fusion synthesis reached without a judge result");
    modelId = SYNTHESIZER_MODEL_ID;
    result = await deps.synthesizeFusion({
      openrouterKey: ctx.openrouterKey,
      judge: job.step.judge,
      draft: job.content,
      signal: ctx.signal,
    });
  } else {
    const responses = toCouncilResponses(await deps.listRunResponses(job.run_id));
    if (responses.length === 0) throw new Error("No completed council responses to synthesize");
    modelId = OPENROUTER_SYNTHESIS_MODEL_ID;
    result = await deps.synthesizeLegacy({
      openrouterKey: ctx.openrouterKey,
      content: job.content,
      analysisPrompt: job.prompt,
      responses,
      context: job.context ?? undefined,
      signal: ctx.signal,
    });
  }

  await deps.saveSynthesis(job.run_id, JSON.stringify(result), modelId);
  const step: ReviewJobStep = { ...cloneStep(job.step), phase: "done" };
  return deps.updateReviewJob(job.id, { status: "completed", step, cost: job.cost, error: null, attempts: job.attempts, lock: "release" });
}

/**
 * Advance a claimed job by one step and persist the outcome. Never throws: a step
 * failure is recorded on the row (attempts++, error) and the job is left for the
 * next invocation until MAX_JOB_ATTEMPTS, when it is marked failed.
 */
export async function advanceJob(job: ReviewJob, options: AdvanceJobOptions): Promise<ReviewJob> {
  const deps: JobDeps = { ...defaultJobDeps, ...options.deps };

  // Cancelled/completed/failed jobs are never advanced, even if a stale claim hands one over.
  if (!isActiveJobStatus(job.status)) return job;

  if (!options.openrouterKey) {
    return deps.updateReviewJob(job.id, {
      status: "failed",
      step: job.step,
      cost: job.cost,
      error: "OPENROUTER_API_KEY is not set on the server; server-side runs need a server key",
      attempts: job.attempts + 1,
      lock: "release",
    });
  }

  const deadline = createDeadline(options.budgetMs);
  const ctx: StepContext = { deps, openrouterKey: options.openrouterKey, budgetMs: options.budgetMs, startedAt: deps.now(), signal: deadline.signal };

  try {
    switch (job.step.phase) {
      case "council":
        return await runCouncilStep(job, ctx);
      case "judge":
        return await runJudgeStep(job, ctx);
      case "synth":
        return await runSynthStep(job, ctx);
      case "done":
        // Defensive: the synthesis was saved but the status write was lost. Close it out.
        return await deps.updateReviewJob(job.id, { status: "completed", step: job.step, cost: job.cost, error: null, attempts: job.attempts, lock: "release" });
      default:
        throw new Error(`Unknown job phase: ${String(job.step.phase)}`);
    }
  } catch (error) {
    const attempts = job.attempts + 1;
    const message = error instanceof Error ? error.message : String(error);
    // Whatever progress the step wrote before throwing is already on the row; re-read
    // it so the failure record does not roll a partial council back to the old step.
    const latest = (await deps.getReviewJob(job.id).catch(() => null)) ?? job;
    return deps.updateReviewJob(job.id, {
      status: attempts >= MAX_JOB_ATTEMPTS ? "failed" : latest.status,
      step: latest.step,
      cost: latest.cost,
      error: message,
      attempts,
      lock: "release",
    });
  } finally {
    deadline.clear();
  }
}
