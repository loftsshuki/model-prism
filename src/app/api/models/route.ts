import { NextRequest, NextResponse } from "next/server";

// Cache models for 1 hour
let cachedModels: OpenRouterModel[] | null = null;
let cachedAt = 0;
const CACHE_TTL = 60 * 60 * 1000;

interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
  pricing: {
    prompt: string;
    completion: string;
  };
  architecture?: {
    modality?: string;
    tokenizer?: string;
    instruct_type?: string | null;
  };
}

// Map model IDs to base architecture families
function detectFamily(id: string): string {
  const lower = id.toLowerCase();
  if (lower.includes("claude")) return "claude";
  if (lower.includes("gpt-4o")) return "gpt-4o";
  if (lower.includes("gpt-4")) return "gpt-4";
  if (lower.includes("gpt-3")) return "gpt-3";
  if (lower.includes("o1") || lower.includes("o3") || lower.includes("o4")) return "openai-reasoning";
  if (lower.includes("gemini")) return "gemini";
  if (lower.includes("grok")) return "grok";
  if (lower.includes("llama")) return "llama";
  if (lower.includes("mistral") || lower.includes("mixtral")) return "mistral";
  if (lower.includes("deepseek")) return "deepseek";
  if (lower.includes("qwen")) return "qwen";
  if (lower.includes("command")) return "cohere";
  if (lower.includes("phi")) return "phi";
  if (lower.includes("nemotron")) return "nemotron";
  if (lower.includes("dbrx")) return "dbrx";
  if (lower.includes("yi")) return "yi";
  return "other";
}

function detectTier(pricing: { prompt: string; completion: string }, contextLength: number): "frontier" | "strong" | "fast" {
  const inputCost = parseFloat(pricing.prompt) * 1000; // cost per 1k tokens
  if (inputCost >= 0.002 || contextLength >= 200000) return "frontier";
  if (inputCost >= 0.0005) return "strong";
  return "fast";
}

export async function GET(req: NextRequest) {
  const apiKey = req.headers.get("x-openrouter-key");

  // Return cached if fresh
  if (cachedModels && Date.now() - cachedAt < CACHE_TTL) {
    return NextResponse.json({ models: cachedModels, cached: true });
  }

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const res = await fetch("https://openrouter.ai/api/v1/models", { headers });

    if (!res.ok) {
      // Fall back to cache if available
      if (cachedModels) {
        return NextResponse.json({ models: cachedModels, cached: true, stale: true });
      }
      return NextResponse.json({ error: "Failed to fetch models" }, { status: res.status });
    }

    const data = await res.json();
    const allModels: OpenRouterModel[] = data.data || [];

    // Filter to chat-capable models, exclude free/test endpoints
    const chatModels = allModels
      .filter((m: OpenRouterModel) => {
        const pricing = m.pricing;
        if (!pricing) return false;
        // Exclude vision-only, image gen, embedding models
        if (m.architecture?.modality === "image" || m.architecture?.modality === "audio") return false;
        // Must have both prompt and completion pricing
        if (!pricing.prompt || !pricing.completion) return false;
        return true;
      })
      .map((m: OpenRouterModel) => ({
        id: m.id,
        name: m.name,
        family: detectFamily(m.id),
        tier: detectTier(m.pricing, m.context_length),
        contextLength: m.context_length,
        inputCostPer1k: parseFloat(m.pricing.prompt) * 1000,
        outputCostPer1k: parseFloat(m.pricing.completion) * 1000,
      }))
      .sort((a: { tier: string; inputCostPer1k: number }, b: { tier: string; inputCostPer1k: number }) => {
        const tierOrder = { frontier: 0, strong: 1, fast: 2 };
        const tierDiff = tierOrder[a.tier as keyof typeof tierOrder] - tierOrder[b.tier as keyof typeof tierOrder];
        if (tierDiff !== 0) return tierDiff;
        return b.inputCostPer1k - a.inputCostPer1k;
      });

    cachedModels = chatModels as unknown as OpenRouterModel[];
    cachedAt = Date.now();

    return NextResponse.json({ models: chatModels, cached: false, total: chatModels.length });
  } catch (error) {
    if (cachedModels) {
      return NextResponse.json({ models: cachedModels, cached: true, stale: true });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch models" },
      { status: 500 }
    );
  }
}
