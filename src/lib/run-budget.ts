import type { ModelInfo, ModelUsage } from "./types";

export class BudgetExceededError extends Error {
  constructor(detail?: string) { super(detail ?? "Run budget reached. Increase the budget to resume the remaining work."); this.name = "BudgetExceededError"; }
}

/** Explains a refused reservation in dollars, so the user knows how far to raise the limit. */
export function budgetShortfall(ceiling: number, remaining: number) {
  return new BudgetExceededError(`This request can cost up to $${ceiling.toFixed(2)}, but only $${Math.max(0, remaining).toFixed(2)} of the spending limit is left. Raise the limit to resume; completed work is kept.`);
}

/** Provider requests must await both local and durable budget operations. */
export interface RequestBudget {
  /** `model` is informational, for ledgers that record the reservation. */
  reserve(id: string, ceiling: number, model?: string): void | Promise<void>;
  settle(id: string, record: ModelUsage): void | Promise<void>;
  release(id: string): void | Promise<void>;
  /** Unreserved budget left, when the implementation can report it. Used to shrink an output budget instead of refusing. */
  available?(): number | Promise<number>;
}

/** Reservations include concurrent requests. Uncertain/aborted charges retain their ceiling. */
export class RunBudget implements RequestBudget {
  private reservations = new Map<string, number>();
  private records = new Map<string, ModelUsage>();
  constructor(public readonly limit: number, usage: ModelUsage[] = [], private readonly parent?: RunBudget) {
    if (!Number.isFinite(limit) || limit <= 0) throw new Error("Set a positive run budget.");
    for (const record of usage) { this.records.set(record.requestId, record); parent?.settle(record.requestId, record); }
  }
  get usage() { return [...this.records.values()]; }
  get spent() { return this.usage.reduce((sum, u) => sum + u.cost, 0); }
  get remaining() { return Math.max(0, this.limit - this.spent - [...this.reservations.values()].reduce((a, b) => a + b, 0)); }
  available(): number { return Math.min(this.remaining, this.parent ? this.parent.available() : Infinity); }
  reserve(id: string, ceiling: number) {
    if (!Number.isFinite(ceiling) || ceiling < 0 || ceiling > this.remaining + 1e-9) throw budgetShortfall(ceiling, this.remaining);
    this.parent?.reserve(id, ceiling);
    this.reservations.set(id, ceiling);
  }
  settle(id: string, record: ModelUsage) {
    this.reservations.delete(id);
    this.records.set(id, record);
    this.parent?.settle(id, record);
  }
  release(id: string) { this.reservations.delete(id); this.parent?.release(id); }
}

export function requestCost(model: ModelInfo, inputTokens: number, outputTokens: number) {
  return inputTokens * model.inputCostPer1k / 1000 + outputTokens * model.outputCostPer1k / 1000;
}

/** Worst-case cost when the input is `inputBytes` UTF-8 bytes (bytes bound token counts conservatively). */
export function ceilingForBytes(model: ModelInfo, inputBytes: number, maxTokens: number) {
  return requestCost(model, Math.min(inputBytes + 512, model.contextLength), maxTokens);
}

export function requestCeiling(model: ModelInfo, messages: unknown[], maxTokens: number, tools: unknown[] = []) {
  // UTF-8 bytes bound text token counts conservatively; include framing and tool definitions.
  return ceilingForBytes(model, new TextEncoder().encode(JSON.stringify([messages, tools])).length, maxTokens);
}

/** Largest output budget whose ceiling fits in `available` dollars (Infinity for free output). */
export function affordableOutputTokens(model: ModelInfo, messages: unknown[], available: number, tools: unknown[] = []) {
  const perToken = model.outputCostPer1k / 1000;
  if (perToken <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((available - requestCeiling(model, messages, 0, tools)) / perToken));
}

/** Synthesis may shrink its output to fit the remaining budget, but never below this. */
export const SYNTHESIS_MIN_TOKENS = 8192;
/** Assumed reviewer answer length when estimating the synthesis input before the council has answered. */
const ASSUMED_ANSWER_BYTES = 16_000;
/** Paid reviewers run four at a time (fan-out), so at most four council reservations overlap. */
const PAID_CONCURRENCY = 4;

/**
 * The most a run can hold in reservations at one moment: the four largest
 * reviewer ceilings (they overlap) plus the synthesis ceiling. A limit below this
 * guarantees a refused request mid-run, after money has already been spent.
 */
export function requiredRunBudget(opts: {
  reviewers: ModelInfo[]; synthesizer?: ModelInfo; inputText: string;
  maxTokens: number; synthesisMaxTokens: number; reviewersAnswering?: number;
}) {
  const inputBytes = new TextEncoder().encode(opts.inputText).length;
  const council = opts.reviewers
    .map((model) => ceilingForBytes(model, inputBytes, Math.min(opts.maxTokens, model.maxOutputTokens ?? opts.maxTokens)))
    .sort((a, b) => b - a).slice(0, PAID_CONCURRENCY).reduce((sum, cost) => sum + cost, 0);
  const synth = opts.synthesizer;
  const answers = (opts.reviewersAnswering ?? opts.reviewers.length) * ASSUMED_ANSWER_BYTES;
  const synthesis = synth ? ceilingForBytes(synth, inputBytes + answers, Math.min(opts.synthesisMaxTokens, synth.maxOutputTokens ?? opts.synthesisMaxTokens)) : 0;
  return { council, synthesis, total: council + synthesis };
}
