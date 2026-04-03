import { ModelInfo } from "./types";

// Static fallback models — used when OpenRouter API is unavailable
export const FALLBACK_MODELS: ModelInfo[] = [
  { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6", family: "claude", tier: "frontier", contextLength: 200000, inputCostPer1k: 0.003, outputCostPer1k: 0.015 },
  { id: "openai/gpt-4o", name: "GPT-4o", family: "gpt-4o", tier: "frontier", contextLength: 128000, inputCostPer1k: 0.0025, outputCostPer1k: 0.01 },
  { id: "google/gemini-2.5-pro-preview-06-05", name: "Gemini 2.5 Pro", family: "gemini", tier: "frontier", contextLength: 1000000, inputCostPer1k: 0.00125, outputCostPer1k: 0.01 },
  { id: "x-ai/grok-3-beta", name: "Grok 3", family: "grok", tier: "frontier", contextLength: 131072, inputCostPer1k: 0.003, outputCostPer1k: 0.015 },
  { id: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5", family: "claude", tier: "strong", contextLength: 200000, inputCostPer1k: 0.0008, outputCostPer1k: 0.004 },
  { id: "openai/gpt-4o-mini", name: "GPT-4o Mini", family: "gpt-4o", tier: "strong", contextLength: 128000, inputCostPer1k: 0.00015, outputCostPer1k: 0.0006 },
  { id: "deepseek/deepseek-chat-v3-0324", name: "DeepSeek V3", family: "deepseek", tier: "strong", contextLength: 65536, inputCostPer1k: 0.0003, outputCostPer1k: 0.00088 },
  { id: "google/gemini-2.0-flash-001", name: "Gemini 2.0 Flash", family: "gemini", tier: "strong", contextLength: 1000000, inputCostPer1k: 0.0001, outputCostPer1k: 0.0004 },
  { id: "meta-llama/llama-3.1-70b-instruct", name: "Llama 3.1 70B", family: "llama", tier: "fast", contextLength: 131072, inputCostPer1k: 0.00052, outputCostPer1k: 0.00075 },
  { id: "mistralai/mistral-large-2411", name: "Mistral Large", family: "mistral", tier: "fast", contextLength: 131072, inputCostPer1k: 0.002, outputCostPer1k: 0.006 },
  { id: "qwen/qwen-2.5-72b-instruct", name: "Qwen 2.5 72B", family: "qwen", tier: "fast", contextLength: 32768, inputCostPer1k: 0.00036, outputCostPer1k: 0.0004 },
  { id: "nvidia/llama-3.1-nemotron-70b-instruct", name: "Nemotron 70B", family: "llama", tier: "fast", contextLength: 131072, inputCostPer1k: 0.00035, outputCostPer1k: 0.0004 },
];

export const TIERS: Array<{ key: ModelInfo["tier"]; label: string; color: string }> = [
  { key: "frontier", label: "Frontier", color: "violet" },
  { key: "strong", label: "Strong", color: "blue" },
  { key: "fast", label: "Fast", color: "emerald" },
];

export function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token for English
  return Math.ceil(text.length / 4);
}

export function getModelsFilteredByContext(models: ModelInfo[], inputTokens: number): {
  available: ModelInfo[];
  tooSmall: Set<string>;
} {
  const tooSmall = new Set<string>();
  const available: ModelInfo[] = [];

  // Need room for system prompt + output (600 max_tokens)
  const requiredContext = inputTokens + 1000;

  for (const model of models) {
    if (model.contextLength < requiredContext) {
      tooSmall.add(model.id);
    } else {
      available.push(model);
    }
  }

  return { available, tooSmall };
}

export function estimateCost(models: ModelInfo[], inputTokens: number, outputTokens: number = 600): number {
  return models.reduce((total, m) => {
    return total + (m.inputCostPer1k * inputTokens / 1000) + (m.outputCostPer1k * outputTokens / 1000);
  }, 0);
}
