import { afterEach, describe, expect, test } from "bun:test";
import { requestCompletion, ProviderError, sleepWithSignal } from "./openrouter-client";
import { RunBudget, BudgetExceededError } from "./run-budget";
import { executeReview, type ReviewOptions } from "./review-engine";
import { checkpointCost, sameReviewInput, type RunCheckpoint } from "./run-checkpoint";
import { getCouncilModels, getModel, SYNTHESIS_IDS, normalizeCatalog, isTextModel } from "./model-catalog";
import { checkModelFreshness } from "./model-freshness";
import { analyzeReviewQuality } from "./review-analysis";
import { validateSynthesis } from "./synthesis";
import { getModelsFilteredByContext } from "./model-registry";
import { fanOut } from "./fan-out";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const models = getCouncilModels("balanced").slice(0, 2);
const synthesis = { masterDocument: "No critical security blocker found.", findings: [], consensus: [], uniqueInsights: [], disagreements: [], blindSpots: [], themeMatrix: [] };
function reply(content = "A complete answer", finish = "stop", cost = 0.02) { return new Response(JSON.stringify({ model: models[0].id, choices: [{ finish_reason: finish, message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 50, cost } }), { headers: { "Content-Type": "application/json" } }); }
function options(extra: Partial<ReviewOptions> = {}): ReviewOptions { return { content: "Plan A", prompt: "Review this plan", context: "", reasoningEffort: "medium", apiKey: "test", models, catalog: models, synthesisModel: SYNTHESIS_IDS.sonnet, maxCost: 5, maxTokens: 8192, synthesisMaxTokens: 16384, allowPaidFallback: false, signal: new AbortController().signal, onChange: () => {}, ...extra }; }
function mockCouncil(calls: Array<{ model: string; messages: unknown[] }>) {
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)); calls.push(body);
    if (body.tools) return new Response(JSON.stringify({ model: SYNTHESIS_IDS.sonnet, choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "tool", type: "function", function: { name: "synthesis", arguments: JSON.stringify(synthesis) } }] } }], usage: { prompt_tokens: 100, completion_tokens: 200, cost: 0.05 } }));
    return new Response(JSON.stringify({ model: body.model, choices: [{ finish_reason: "stop", message: { content: String(body.messages.at(-1).content) } }], usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.02 } }));
  }) as typeof fetch;
}

