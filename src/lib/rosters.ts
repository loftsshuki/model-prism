import { ModelInfo } from "./types";

// --- Council rosters ---
//
// `default` / `frontier` → quality-optimized; runs on EVERY plan via the
//        plan-review-cycle hook. 3 free diversity anchors + 7 frontier reasoning
//        models, one per distinct family. Best results: strong independent reasoners
//        catch subtle flaws the cheap/free models miss. ~$1–2/run incl. Opus 4.8
//        synthesis — negligible vs the cost of an agent executing a flawed plan.
// `cheap`  → cost-optimized for bulk / low-stakes runs. 5 free + 5 cheap paid,
//        ~$0.25/run. Opt in with `--roster cheap`.
//
// All model IDs + prices curl-verified against the live OpenRouter catalog, and each
// is the NEWEST GA model in its family as of 2026-05-30 (checked via the catalog's
// `created` timestamps). `:free` slots are cushioned by the auto-fallback
// (src/lib/fan-out.ts): a free slot that 429/503s mid-run auto-swaps to its paid twin
// (or a cheap generalist), so a flaky free endpoint never drops the council below quorum.
//
// Freshness is guarded by scripts/check-roster-freshness.ts (run weekly via the
// roster-freshness GitHub Action): it flags dead IDs, price drift, and newer same-family
// models, so "newest GA" can't silently rot between manual reviews.
//
// 2026-05-30 refresh: bumped every paid slot to its newest family version (gpt-5.4→5.5,
// gemini-2.5-pro→3.5-flash, qwen3.6-plus→3.7-max, deepseek-r1→v4-pro, kimi-thinking→k2.6,
// grok-4.20→4.3). Dropped Claude Haiku 4.5 — it was the weakest reasoner and the only
// proprietary small model, redundant with the Claude Opus synthesizer — for MiniMax M2.7,
// a strong open-weight reasoner that adds a distinct family at ~1/4 the output cost.
// Prior refresh history: the "11 families" set (2026-05-03) had shipped 3 broken IDs
// (tencent/hy3-preview:free + nvidia/nemotron-nano-12b-v2:free absent from the catalog;
// openrouter/owl-alpha a volatile cloaked alpha; claude-haiku-4-5 a hyphen/dot typo).

export const FRONTIER_COUNCIL: ModelInfo[] = [
  // --- 3 free diversity anchors (distinct strong families, $0) ---
  { id: "openai/gpt-oss-120b:free", name: "GPT-OSS 120B", family: "gpt-oss", tier: "free", contextLength: 131072, inputCostPer1k: 0, outputCostPer1k: 0 },
  { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "Nemotron 3 Super 120B", family: "nemotron", tier: "free", contextLength: 1000000, inputCostPer1k: 0, outputCostPer1k: 0 },
  { id: "z-ai/glm-4.5-air:free", name: "GLM 4.5 Air", family: "glm", tier: "free", contextLength: 131072, inputCostPer1k: 0, outputCostPer1k: 0 },
  // --- 7 paid frontier/reasoning slots, one per distinct family (newest GA each) ---
  { id: "minimax/minimax-m2.7", name: "MiniMax M2.7", family: "minimax", tier: "fast", contextLength: 204800, inputCostPer1k: 0.00026, outputCostPer1k: 0.0012 },
  { id: "openai/gpt-5.5", name: "GPT-5.5", family: "gpt-5", tier: "fast", contextLength: 1050000, inputCostPer1k: 0.005, outputCostPer1k: 0.030 },
  { id: "google/gemini-3.5-flash", name: "Gemini 3.5 Flash", family: "gemini", tier: "fast", contextLength: 1048576, inputCostPer1k: 0.0015, outputCostPer1k: 0.009 },
  { id: "x-ai/grok-4.3", name: "Grok 4.3", family: "grok", tier: "fast", contextLength: 1000000, inputCostPer1k: 0.00125, outputCostPer1k: 0.0025 },
  { id: "qwen/qwen3.7-max", name: "Qwen 3.7 Max", family: "qwen", tier: "fast", contextLength: 1000000, inputCostPer1k: 0.00125, outputCostPer1k: 0.00375 },
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", family: "deepseek", tier: "fast", contextLength: 1048576, inputCostPer1k: 0.000435, outputCostPer1k: 0.00087 },
  { id: "moonshotai/kimi-k2.6", name: "Kimi K2.6", family: "kimi", tier: "fast", contextLength: 262144, inputCostPer1k: 0.000684, outputCostPer1k: 0.00342 },
];

export const CHEAP_COUNCIL: ModelInfo[] = [
  // --- 5 reliable free models (distinct families; cushioned by auto-fallback) ---
  { id: "openai/gpt-oss-120b:free", name: "GPT-OSS 120B", family: "gpt-oss", tier: "free", contextLength: 131072, inputCostPer1k: 0, outputCostPer1k: 0 },
  { id: "qwen/qwen3-coder:free", name: "Qwen3 Coder", family: "qwen", tier: "free", contextLength: 1048576, inputCostPer1k: 0, outputCostPer1k: 0 },
  { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "Nemotron 3 Super 120B", family: "nemotron", tier: "free", contextLength: 1000000, inputCostPer1k: 0, outputCostPer1k: 0 },
  { id: "z-ai/glm-4.5-air:free", name: "GLM 4.5 Air", family: "glm", tier: "free", contextLength: 131072, inputCostPer1k: 0, outputCostPer1k: 0 },
  { id: "nousresearch/hermes-3-llama-3.1-405b:free", name: "Hermes 3 405B", family: "hermes-llama", tier: "free", contextLength: 131072, inputCostPer1k: 0, outputCostPer1k: 0 },
  // --- 5 cheap paid models (distinct families; newest GA each, curl-verified 2026-05-30) ---
  { id: "minimax/minimax-m2.5", name: "MiniMax M2.5", family: "minimax", tier: "fast", contextLength: 204800, inputCostPer1k: 0.00015, outputCostPer1k: 0.00115 },
  { id: "google/gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite", family: "gemini", tier: "fast", contextLength: 1048576, inputCostPer1k: 0.00025, outputCostPer1k: 0.0015 },
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", family: "deepseek", tier: "fast", contextLength: 1048576, inputCostPer1k: 0.000435, outputCostPer1k: 0.00087 },
  { id: "x-ai/grok-4.3", name: "Grok 4.3", family: "grok", tier: "fast", contextLength: 1000000, inputCostPer1k: 0.00125, outputCostPer1k: 0.0025 },
  { id: "moonshotai/kimi-k2.6", name: "Kimi K2.6", family: "kimi", tier: "fast", contextLength: 262144, inputCostPer1k: 0.000684, outputCostPer1k: 0.00342 },
];

export const ROSTERS: Record<string, ModelInfo[]> = {
  default: FRONTIER_COUNCIL,
  frontier: FRONTIER_COUNCIL,
  cheap: CHEAP_COUNCIL,
};
