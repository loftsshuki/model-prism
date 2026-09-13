import { getCouncilModels } from "./model-catalog";
import type { ModelInfo } from "./types";

export const FRONTIER_COUNCIL = getCouncilModels("frontier");
export const BALANCED_COUNCIL = getCouncilModels("balanced");
export const CHEAP_COUNCIL = getCouncilModels("cheap");
export const ROSTERS: Record<string, ModelInfo[]> = {
  default: BALANCED_COUNCIL, balanced: BALANCED_COUNCIL, frontier: FRONTIER_COUNCIL, cheap: CHEAP_COUNCIL,
};
export const AUTO_THRESHOLD_TOKENS = 1200;
export function estimateTokens(text: string): number { return Math.ceil(text.length / 4); }
export function readCriticality(planContent: string): "low" | "medium" | "high" | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(planContent);
  const m = fm && /^criticality:\s*(low|medium|high)\s*$/im.exec(fm[1]);
  return m ? m[1].toLowerCase() as "low" | "medium" | "high" : null;
}
export function resolveAutoRoster(planContent: string, thresholdTokens = AUTO_THRESHOLD_TOKENS): { roster: "cheap" | "frontier"; reason: string } {
  const crit = readCriticality(planContent);
  if (crit === "high") return { roster: "frontier", reason: "criticality: high" };
  if (crit === "low") return { roster: "cheap", reason: "criticality: low" };
  const tokens = estimateTokens(planContent);
  return tokens >= thresholdTokens ? { roster: "frontier", reason: `~${tokens} tokens ≥ ${thresholdTokens}` }
    : { roster: "cheap", reason: `~${tokens} tokens < ${thresholdTokens}` };
}