describe("run identity, cancellation, and spending", () => {
  test("edited content, instructions, context, or effort creates a new identity", () => {
    const a = options();
    for (const key of ["content", "prompt", "context", "reasoningEffort"] as const) expect(sameReviewInput(a, { ...a, [key]: "changed" })).toBe(false);
  });
  test("resume skips completed council work; edits get a new run and fresh responses", async () => {
    const calls: Array<{ model: string; messages: unknown[] }> = []; mockCouncil(calls);
    const a = await executeReview(options()); expect(a.status).toBe("complete"); expect(calls).toHaveLength(3); expect(checkpointCost(a)).toBeCloseTo(0.09);
    const resumed = await executeReview(options({ previous: a })); expect(resumed.id).toBe(a.id); expect(calls).toHaveLength(3);
    const b = await executeReview(options({ previous: a, content: "Plan B" })); expect(b.id).not.toBe(a.id); expect(b.responses.every((response) => response.response?.includes("Plan B"))).toBe(true); expect(checkpointCost(b)).toBeCloseTo(0.09);
  });
  test("stop aborts requests and cannot trigger synthesis", async () => {
    const controller = new AbortController(); let requests = 0; let latest: RunCheckpoint | undefined;
    globalThis.fetch = (async (_url, init) => { requests++; await sleepWithSignal(10000, init?.signal ?? undefined); return reply(); }) as typeof fetch;
    const promise = executeReview(options({ signal: controller.signal, onChange: (run) => { latest = run; } }));
    await new Promise((resolve) => setTimeout(resolve, 20)); controller.abort();
    const run = await promise; expect(run.status).toBe("stopped"); expect(requests).toBe(2); expect(run.synthesis).toBeUndefined(); expect(latest?.responses.every((response) => response.status === "cancelled")).toBe(true);
    expect(run.usage.every((usage) => usage.costSource === "reserved")).toBe(true);
  });
  test("a failed synthesis resumes without repeating completed reviewers", async () => {
    const calls: Array<{ model: string; messages: unknown[] }> = []; mockCouncil(calls);
    const normal = globalThis.fetch;
    globalThis.fetch = (async (url, init) => JSON.parse(String(init?.body)).tools ? new Response("insufficient credits", { status: 402 }) : normal(url, init)) as typeof fetch;
    const first = await executeReview(options()); expect(first.status).toBe("error"); expect(first.responses.every((response) => response.status === "complete")).toBe(true);
    globalThis.fetch = normal;
    const resumed = await executeReview(options({ previous: first })); expect(resumed.status).toBe("complete"); expect(calls.filter((call) => call.model !== SYNTHESIS_IDS.sonnet)).toHaveLength(2);
  });
  test("concurrent reservations and nested budgets prevent overspending; usage saves deduplicate", () => {
    const root = new RunBudget(1), child = new RunBudget(0.8, [], root);
    child.reserve("a", 0.6); expect(() => root.reserve("b", 0.5)).toThrow(BudgetExceededError);
    const record = { requestId: "a", model: "test", cost: 0.2, inputTokens: 1, outputTokens: 1, costSource: "provider" as const };
    child.settle("a", record); child.settle("a", record); expect(root.spent).toBe(0.2); expect(checkpointCost({ usage: [record, record] })).toBe(0.2);
    expect(() => child.reserve("b", 0.7)).toThrow(BudgetExceededError);
  });
  test("budget failures preserve completed council answers and prevent synthesis charges", async () => {
    const calls: Array<{ model: string; messages: unknown[] }> = []; mockCouncil(calls);
    const run = await executeReview(options({ maxCost: 0.01 })); expect(run.status).toBe("error"); expect(calls).toHaveLength(0); expect(checkpointCost(run)).toBe(0);
  });
});

describe("provider response integrity", () => {
  test("404 and authentication errors fail on the first attempt", async () => {
    for (const status of [400, 401, 402, 403, 404]) {
      let count = 0; globalThis.fetch = (async () => { count++; return new Response("unavailable", { status }); }) as typeof fetch;
      await expect(requestCompletion({ apiKey: "k", model: models[0], messages: [], maxTokens: 100, baseDelayMs: 0 })).rejects.toBeInstanceOf(ProviderError); expect(count).toBe(1);
    }
  });
  test("HTTP 200 provider errors are failures", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: 401, message: "Invalid key" } }))) as typeof fetch;
    await expect(requestCompletion({ apiKey: "k", model: models[0], messages: [], maxTokens: 100 })).rejects.toThrow("Invalid key");
  });
  test("an allowed free fallback records the actual model and does not retry a 404", async () => {
    const free = getCouncilModels("free")[0], paid = getModel("nvidia/nemotron-3.5-lightning")!;
    const calls: string[] = [];
    globalThis.fetch = (async (_url, init) => { const body = JSON.parse(String(init?.body)); calls.push(body.model);
      return body.model === free.id ? new Response("gone", { status: 404 }) : new Response(JSON.stringify({ model: paid.id, choices: [{ finish_reason: "stop", message: { content: "Replacement answer" } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.02 } })); }) as typeof fetch;
    const [result] = await fanOut({ apiKey: "test", models: [free], content: "test", prompt: "test", maxTokens: 100, runId: null, isAborted: () => false, allowPaidFallback: true, onUpdate: () => {} });
    expect(calls).toEqual([free.id, paid.id]); expect(result.requestedModel).toBe(free.id); expect(result.model).toBe(paid.id); expect(result.fallbackFrom).toBe(free.id); expect(result.cost).toBe(0.02);
  });
  test("empty and truncated replies are excluded from synthesis", async () => {
    for (const [content, finish] of [["", "stop"], ["partial answer", "length"]]) {
      globalThis.fetch = (async () => reply(content, finish)) as typeof fetch;
      const run = await executeReview(options()); expect(run.responses.every((response) => response.status === "incomplete")).toBe(true); expect(run.synthesis).toBeUndefined();
    }
  });
  test("SSE fragments retain provider usage and actual model identity", async () => {
    const chunks = ["data: " + JSON.stringify({ model: "actual/provider-model", choices: [{ delta: { content: "Hello " } }] }) + "\n\n", "data: " + JSON.stringify({ choices: [{ delta: { content: "world" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, cost: 0.123 } }) + "\n\ndata: [DONE]\n\n"];
    globalThis.fetch = (async () => new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) { const bytes = new TextEncoder().encode(chunk); controller.enqueue(bytes.slice(0, 12)); controller.enqueue(bytes.slice(12)); } controller.close(); } }), { headers: { "Content-Type": "text/event-stream" } })) as typeof fetch;
    const budget = new RunBudget(1), text: string[] = [];
    const result = await requestCompletion({ apiKey: "k", model: models[0], messages: [], maxTokens: 100, budget, onText: (value) => text.push(value) });
    expect(result.choices[0].message.content).toBe("Hello world"); expect(result.model).toBe("actual/provider-model"); expect(budget.spent).toBe(0.123); expect(text.at(-1)).toBe("Hello world");
  });
});

