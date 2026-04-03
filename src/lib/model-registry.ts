import { ModelInfo } from "./types";

// Hardcoded for Phase 1 — Phase 3 will pull live from OpenRouter API
export const MODELS: ModelInfo[] = [
  // Frontier
  {
    id: "anthropic/claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    family: "claude",
    tier: "frontier",
    contextLength: 200000,
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.015,
  },
  {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    family: "gpt",
    tier: "frontier",
    contextLength: 128000,
    inputCostPer1k: 0.0025,
    outputCostPer1k: 0.01,
  },
  {
    id: "google/gemini-2.5-pro-preview-06-05",
    name: "Gemini 2.5 Pro",
    family: "gemini",
    tier: "frontier",
    contextLength: 1000000,
    inputCostPer1k: 0.00125,
    outputCostPer1k: 0.01,
  },
  {
    id: "x-ai/grok-3-beta",
    name: "Grok 3",
    family: "grok",
    tier: "frontier",
    contextLength: 131072,
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.015,
  },
  // Strong
  {
    id: "anthropic/claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    family: "claude",
    tier: "strong",
    contextLength: 200000,
    inputCostPer1k: 0.0008,
    outputCostPer1k: 0.004,
  },
  {
    id: "openai/gpt-4o-mini",
    name: "GPT-4o Mini",
    family: "gpt",
    tier: "strong",
    contextLength: 128000,
    inputCostPer1k: 0.00015,
    outputCostPer1k: 0.0006,
  },
  {
    id: "deepseek/deepseek-chat-v3-0324",
    name: "DeepSeek V3",
    family: "deepseek",
    tier: "strong",
    contextLength: 65536,
    inputCostPer1k: 0.0003,
    outputCostPer1k: 0.00088,
  },
  {
    id: "google/gemini-2.0-flash-001",
    name: "Gemini 2.0 Flash",
    family: "gemini",
    tier: "strong",
    contextLength: 1000000,
    inputCostPer1k: 0.0001,
    outputCostPer1k: 0.0004,
  },
  // Fast
  {
    id: "meta-llama/llama-3.1-70b-instruct",
    name: "Llama 3.1 70B",
    family: "llama",
    tier: "fast",
    contextLength: 131072,
    inputCostPer1k: 0.00052,
    outputCostPer1k: 0.00075,
  },
  {
    id: "mistralai/mistral-large-2411",
    name: "Mistral Large",
    family: "mistral",
    tier: "fast",
    contextLength: 131072,
    inputCostPer1k: 0.002,
    outputCostPer1k: 0.006,
  },
  {
    id: "qwen/qwen-2.5-72b-instruct",
    name: "Qwen 2.5 72B",
    family: "qwen",
    tier: "fast",
    contextLength: 32768,
    inputCostPer1k: 0.00036,
    outputCostPer1k: 0.0004,
  },
  {
    id: "nvidia/llama-3.1-nemotron-70b-instruct",
    name: "Nemotron 70B",
    family: "llama",
    tier: "fast",
    contextLength: 131072,
    inputCostPer1k: 0.00035,
    outputCostPer1k: 0.0004,
  },
];

export function getModelsByTier(tier: ModelInfo["tier"]): ModelInfo[] {
  return MODELS.filter((m) => m.tier === tier);
}

export function getModelsByFamily(family: string): ModelInfo[] {
  return MODELS.filter((m) => m.family === family);
}

export const TIERS: Array<{ key: ModelInfo["tier"]; label: string }> = [
  { key: "frontier", label: "Frontier" },
  { key: "strong", label: "Strong" },
  { key: "fast", label: "Fast" },
];

export const FAMILIES = [...new Set(MODELS.map((m) => m.family))];
