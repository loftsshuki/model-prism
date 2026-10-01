import { afterEach, describe, expect, test } from "bun:test";
import { ZodError, z } from "zod";
import { requestCompletion, ProviderError } from "./openrouter-client";
import { affordableOutputTokens, BudgetExceededError, requiredRunBudget, RunBudget, SYNTHESIS_MIN_TOKENS } from "./run-budget";
import { executeReview, type ReviewOptions } from "./review-engine";
import { getCouncilModels, getModel, SNAPSHOT_MODELS, SYNTHESIS_IDS, COUNCIL_MAX_TOKENS, SYNTHESIS_MAX_TOKENS } from "./model-catalog";
import { DEFAULT_RUN_PRESETS, selectModelsForPreset } from "./run-presets";
import { validateSynthesis } from "./synthesis";
import { fitSources, MAX_SOURCES, type SourceDocument } from "./review-policy";
import { CheckpointSchema, type RunCheckpoint } from "./run-checkpoint";
import { normalizeFindings, reviewDisposition } from "./review-fabric/service-contract";
import { reviewError, publicErrorMessage } from "./server/http";
import { ReviewConflict } from "./server/background-store";
import type { ModelInfo } from "./types";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const fable = getModel(SYNTHESIS_IDS.fable, SNAPSHOT_MODELS)!;
const councilAnswer = "## Review\n- The plan has no rollback step for the migration.";
const validSynthesis = { masterDocument: "# Master", findings: [], consensus: [], uniqueInsights: [], disagreements: [], blindSpots: [], themeMatrix: [] };

/** Mock OpenRouter: council answers in prose, synthesizer answers with a tool call. Records max_tokens sent. */
function mockProvider(sent: Array<{ model: string; max_tokens: number; tools: boolean }>, synthesisArgs: unknown = validSynthesis) {
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sent.push({ model: body.model, max_tokens: body.max_tokens, tools: Boolean(body.tools) });
    if (body.tools) return new Response(JSON.stringify({ model: body.model, choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "t", type: "function", function: { name: "synthesis", arguments: JSON.stringify(synthesisArgs) } }] } }], usage: { prompt_tokens: 4000, completion_tokens: 900, cost: 0.06 } }));
    return new Response(JSON.stringify({ model: body.model, choices: [{ finish_reason: "stop", message: { content: councilAnswer } }], usage: { prompt_tokens: 2000, completion_tokens: 800, cost: 0.02 } }));
  }) as typeof fetch;
}

function presetOptions(presetIndex: number, extra: Partial<ReviewOptions> = {}): ReviewOptions {
  const preset = DEFAULT_RUN_PRESETS[presetIndex];
  const models = [...selectModelsForPreset(SNAPSHOT_MODELS, preset.modelPreset)].map((id) => getModel(id, SNAPSHOT_MODELS)!);
  return {
    content: "# Plan\n" + "Step: migrate the bookings table.\n".repeat(100), prompt: preset.prompt, context: "", reasoningEffort: "medium",
    apiKey: "sk-or-test", models, catalog: SNAPSHOT_MODELS, synthesisModel: SYNTHESIS_IDS[preset.synthesisModel],
    maxCost: preset.maxCost, maxTokens: COUNCIL_MAX_TOKENS, synthesisMaxTokens: SYNTHESIS_MAX_TOKENS, allowPaidFallback: false,
    signal: new AbortController().signal, onChange: () => {}, ...extra,
  };
}