describe("freshness and evidence", () => {
  test("text-only selection excludes image generation and recognizes modern families", () => {
    expect(isTextModel({ id: "google/nano-banana-pro", name: "Image", context_length: 100000, architecture: { output_modalities: ["image", "text"] } })).toBe(false);
    const result = normalizeCatalog([{ id: "openai/gpt-6-astra", name: "Astra", context_length: 1_000_000, pricing: { prompt: "0.00001", completion: "0.00005" }, architecture: { output_modalities: ["text"] } }]); expect(result[0].family).toBe("openai"); expect(result[0].toolCallApi).toBe("responses");
  });
  test("context filtering reserves the configured output budget", () => {
    const small = { ...models[0], contextLength: 10000 }; expect(getModelsFilteredByContext([small], 3000, 8192).tooSmall.has(small.id)).toBe(true);
  });
  test("freshness checks include synthesis and cannot suggest a smaller product line", () => {
    const sol = getModel("openai/gpt-5.6-sol")!, luna = getModel("openai/gpt-5.6-luna")!;
    const findings = checkModelFreshness([sol, { ...luna, created: (sol.created ?? 0) + 1000 }], [sol], [sol.id, SYNTHESIS_IDS.sonnet]);
    expect(findings.some((finding) => finding.id === SYNTHESIS_IDS.sonnet && finding.kind === "DEAD")).toBe(true); expect(findings.some((finding) => finding.kind === "CANDIDATE")).toBe(false);
  });
  test("negated risk words do not manufacture critical findings or a quality score", () => {
    const result = analyzeReviewQuality(synthesis); expect(result.fatalFlawsFound).toBe(0); expect(result.risk).toBe("Low"); expect(result.score).toBeNull();
  });
  test("only exact source quotes earn evidence coverage", () => {
    const result = validateSynthesis({ ...synthesis, findings: [{ id: "1", title: "A concern", severity: "high", recommendation: "Check the code", evidence: [{ source: "content", quote: "const password = input;" }], supportingModels: [] }, { id: "2", title: "Invented", severity: "critical", recommendation: "Check this", evidence: [{ source: "content", quote: "invented evidence here" }], supportingModels: [] }] }, { content: "const password = input;" });
    expect(result.findings?.map((finding) => finding.evidenceVerified)).toEqual([true, false]); expect(analyzeReviewQuality(result).score).toBe(50); expect(analyzeReviewQuality(result).fatalFlawsFound).toBe(0);
    expect(() => validateSynthesis({ masterDocument: "" })).toThrow();
  });
});
