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

function detectTier(pricing: { prompt: string; completion: string }, contextLength: number): "frontier" | "strong" | "fast" | "free" {
  const inputCost = parseFloat(pricing.prompt);
  const outputCost = parseFloat(pricing.completion);
  // Free models: both input and output cost are 0
  if (inputCost === 0 && outputCost === 0) return "free";
  const costPer1k = inputCost * 1000;
  if (costPer1k >= 0.002 || contextLength >= 200000) return "frontier";
  if (costPer1k >= 0.0005) return "strong";
  return "fast";
}

// Filter out non-text models (image gen, video, audio, embedding, moderation)
function isTextModel(m: OpenRouterModel): boolean {
  const id = m.id.toLowerCase();
  const name = (m.name || "").toLowerCase();

  // Exclude by modality
  if (m.architecture?.modality === "image" || m.architecture?.modality === "audio") return false;

  // Exclude image generation models
  if (id.includes("dall-e") || id.includes("stable-diffusion") || id.includes("sdxl") ||
      id.includes("midjourney") || id.includes("flux") || id.includes("imagen")) return false;

  // Exclude video models
  if (id.includes("sora") || id.includes("runway") || id.includes("kling") ||
      id.includes("pika") || id.includes("gen-3") || id.includes("video") ||
      name.includes("video")) return false;

  // Exclude audio/speech models
  if (id.includes("whisper") || id.includes("tts") || id.includes("speech") ||
      id.includes("audio") || name.includes("audio") || name.includes("speech")) return false;

  // Exclude embedding models
  if (id.includes("embed") || name.includes("embed")) return false;

  // Exclude moderation models
  if (id.includes("moderation") || id.includes("shield") || id.includes("guard")) return false;

  // Exclude music/audio generation (Lyria, MusicGen, etc.)
  if (id.includes("lyria") || id.includes("musicgen") || id.includes("music")) return false;

  // Exclude uncensored/NSFW-focused models
  if (id.includes("uncensored") || name.includes("uncensored")) return false;

  return true;
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
        if (!pricing.prompt || !pricing.completion) return false;
        if (!isTextModel(m)) return false;
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
        const tierOrder = { frontier: 0, strong: 1, fast: 2, free: 3 };
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