describe("default budgets can pay for synthesis", () => {
  test("every built-in preset completes with its default cap and the full synthesis output", async () => {
    for (let index = 0; index < DEFAULT_RUN_PRESETS.length; index++) {
      const sent: Array<{ model: string; max_tokens: number; tools: boolean }> = [];
      mockProvider(sent);
      const run = await executeReview(presetOptions(index));
      expect({ preset: DEFAULT_RUN_PRESETS[index].id, status: run.status, error: run.error }).toEqual({ preset: DEFAULT_RUN_PRESETS[index].id, status: "complete", error: undefined });
      expect(sent.find((call) => call.tools)?.max_tokens).toBe(SYNTHESIS_MAX_TOKENS);
    }
  });

  test("each preset cap covers the reservations it needs", () => {
    for (const preset of DEFAULT_RUN_PRESETS) {
      const reviewers = [...selectModelsForPreset(SNAPSHOT_MODELS, preset.modelPreset)].map((id) => getModel(id, SNAPSHOT_MODELS)!);
      const need = requiredRunBudget({ reviewers, synthesizer: getModel(SYNTHESIS_IDS[preset.synthesisModel], SNAPSHOT_MODELS), inputText: preset.prompt + "x".repeat(20_000), maxTokens: COUNCIL_MAX_TOKENS, synthesisMaxTokens: SYNTHESIS_MAX_TOKENS });
      expect(need.total).toBeLessThanOrEqual(preset.maxCost);
    }
  });

  test("a tight cap shrinks the synthesis output instead of discarding the paid council", async () => {
    const sent: Array<{ model: string; max_tokens: number; tools: boolean }> = [];
    mockProvider(sent);
    const run = await executeReview(presetOptions(0, { maxCost: 1.5 }));
    expect(run.status).toBe("complete");
    const synthTokens = sent.find((call) => call.tools)!.max_tokens;
    expect(synthTokens).toBeLessThan(SYNTHESIS_MAX_TOKENS);
    expect(synthTokens).toBeGreaterThanOrEqual(SYNTHESIS_MIN_TOKENS);
  });

  test("a cap below the synthesis floor explains the shortfall in dollars", async () => {
    mockProvider([]);
    const run = await executeReview(presetOptions(0, { maxCost: 0.3 }));
    expect(run.status).toBe("error");
    expect(run.error).toMatch(/needs up to \$\d+\.\d\d .* only \$\d+\.\d\d of the spending limit is left/);
  });

  test("affordable output and nested budgets", () => {
    const parent = new RunBudget(1);
    const child = new RunBudget(5, [], parent);
    expect(child.available()).toBe(1);
    expect(affordableOutputTokens(fable, [{ role: "user", content: "x" }], 0.5)).toBeLessThan(10_000);
    expect(() => new RunBudget(0.1).reserve("a", 0.2)).toThrow(BudgetExceededError);
    expect(() => new RunBudget(0.1).reserve("a", 0.2)).toThrow(/only \$0\.10/);
  });
});

describe("spending survives a reload", () => {
  test("a reservation is checkpointed before the request is sent", async () => {
    const snapshots: RunCheckpoint[] = [];
    let sawReservedWhileInFlight = false;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      // While this request is in flight, the latest checkpoint must already hold its reservation.
      sawReservedWhileInFlight ||= snapshots.at(-1)!.usage.some((usage) => usage.costSource === "reserved" && usage.model === body.model);
      if (body.tools) return new Response(JSON.stringify({ model: body.model, choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "t", type: "function", function: { name: "synthesis", arguments: JSON.stringify(validSynthesis) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.01 } }));
      return new Response(JSON.stringify({ model: body.model, choices: [{ finish_reason: "stop", message: { content: councilAnswer } }], usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.01 } }));
    }) as typeof fetch;
    const models = getCouncilModels("balanced").slice(0, 2);
    const run = await executeReview({ ...presetOptions(0), models, onChange: (snapshot, checkpoint) => { if (checkpoint) snapshots.push(snapshot); } });
    expect(sawReservedWhileInFlight).toBe(true);
    expect(run.usage.every((usage) => usage.costSource === "provider")).toBe(true); // settled records replaced the reservations
  });
});

