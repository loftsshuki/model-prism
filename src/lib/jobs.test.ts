import { describe, it, expect } from "bun:test";
import { MAX_JOB_ATTEMPTS, advanceJob, takeCouncilBatch, toCouncilResponses } from "./jobs";
import type { JobDeps } from "./jobs";
import { OPENROUTER_SYNTHESIS_MODEL_ID } from "./synthesis";
import { SYNTHESIZER_MODEL_ID } from "./fusion";
import type { JudgeResult } from "./fusion";
import type { ReviewJob, ReviewJobPatch, ReviewJobStep } from "./job-types";
import type { ModelInfo, ModelResponse } from "./types";

// The step machine is exercised with an in-memory "database" and fake model calls:
// no real DB, no network. Every side effect is injected through `deps`.

function paid(id: string): ModelInfo {
  return { id, name: id.toUpperCase(), family: id.split("/")[0], tier: "fast", contextLength: 100_000, inputCostPer1k: 0.001, outputCostPer1k: 0.002 };
}
function free(id: string): ModelInfo {
  return { ...paid(id), tier: "free", inputCostPer1k: 0, outputCostPer1k: 0 };
}

const JUDGE = { schemaVersion: "2", consensus: [], contradictions: [], partial_coverage: [], unique_insights: [], blind_spots: [], evidence: [], strategic_blind_spots: [], locked_decisions: [] } as unknown as JudgeResult;

