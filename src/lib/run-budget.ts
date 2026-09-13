import type { ModelInfo, ModelUsage } from "./types";

export class BudgetExceededError extends Error {
  constructor() { super("Run budget reached. Increase the budget to resume the remaining work."); this.name = "BudgetExceededError"; }
}

/** Reservations include concurrent requests. Uncertain/aborted charges retain their ceiling. */
export class RunBudget {
  private reservations = new Map<string, number>();
  private records = new Map<string, ModelUsage>();
  constructor(public readonly limit: number, usage: ModelUsage[] = [], private readonly parent?: RunBudget) {
    if (!Number.isFinite(limit) || limit <= 0) throw new Error("Set a positive run budget.");
    for (const record of usage) { this.records.set(record.requestId, record); parent?.settle(record.requestId, record); }
  }
  get usage() { return [...this.records.values()]; }
  get spent() { return this.usage.reduce((sum, u) => sum + u.cost, 0); }
  get remaining() { return Math.max(0, this.limit - this.spent - [...this.reservations.values()].reduce((a, b) => a + b, 0)); }
  reserve(id: string, ceiling: number) {
    if (!Number.isFinite(ceiling) || ceiling < 0 || ceiling > this.remaining + 1e-9) throw new BudgetExceededError();
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

export function requestCeiling(model: ModelInfo, messages: unknown[], maxTokens: number, tools: unknown[] = []) {
  // UTF-8 bytes bound text token counts conservatively; include framing and tool definitions.
  const inputBound = new TextEncoder().encode(JSON.stringify([messages, tools])).length + 512;
  return requestCost(model, Math.min(inputBound, model.contextLength), maxTokens);
}
