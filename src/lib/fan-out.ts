import pLimit from "p-limit";
import { ModelInfo, ModelResponse } from "./types";

const limit = pLimit(8);

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
    // Non-blocking — don't fail the fan-out if persistence fails
  }
}

export async function invokeModel(
  model: ModelInfo,
  content: string,
  prompt: string,
  apiKey: string,
  runId: string | null,
  onUpdate: (response: ModelResponse) => void
): Promise<ModelResponse> {
  const result: ModelResponse = {
    model: model.id,
    modelName: model.name,
    status: "streaming",
  };

  onUpdate(result);

  try {
    const res = await fetch("/api/invoke-model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model.id,
        content,
        prompt,
        apiKey,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      result.status = "error";
      result.error = err.error || `HTTP ${res.status}`;
      result.timeMs = err.timeMs;
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
  onUpdate: (modelId: string, response: ModelResponse) => void
): Promise<ModelResponse[]> {
  const promises = models.map((model) =>
    limit(() =>
      invokeModel(model, content, prompt, apiKey, runId, (resp) =>
        onUpdate(model.id, resp)
      )
    )
  );

  return Promise.all(promises);
}