function makeJob(models: ModelInfo[], overrides: Partial<ReviewJob> = {}): ReviewJob {
  return {
    id: "job_1",
    status: "running",
    content: "the plan",
    prompt: "review it",
    models,
    mode: "legacy",
    run_id: "run_1",
    context: null,
    step: { pending: models.map((m) => m.id), done: [], failed: [], phase: "council" },
    cost: 0,
    error: null,
    attempts: 0,
    locked_until: null,
    created_at: "2026-09-02T00:00:00.000Z",
    updated_at: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

interface Harness {
  deps: JobDeps;
  /** Every patch written, in order. */
  patches: ReviewJobPatch[];
  /** Every saveResponse call (run, model, name, family, response, error, ...). */
  saved: unknown[][];
  syntheses: Array<{ runId: string; result: string; modelId: string }>;
  fanOutCalls: ModelInfo[][];
  /** Advance the fake clock by this much on every fanOut call. */
  msPerFanOut: number;
  /** Current job row as the fake DB sees it. */
  row: ReviewJob;
  setRow(row: ReviewJob): void;
}

function harness(job: ReviewJob, overrides: Partial<JobDeps> = {}): Harness {
  let clock = 0;
  const h: Partial<Harness> = { patches: [], saved: [], syntheses: [], fanOutCalls: [], msPerFanOut: 0, row: job };
  h.setRow = (row) => { h.row = row; };
  h.deps = {
    fanOut: async ({ models }) => {
      h.fanOutCalls!.push(models);
      clock += h.msPerFanOut!;
      return models.map<ModelResponse>((m) => ({ model: m.id, modelName: m.name, status: "complete", response: `review by ${m.id}`, cost: 0.01, timeMs: 5, inputTokens: 10, outputTokens: 20 }));
    },
    judge: async () => JUDGE,
    synthesizeLegacy: async () => ({ masterDocument: "legacy doc", consensus: [], uniqueInsights: [], disagreements: [], blindSpots: [], recommendations: [] }) as never,
    synthesizeFusion: async () => ({ masterDocument: "fusion doc", consensus: [], uniqueInsights: [], disagreements: [], blindSpots: [], recommendations: [] }) as never,
    saveResponse: async (...args) => { h.saved!.push(args); },
    saveSynthesis: async (runId, result, modelId) => { h.syntheses!.push({ runId, result, modelId }); },
    listRunResponses: async () => [
      { model: "a/one", model_name: "ONE", base_architecture: "a", response: "review by a/one", error: null, cost: 0.01, time_ms: 5, created_at: null },
      { model: "b/two", model_name: "TWO", base_architecture: "b", response: null, error: "boom", cost: null, time_ms: null, created_at: null },
    ],
    updateReviewJob: async (id, patch) => {
      h.patches!.push(patch);
      // Mirrors the real helper: a cancelled row stays cancelled whatever a step writes.
      const status = h.row!.status === "cancelled" ? "cancelled" : patch.status;
      const next: ReviewJob = { ...h.row!, id, status, step: patch.step, cost: patch.cost, error: patch.error, attempts: patch.attempts, locked_until: patch.lock === "extend" ? "soon" : null };
      h.row = next;
      return next;
    },
    getReviewJob: async () => h.row!,
    now: () => clock,
    ...overrides,
  };
  return h as Harness;
}

const BUDGET = 240_000;

describe("takeCouncilBatch", () => {
  it("takes two paid models at a time", () => {
    const models = [paid("a/one"), paid("b/two"), paid("c/three")];
    expect(takeCouncilBatch(models.map((m) => m.id), models).batch.map((m) => m.id)).toEqual(["a/one", "b/two"]);
  });

  it("runs a free model alone and never mixes it into a paid batch", () => {
    const models = [paid("a/one"), free("x/free"), paid("b/two")];
    expect(takeCouncilBatch(["x/free", "a/one"], models).batch.map((m) => m.id)).toEqual(["x/free"]);
    expect(takeCouncilBatch(["a/one", "x/free", "b/two"], models).batch.map((m) => m.id)).toEqual(["a/one"]);
  });

  it("reports ids missing from the roster so they can be failed instead of blocking", () => {
    const { batch, unknown } = takeCouncilBatch(["ghost", "a/one"], [paid("a/one")]);
    expect(unknown).toEqual(["ghost"]);
    expect(batch.map((m) => m.id)).toEqual(["a/one"]);
  });
});

describe("toCouncilResponses", () => {
  it("drops error rows and empty bodies, defaults name and family", () => {
    const rows = [
      { model: "a/one", model_name: null, base_architecture: null, response: "ok", error: null },
      { model: "b/two", model_name: "TWO", base_architecture: "b", response: "   ", error: null },
      { model: "c/three", model_name: "THREE", base_architecture: "c", response: "x", error: "failed" },
    ];
    expect(toCouncilResponses(rows)).toEqual([{ model: "a/one", modelName: "a/one", family: "unknown", response: "ok" }]);
  });
});

describe("advanceJob — council phase", () => {
  it("invokes models in batches, saves each response, accumulates cost, then hands over to synth (legacy)", async () => {
    const models = [paid("a/one"), paid("b/two"), paid("c/three")];
    const job = makeJob(models);
    const h = harness(job);

    const result = await advanceJob(job, { openrouterKey: "sk", budgetMs: BUDGET, deps: h.deps });

    expect(h.fanOutCalls.map((b) => b.map((m) => m.id))).toEqual([["a/one", "b/two"], ["c/three"]]);
    expect(h.saved.length).toBe(3);
    expect(h.saved[0].slice(0, 5)).toEqual(["run_1", "a/one", "A/ONE", "a", "review by a/one"]);
    expect(result.step).toEqual({ pending: [], done: ["a/one", "b/two", "c/three"], failed: [], phase: "synth" });
    expect(result.status).toBe("synthesizing");
    expect(result.cost).toBeCloseTo(0.03, 6);
    // Progress was written after every batch with the lock held, and released at the end.
    expect(h.patches.map((p) => p.lock)).toEqual(["extend", "extend", "release"]);
  });

  it("hands over to the judge phase for fusion jobs", async () => {
    const job = makeJob([paid("a/one")], { mode: "fusion" });
    const h = harness(job);
    const result = await advanceJob(job, { openrouterKey: "sk", budgetMs: BUDGET, deps: h.deps });
    expect(result.step.phase).toBe("judge");
    expect(result.status).toBe("synthesizing");
  });

  it("stops taking new batches once the budget tail is reached and leaves the rest pending", async () => {
    const models = [paid("a/one"), paid("b/two"), paid("c/three"), paid("d/four"), paid("e/five"), paid("f/six")];
    const job = makeJob(models);
    const h = harness(job);
    h.msPerFanOut = 100_000; // each batch "takes" 100s; budget 240s − 60s tail = 180s cutoff

    const result = await advanceJob(job, { openrouterKey: "sk", budgetMs: BUDGET, deps: h.deps });

    expect(h.fanOutCalls.length).toBe(2); // 0s ok, 100s ok, 200s > 180s → stop
    expect(result.step.done).toEqual(["a/one", "b/two", "c/three", "d/four"]);
    expect(result.step.pending).toEqual(["e/five", "f/six"]);
    expect(result.step.phase).toBe("council");
    expect(result.status).toBe("running");
    expect(h.patches.at(-1)?.lock).toBe("release");
  });

  it("marks errored models failed (with their error row saved) and keeps aborted ones pending", async () => {
    const models = [paid("a/one"), paid("b/two")];
    const job = makeJob(models);
    const h = harness(job, {
      fanOut: async ({ models: batch }) => batch.map<ModelResponse>((m) => (
        m.id === "a/one"
          ? { model: m.id, modelName: m.name, status: "error", error: "503 no healthy upstream", errorCode: "server" }
          : { model: m.id, modelName: m.name, status: "error", error: "Stopped", errorCode: "aborted" }
      )),
    });
    // The override does not advance the clock: the step must still stop after a batch
    // that settled nothing, instead of re-invoking the aborted model in a tight loop.

    const result = await advanceJob(job, { openrouterKey: "sk", budgetMs: BUDGET, deps: h.deps });

    expect(result.step.failed).toEqual(["a/one"]);
    expect(result.step.pending).toEqual(["b/two"]);
    expect(h.saved.length).toBe(1);
    expect(h.saved[0][5]).toBe("503 no healthy upstream");
    expect(result.status).toBe("running");
  });

  it("free-tier models run one per batch", async () => {
    const models = [free("x/free"), free("y/free"), paid("a/one")];
    const job = makeJob(models);
    const h = harness(job);
    await advanceJob(job, { openrouterKey: "sk", budgetMs: BUDGET, deps: h.deps });
    expect(h.fanOutCalls.map((b) => b.map((m) => m.id))).toEqual([["x/free"], ["y/free"], ["a/one"]]);
  });

  it("stops between batches when the job was cancelled meanwhile", async () => {
    const models = [paid("a/one"), paid("b/two"), paid("c/three")];
    const job = makeJob(models);
    const h = harness(job);
    const realFanOut = h.deps.fanOut;
    h.deps.fanOut = async (params) => {
      const out = await realFanOut(params);
      h.setRow({ ...h.row, status: "cancelled" }); // Cancel arrives while the batch is in flight
      return out;
    };

    const result = await advanceJob(job, { openrouterKey: "sk", budgetMs: BUDGET, deps: h.deps });

    expect(h.fanOutCalls.length).toBe(1);
    expect(result.status).toBe("cancelled");
    expect(result.step.done).toEqual(["a/one", "b/two"]);
    expect(result.step.pending).toEqual(["c/three"]);
  });
});

describe("advanceJob — judge and synth phases", () => {
  it("judge: loads saved responses, stashes the judge output, moves to synth", async () => {
    const job = makeJob([paid("a/one"), paid("b/two")], { mode: "fusion", status: "synthesizing", step: { pending: [], done: ["a/one"], failed: ["b/two"], phase: "judge" } });
    let judgeInput: unknown = null;
    const h = harness(job, { judge: async (opts) => { judgeInput = opts; return JUDGE; } });

    const result = await advanceJob(job, { openrouterKey: "sk", budgetMs: BUDGET, deps: h.deps });

    // Only the completed response reaches the judge; the errored row is dropped.
    expect((judgeInput as { responses: unknown[] }).responses).toEqual([{ model: "a/one", modelName: "ONE", family: "a", response: "review by a/one" }]);
    expect((judgeInput as { draft: string; reviewPrompt: string }).draft).toBe("the plan");
    expect((judgeInput as { reviewPrompt: string }).reviewPrompt).toBe("review it");
    expect(result.step.phase).toBe("synth");
    expect(result.step.judge).toEqual(JUDGE);
    expect(result.status).toBe("synthesizing");
    expect(h.syntheses.length).toBe(0);
  });

  it("synth (legacy): synthesizes from saved responses and completes the job", async () => {
    const job = makeJob([paid("a/one")], { status: "synthesizing", step: { pending: [], done: ["a/one"], failed: [], phase: "synth" } });
    const h = harness(job);

    const result = await advanceJob(job, { openrouterKey: "sk", budgetMs: BUDGET, deps: h.deps });

    expect(h.syntheses).toEqual([{ runId: "run_1", result: JSON.stringify({ masterDocument: "legacy doc", consensus: [], uniqueInsights: [], disagreements: [], blindSpots: [], recommendations: [] }), modelId: OPENROUTER_SYNTHESIS_MODEL_ID }]);
    expect(result.status).toBe("completed");
    expect(result.step.phase).toBe("done");
    expect(result.error).toBeNull();
    expect(h.patches.at(-1)?.lock).toBe("release");
  });

  it("synth (fusion): uses the stashed judge, never the legacy synthesizer", async () => {
    const step: ReviewJobStep = { pending: [], done: ["a/one"], failed: [], phase: "synth", judge: JUDGE };
    const job = makeJob([paid("a/one")], { mode: "fusion", status: "synthesizing", step });
    let legacyCalls = 0;
    let fusionJudge: unknown = null;
    const h = harness(job, {
      synthesizeLegacy: async () => { legacyCalls++; return { masterDocument: "no" } as never; },
      synthesizeFusion: async (opts) => { fusionJudge = opts.judge; return { masterDocument: "fusion doc" } as never; },
    });

    const result = await advanceJob(job, { openrouterKey: "sk", budgetMs: BUDGET, deps: h.deps });

    expect(legacyCalls).toBe(0);
    expect(fusionJudge).toEqual(JUDGE);
    expect(h.syntheses[0].modelId).toBe(SYNTHESIZER_MODEL_ID);
    expect(result.status).toBe("completed");
  });

  it("synth (fusion) without a stashed judge is a recorded failure, not a crash", async () => {
    const job = makeJob([paid("a/one")], { mode: "fusion", status: "synthesizing", step: { pending: [], done: ["a/one"], failed: [], phase: "synth" } });
    const h = harness(job);
    const result = await advanceJob(job, { openrouterKey: "sk", budgetMs: BUDGET, deps: h.deps });
    expect(result.attempts).toBe(1);
    expect(result.error).toContain("judge");
    expect(result.status).toBe("synthesizing");
  });
});

describe("advanceJob — failures and no-ops", () => {
  it("a thrown step increments attempts, keeps the status, releases the lock; the third failure marks the job failed", async () => {
    let job = makeJob([paid("a/one")], { status: "synthesizing", step: { pending: [], done: ["a/one"], failed: [], phase: "synth" } });
    const h = harness(job, { synthesizeLegacy: async () => { throw new Error("upstream 502"); } });

    for (let i = 1; i < MAX_JOB_ATTEMPTS; i++) {
      job = await advanceJob(job, { openrouterKey: "sk", budgetMs: BUDGET, deps: h.deps });
      expect(job.attempts).toBe(i);
      expect(job.status).toBe("synthesizing");
      expect(job.error).toBe("upstream 502");
      expect(h.patches.at(-1)?.lock).toBe("release");
    }
    job = await advanceJob(job, { openrouterKey: "sk", budgetMs: BUDGET, deps: h.deps });
    expect(job.attempts).toBe(MAX_JOB_ATTEMPTS);
    expect(job.status).toBe("failed");
  });

  it("a failure mid-council keeps the batches that already completed", async () => {
    const models = [paid("a/one"), paid("b/two"), paid("c/three")];
    const job = makeJob(models);
    const h = harness(job);
    const realFanOut = h.deps.fanOut;
    h.deps.fanOut = async (params) => {
      if (h.fanOutCalls.length === 1) throw new Error("network down");
      return realFanOut(params);
    };

    const result = await advanceJob(job, { openrouterKey: "sk", budgetMs: BUDGET, deps: h.deps });

    expect(result.attempts).toBe(1);
    expect(result.status).toBe("running");
    expect(result.step.done).toEqual(["a/one", "b/two"]);
    expect(result.step.pending).toEqual(["c/three"]);
    expect(result.error).toBe("network down");
  });

  it("a cancelled job is a no-op: nothing is invoked or written", async () => {
    const job = makeJob([paid("a/one")], { status: "cancelled" });
    const h = harness(job);
    const result = await advanceJob(job, { openrouterKey: "sk", budgetMs: BUDGET, deps: h.deps });
    expect(result).toBe(job);
    expect(h.fanOutCalls.length).toBe(0);
    expect(h.patches.length).toBe(0);
  });

  it("completed and failed jobs are no-ops too", async () => {
    for (const status of ["completed", "failed"] as const) {
      const job = makeJob([paid("a/one")], { status });
      const h = harness(job);
      expect(await advanceJob(job, { openrouterKey: "sk", budgetMs: BUDGET, deps: h.deps })).toBe(job);
      expect(h.patches.length).toBe(0);
    }
  });

  it("a missing server key fails the job with a clear error and spends nothing", async () => {
    const job = makeJob([paid("a/one")]);
    const h = harness(job);
    const result = await advanceJob(job, { openrouterKey: undefined, budgetMs: BUDGET, deps: h.deps });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("OPENROUTER_API_KEY");
    expect(h.fanOutCalls.length).toBe(0);
  });
});
