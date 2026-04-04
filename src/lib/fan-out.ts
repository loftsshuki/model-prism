import pLimit from "p-limit";
import { ModelInfo, ModelResponse } from "./types";

const paidLimit = pLimit(6);
const freeLimit = pLimit(1); // Sequential — free models share brutal rate limits

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Call OpenRouter directly from the browser — no Vercel timeout ceiling
async function callDirect(
  model: string,
  content: string,
  prompt: string,
  apiKey: string,
  maxTokens: number,
  maxRetries: number
): Promise<{ response: string; timeMs: number; inputTokens: number; outputTokens: number }> {
  const startTime = Date.now();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "X-Title": "Model Prism",
          "HTTP-Referer": "https://model-prism.vercel.app",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: `${prompt}\n\n---\n\n${content}` }],
        }),
      });

      // 404 = no provider currently serving this model — don't retry
      if (res.status === 404) {
        throw new Error("No provider online for this model right now");
      }

      // 429 = rate limited — wait longer and retry
      if (res.status === 429 && attempt < maxRetries) {
        const delay = Math.min(5000 * Math.pow(2, attempt), 30000) + Math.random() * 3000;
        await sleep(delay);
        continue;
      }

      // 502/503/504 = provider overloaded or slow — retry with backoff
      if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < maxRetries) {
        await sleep(3000 * (attempt + 1) + Math.random() * 2000);
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenRouter error: ${res.status} ${text.slice(0, 120)}`);
      }

      const data = await res.json();
      return {
        response: data.choices?.[0]?.message?.content ?? "",
        timeMs: Date.now() - startTime,
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      };
    } catch (error) {
      // Don't retry non-retryable errors
      if (error instanceof Error && (error.message.includes("404") || error.message.includes("unavailable"))) {
        throw error;
      }
      if (attempt < maxRetries) {
        await sleep(3000 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }

  throw new Error("Max retries exceeded");
}

async function persistResponse(runId: string, model: ModelInfo, result: ModelResponse) {
  try {
    await fetch("/api/save-response", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId,
        model: model.id,
        modelName: model.name,
        family: model.family,
        response: result.response ?? null,
        error: result.error ?? null,
        timeMs: result.timeMs ?? null,
        inputTokens: result.inputTokens ?? null,
        outputTokens: result.outputTokens ?? null,
        cost: result.cost ?? null,
      }),
    });
  } catch {
    // Non-blocking
  }
}

function estimateResponseCost(model: ModelInfo, inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1000) * model.inputCostPer1k + (outputTokens / 1000) * model.outputCostPer1k;
}

export async function invokeModel(
  model: ModelInfo,
  content: string,
  prompt: string,
  apiKey: string,
  runId: string | null,
  maxTokens: number,
  isAborted: () => boolean,
  onUpdate: (response: ModelResponse) => void
): Promise<ModelResponse> {
  const result: ModelResponse = {
    model: model.id,
    modelName: model.name,
    status: "streaming",
  };

  // Skip if already aborted
  if (isAborted()) {
    result.status = "error";
    result.error = "Stopped";
    onUpdate(result);
    return result;
  }

  onUpdate(result);

  const isFree = model.tier === "free";
  // Free models: 5 retries (brutal rate limits). Paid: 3 retries.
  const maxRetries = isFree ? 5 : 3;

  try {
    const data = await callDirect(model.id, content, prompt, apiKey, maxTokens, maxRetries);
    result.status = "complete";
    result.response = data.response;
    result.timeMs = data.timeMs;
    result.inputTokens = data.inputTokens;
    result.outputTokens = data.outputTokens;
    result.cost = isFree ? 0 : estimateResponseCost(model, data.inputTokens, data.outputTokens);
    onUpdate(result);
    if (runId) persistResponse(runId, model, result);
    return result;
  } catch (error) {
    result.status = "error";
    result.error = error instanceof Error ? error.message : "Network error";
    onUpdate(result);
    if (runId) persistResponse(runId, model, result);
    return result;
  }
}

export function fanOut(
  models: ModelInfo[],
  content: string,
  prompt: string,
  apiKey: string,
  runId: string | null,
  maxTokens: number,
  isAborted: () => boolean,
  onUpdate: (modelId: string, response: ModelResponse) => void
): Promise<ModelResponse[]> {
  // Sort: paid first (fast), free last (slow/sequential)
  const sorted = [...models].sort((a, b) => {
    if (a.tier === "free" && b.tier !== "free") return 1;
    if (a.tier !== "free" && b.tier === "free") return -1;
    return 0;
  });

  const promises = sorted.map((model) => {
    const limiter = model.tier === "free" ? freeLimit : paidLimit;
    return limiter(() =>
      invokeModel(model, content, prompt, apiKey, runId, maxTokens, isAborted, (resp) =>
        onUpdate(model.id, resp)
      )
    );
  });

  return Promise.all(promises);
}
