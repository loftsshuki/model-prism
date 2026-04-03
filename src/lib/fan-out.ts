import pLimit from "p-limit";
import { ModelInfo, ModelResponse } from "./types";

const limit = pLimit(8);

export async function invokeModel(
  model: ModelInfo,
  content: string,
  prompt: string,
  apiKey: string,
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
    return result;
  } catch (error) {
    result.status = "error";
    result.error = error instanceof Error ? error.message : "Network error";
    onUpdate(result);
    return result;
  }
}

export function fanOut(
  models: ModelInfo[],
  content: string,
  prompt: string,
  apiKey: string,
  onUpdate: (modelId: string, response: ModelResponse) => void
): Promise<ModelResponse[]> {
  const promises = models.map((model) =>
    limit(() =>
      invokeModel(model, content, prompt, apiKey, (resp) =>
        onUpdate(model.id, resp)
      )
    )
  );

  return Promise.all(promises);
}