describe("provider timeout", () => {
  test("our own deadline is reported as a provider failure, not a user stop", async () => {
    const model = getCouncilModels("balanced")[0];
    const fetchImpl = ((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as typeof fetch;
    const budget = new RunBudget(5);
    const error = await requestCompletion({ apiKey: "k", model, messages: [{ role: "user", content: "hi" }], maxTokens: 100, maxAttempts: 1, fetchImpl, timeoutMs: 20, budget }).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.message).toMatch(/did not finish within/);
    expect(budget.spent).toBeGreaterThan(0); // the ceiling stays recorded: the provider may still bill
  });
});

describe("tolerant synthesis validation", () => {
  test("bad enums, out-of-range scores, and empty quotes no longer discard the synthesis", () => {
    const result = validateSynthesis({
      masterDocument: "# Master",
      findings: [{ id: "1", title: "", severity: "info", recommendation: "Add a rollback", supportingModels: ["model:a"], evidence: [{ source: "content", quote: "" }] }],
      consensus: [{ point: "Agree", supportingModels: ["a"], strength: "very strong" }],
      uniqueInsights: [{ model: "a", insight: "Gold" }],
      disagreements: [{ topic: "T", positions: [{ models: ["a"], position: "P" }] }],
      blindSpots: ["B"],
      themeMatrix: [{ theme: "Risk", scores: { a: 7, b: "2" } }],
    }, { content: "plan" });
    expect(result.findings?.[0]).toMatchObject({ severity: "low", title: "Add a rollback", evidence: [] });
    expect(result.consensus[0].strength).toBe("moderate");
    expect(result.uniqueInsights[0].significance).toBe("medium");
    expect(result.themeMatrix?.[0].scores).toEqual({ a: 3, b: 2 });
  });

  test("a synthesis without a master document is still rejected", () => {
    expect(() => validateSynthesis({ masterDocument: "  ", findings: [] })).toThrow();
  });
});

describe("source limits", () => {
  const source = (index: number, text = "line\n"): SourceDocument => ({ id: `file:src/f${index}.ts`, path: `src/f${index}.ts`, text });

  test("more than 100 files are trimmed so the run stays saveable", () => {
    const { sources, dropped } = fitSources(Array.from({ length: 130 }, (_, index) => source(index)));
    expect(sources).toHaveLength(MAX_SOURCES);
    expect(dropped).toBe(30);
    const checkpoint = { version: 1, id: "run_x", revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), content: "c", prompt: "p", context: "", reasoningEffort: "medium", status: "complete", models: [], responses: [], usage: [], synthesisModel: "m", maxCost: 1, maxTokens: 100, synthesisMaxTokens: 100, sources };
    expect(CheckpointSchema.safeParse(checkpoint).success).toBe(true);
  });

  test("the total character limit is respected", () => {
    const big = "x".repeat(400_000);
    const { sources, dropped } = fitSources(Array.from({ length: 5 }, (_, index) => source(index, big)));
    expect(sources).toHaveLength(3);
    expect(dropped).toBe(2);
  });
});

describe("service verdict never fails open", () => {
  test("a synthesis without a findings list is inconclusive", () => {
    expect(reviewDisposition("complete", { masterDocument: "## Critical: auth is missing", disagreements: [], blindSpots: [] })).toBe("inconclusive");
  });

  test("a critical finding with an empty recommendation still requires revision", () => {
    const synthesis = { masterDocument: "m", findings: [{ title: "Auth missing on delete", severity: "critical", recommendation: "" }], disagreements: [], blindSpots: [] };
    expect(normalizeFindings(synthesis).findingCounts.critical).toBe(1);
    expect(reviewDisposition("complete", synthesis)).toBe("material_revision_required");
  });

  test("an empty, explicit findings list with no concerns is still no objection", () => {
    expect(reviewDisposition("complete", { masterDocument: "m", findings: [], disagreements: [], blindSpots: [] })).toBe("no_material_objection");
  });
});

describe("error statuses", () => {
  test("validation is 400, permanent conflicts keep their status, unknown errors are 503", async () => {
    let zodError: ZodError | null = null;
    try { z.object({ id: z.string() }).parse({}); } catch (error) { zodError = error as ZodError; }
    expect(reviewError(zodError).status).toBe(400);
    expect(reviewError(new ReviewConflict("Review not found", 404)).status).toBe(404);
    expect(reviewError(new ReviewConflict("Agent review access is not enabled.", 403)).status).toBe(403);
    expect(reviewError(new BudgetExceededError()).status).toBe(409);
    expect(reviewError(new Error("connection reset")).status).toBe(503);
  });

  test("tool callers never see internal error text", () => {
    expect(publicErrorMessage(new Error("DATABASE_URL environment variable is not set"))).not.toMatch(/DATABASE_URL/);
    expect(publicErrorMessage(new ReviewConflict("Review not found", 404))).toBe("Review not found");
  });
});

describe("requiredRunBudget", () => {
  test("counts only the four largest overlapping reviewer reservations", () => {
    const reviewers: ModelInfo[] = getCouncilModels("frontier");
    const one = requiredRunBudget({ reviewers: reviewers.slice(0, 1), inputText: "x", maxTokens: 1000, synthesisMaxTokens: 1000 });
    const all = requiredRunBudget({ reviewers, inputText: "x", maxTokens: 1000, synthesisMaxTokens: 1000 });
    expect(all.council).toBeGreaterThan(one.council);
    expect(all.synthesis).toBe(0); // no synthesizer given
  });
});
