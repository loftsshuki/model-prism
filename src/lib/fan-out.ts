import pLimit from "p-limit";
import { ModelInfo, ModelResponse } from "./types";

const paidLimit = pLimit(6);
const freeLimit = pLimit(3);

// Call OpenRouter directly from the browser — bypasses Vercel timeout
async function callDirect(
  model: string,
  content: string,
  prompt: string,
  apiKey: string,
  maxTokens: number
): Promise<{ response: string; timeMs: number; inputTokens: number; outputTokens: number }> {
  const startTime = Date.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "Model Prism",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: `${prompt}\n\n---\n\n${content}` }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter error: ${res.status} ${text.slice(0, 100)}`);
  }

  const data = await res.json();
  return {
    response: data.choices?.[0]?.message?.content ?? "",
    timeMs: Date.now() - startTime,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
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

async function callWithRetry(
  model: ModelInfo,
  content: string,
  prompt: string,
  apiKey: string,
  maxTokens: number = 4096,
  maxRetries: number = 2
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch("/api/invoke-model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: model.id, content, prompt, apiKey, maxTokens }),
      });

      // Retry on 429 (rate limit) — exponential backoff
      if (res.status === 429 && attempt < maxRetries) {
        const delay = (attempt + 1) * 2000 + Math.random() * 1000;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      return res;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 1500));
        continue;
      }
    }
  }

  throw lastError ?? new Error("Request failed after retries");
}

export async function invokeModel(
  model: ModelInfo,
  content: string,
  prompt: string,
  apiKey: string,
  runId: string | null,
  maxTokens: number,
  onUpdate: (response: ModelResponse) => void
): Promise<ModelResponse> {
  const result: ModelResponse = {
    model: model.id,
    modelName: model.name,
    status: "streaming",
  };

  onUpdate(result);

  const isFree = model.tier === "free";

  try {
    if (isFree) {
      // Free models: call OpenRouter directly from browser — no Vercel timeout
      const data = await callDirect(model.id, content, prompt, apiKey, maxTokens);
      result.status = "complete";
      result.response = data.response;
      result.timeMs = data.timeMs;
      result.inputTokens = data.inputTokens;
      result.outputTokens = data.outputTokens;
      result.cost = 0;
      onUpdate(result);
      if (runId) persistResponse(runId, model, result);
      return result;
    }

    // Paid models: proxy through server to hide API key
    const res = await callWithRetry(model, content, prompt, apiKey, maxTokens);

    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`;
      try {
        const err = await res.json();
        errMsg = err.error || errMsg;
      } catch {}
      result.status = "error";
      result.error = errMsg;
      onUpdate(result);
      if (runId) persistResponse(runId, model, result);
      return result;
    }

    const data = await res.json();
    result.status = "complete";
    result.response = data.response;
    result.timeMs = data.timeMs;
    result.inputTokens = data.inputTokens;
    result.outputTokens = data.outputTokens;
    result.cost = data.cost;
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
  onUpdate: (modelId: string, response: ModelResponse) => void
): Promise<ModelResponse[]> {
  const promises = models.map((model) => {
    const limiter = model.tier === "free" ? freeLimit : paidLimit;
    return limiter(() =>
      invokeModel(model, content, prompt, apiKey, runId, maxTokens, (resp) =>
        onUpdate(model.id, resp)
      )
    );
  });

  return Promise.all(promises);
}
