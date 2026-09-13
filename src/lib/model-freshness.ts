import { configuredModelIds, modelLineage, SNAPSHOT_MODELS } from "./model-catalog";
import type { ModelInfo } from "./types";
export interface FreshnessFinding { kind: "DEAD" | "PRICE" | "CAPABILITY" | "CANDIDATE"; id: string; detail: string }
const drift = (a: number, b: number) => a !== b && (a === 0 || Math.abs(a - b) / a > 0.02);
export function checkModelFreshness(live: ModelInfo[], recorded = SNAPSHOT_MODELS, ids = configuredModelIds()): FreshnessFinding[] {
  const findings: FreshnessFinding[] = [];
  for (const id of ids) {
    const actual = live.find((model) => model.id === id), old = recorded.find((model) => model.id === id);
    if (!actual || !old) { findings.push({ kind: "DEAD", id, detail: actual ? "Missing reviewed metadata snapshot" : "Unavailable or incompatible with text reviews" }); continue; }
    if (drift(old.inputCostPer1k, actual.inputCostPer1k) || drift(old.outputCostPer1k, actual.outputCostPer1k)) findings.push({ kind: "PRICE", id, detail: `Now $${(actual.inputCostPer1k * 1000).toFixed(3)} input / $${(actual.outputCostPer1k * 1000).toFixed(3)} output per million tokens` });
    if (actual.contextLength !== old.contextLength || actual.maxOutputTokens !== old.maxOutputTokens || JSON.stringify(actual.reasoning) !== JSON.stringify(old.reasoning) || JSON.stringify([...(actual.supportedParameters ?? [])].sort()) !== JSON.stringify([...(old.supportedParameters ?? [])].sort())) findings.push({ kind: "CAPABILITY", id, detail: "Context, output limit, reasoning settings, or supported request parameters changed" });
    const successor = live.filter((model) => model.id !== id && (model.created ?? 0) > (actual.created ?? 0) && modelLineage(model.id) === modelLineage(id)
      && model.id.endsWith(":free") === id.endsWith(":free") && !/preview|experimental|:batch/i.test(model.id)
      && model.contextLength >= Math.min(actual.contextLength, 128000)
      && (!actual.supportedParameters?.includes("tools") || model.supportedParameters?.includes("tools")))
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))[0];
    if (successor) findings.push({ kind: "CANDIDATE", id, detail: `Evaluate ${successor.id}; a newer release is not an automatic quality upgrade` });
  }
  return findings;
}
