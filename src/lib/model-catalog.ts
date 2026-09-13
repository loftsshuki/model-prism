import snapshot from "./model-catalog.json";
import type { ModelInfo } from "./types";

/** One list of reviewed model IDs, shared by the app, CLI and freshness checks. */
export const COUNCIL_IDS = {
  balanced: ["openai/gpt-5.6-sol", "google/gemini-3.8-flash", "deepseek/deepseek-v4.1-flash", "minimax/minimax-m3", "z-ai/glm-5.3-flash"],
  frontier: ["openai/gpt-6-astra", "google/gemini-3.8-flash", "x-ai/grok-4.6", "qwen/qwen3.8-max-0902", "moonshotai/kimi-k3"],
  cheap: ["openai/gpt-5.6-luna", "google/gemini-3.5-flash-lite", "deepseek/deepseek-v4.1-flash", "minimax/minimax-m3", "z-ai/glm-5.3-flash"],
  free: ["nvidia/nemotron-3.5-lightning:free"],
} as const;
export const SYNTHESIS_IDS = {
  sonnet: "anthropic/claude-sonnet-5",
  opus: "anthropic/claude-opus-5",
  fable: "anthropic/claude-fable-5.1",
} as const;
export type SynthesisModelKey = keyof typeof SYNTHESIS_IDS;
export const ENHANCE_MODEL_ID = SYNTHESIS_IDS.sonnet;
export const FREE_FALLBACK_IDS: Record<string, string> = {
  "nvidia/nemotron-3.5-lightning:free": "nvidia/nemotron-3.5-lightning",
};
export const DEFAULT_FALLBACK_ID = "google/gemini-3.8-flash";
export const CATALOG_URL = "https://openrouter.ai/api/v1/models";
export const SNAPSHOT_CHECKED_AT = snapshot.checkedAt;
export const SNAPSHOT_MODELS = snapshot.models as ModelInfo[];
let runtimeCatalog = SNAPSHOT_MODELS;
export function setRuntimeCatalog(models: ModelInfo[]) { runtimeCatalog = models; }
export const COUNCIL_MAX_TOKENS = 8192;
export const SYNTHESIS_MAX_TOKENS = 16384;

export interface CatalogEntry {
  id: string;
  name: string;
  created?: number;
  context_length: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { input_modalities?: string[]; output_modalities?: string[]; modality?: string };
  top_provider?: { max_completion_tokens?: number | null };
  supported_parameters?: string[];
  reasoning?: ModelInfo["reasoning"];
}

export function detectFamily(id: string): string {
  const [provider, name = ""] = id.toLowerCase().split("/");
  if (provider === "openai") return name.startsWith("gpt-oss") ? "gpt-oss" : "openai";
  const families: Record<string, string> = { anthropic: "claude", google: "gemini", "x-ai": "grok", moonshotai: "kimi", "z-ai": "glm", nvidia: "nemotron", "meta-llama": "llama", mistralai: "mistral", nousresearch: "hermes", cohere: "cohere" };
  return families[provider] ?? provider;
}

export function isTextModel(m: CatalogEntry): boolean {
  if (/:batch$|image|audio|tts|embed|realtime|video|moderation|content-safety|guard|shield|uncensored|search-preview/i.test(m.id)) return false;
  const output = m.architecture?.output_modalities;
  const input = m.architecture?.input_modalities;
  if (output) return output.length === 1 && output[0] === "text" && (!input || input.includes("text"));
  // Older catalog schemas still expose the output side of the modality string.
  return m.architecture?.modality?.split("->").at(-1) === "text";
}

export function normalizeCatalog(entries: CatalogEntry[], verifiedAt = new Date().toISOString()): ModelInfo[] {
  return entries.filter(isTextModel).flatMap((m): ModelInfo[] => {
    const input = Number(m.pricing?.prompt), output = Number(m.pricing?.completion);
    if (!m.pricing?.prompt || !m.pricing?.completion || !Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0 || !(m.context_length > 0)) return [];
    const tier: ModelInfo["tier"] = input === 0 && output === 0 ? "free"
      : [...COUNCIL_IDS.frontier, ...Object.values(SYNTHESIS_IDS)].includes(m.id as never) ? "frontier"
      : [...COUNCIL_IDS.cheap].includes(m.id as never) ? "fast" : "strong";
    return [{ id: m.id, name: m.name.replace(/^[^:]+: /, ""), family: detectFamily(m.id), tier,
      contextLength: m.context_length, inputCostPer1k: input * 1000, outputCostPer1k: output * 1000,
      maxOutputTokens: m.top_provider?.max_completion_tokens ?? undefined, supportedParameters: m.supported_parameters,
      reasoning: m.reasoning ?? undefined, created: m.created, verifiedAt,
      toolCallApi: m.id.startsWith("openai/gpt-6-astra") ? "responses" : "chat" }];
  });
}

export async function fetchModelCatalog(signal?: AbortSignal): Promise<ModelInfo[]> {
  const res = await fetch(CATALOG_URL, { signal: signal ?? AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Model catalog returned ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.data) || data.data.length === 0) throw new Error("Empty model catalog");
  const models = normalizeCatalog(data.data);
  setRuntimeCatalog(models);
  return models;
}

export function getModel(id: string, models: ModelInfo[] = runtimeCatalog): ModelInfo | undefined {
  return models.find((m) => m.id === id);
}

export function getCouncilModels(roster: keyof typeof COUNCIL_IDS, models: ModelInfo[] = SNAPSHOT_MODELS): ModelInfo[] {
  const ids: readonly string[] = COUNCIL_IDS[roster];
  return ids.flatMap((id) => { const m = getModel(id, models); return m ? [m] : []; });
}

export function configuredModelIds(): string[] {
  return [...new Set([...Object.values(COUNCIL_IDS).flat(), ...Object.values(SYNTHESIS_IDS), ENHANCE_MODEL_ID, ...Object.values(FREE_FALLBACK_IDS), DEFAULT_FALLBACK_ID])];
}

/** Compare a product line, not an unrelated smaller/larger variant from a provider. */
export function modelLineage(id: string): string {
  const [provider, raw = ""] = id.split("/");
  const name = raw.replace(/:free$/, "");
  if (provider === "openai" && /^gpt-(?:5|6)/.test(name)) {
    return `${provider}/${/luna|terra|sol/.exec(name)?.[0] ?? "flagship"}${/-pro(?:$|:)/.test(name) ? "-pro" : ""}`;
  }
  const stem = name.replace(/\d+(?:[.\-]\d+)*/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `${provider}/${stem}`;
}
