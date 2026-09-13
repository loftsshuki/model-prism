import type { ModelInfo } from "./types";
import { COUNCIL_MAX_TOKENS, SNAPSHOT_MODELS, SYNTHESIS_MAX_TOKENS } from "./model-catalog";

export const FALLBACK_MODELS = SNAPSHOT_MODELS;
export const TIERS: Array<{ key: ModelInfo["tier"]; label: string; color: string }> = [
  { key: "frontier", label: "Advanced", color: "green" },
  { key: "strong", label: "General", color: "blue" },
  { key: "fast", label: "Economy", color: "emerald" },
  { key: "free", label: "Free", color: "green" },
];
export const TOKEN_BUDGET_WARNING = 50000;
export function estimateTokens(text: string, type: "prose" | "code" = "prose"): number {
  return Math.ceil(text.length / (type === "code" ? 2.5 : 4));
}
export function getModelsFilteredByContext(models: ModelInfo[], inputTokens: number, outputTokens = COUNCIL_MAX_TOKENS) {
  const tooSmall = new Set<string>();
  const available = models.filter((m) => {
    const fits = m.contextLength >= inputTokens + Math.min(outputTokens, m.maxOutputTokens ?? outputTokens) + 1024;
    if (!fits) tooSmall.add(m.id);
    return fits;
  });
  return { available, tooSmall };
}
export function estimateCost(models: ModelInfo[], inputTokens: number, outputTokens = COUNCIL_MAX_TOKENS): number {
  return models.reduce((sum, m) => sum + m.inputCostPer1k * inputTokens / 1000 + m.outputCostPer1k * Math.min(outputTokens, m.maxOutputTokens ?? outputTokens) / 1000, 0);
}
export function estimateReviewCost(models: ModelInfo[], inputTokens: number, synthesisModel?: ModelInfo, outputTokens = COUNCIL_MAX_TOKENS, synthesisOutputTokens = SYNTHESIS_MAX_TOKENS): number {
  const council = estimateCost(models, inputTokens, outputTokens);
  return council + (synthesisModel ? estimateCost([synthesisModel], inputTokens + models.length * outputTokens + 2048, synthesisOutputTokens) : 0);
}
