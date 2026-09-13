import { getModel } from "./model-catalog";
import { BudgetExceededError, requestCeiling, requestCost, RunBudget } from "./run-budget";
import type { ModelInfo, ModelUsage } from "./types";

export interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
export interface CompletionData {
  id?: string;
  model?: string;
  choices: Array<{ finish_reason?: string | null; native_finish_reason?: string; message: {
    role?: string; content?: string | null; tool_calls?: ToolCall[]; reasoning_details?: unknown[];
  } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}
export class ProviderError extends Error {
  constructor(message: string, public status = 0, public retryAfterMs = 0) { super(message); this.name = "ProviderError"; }
  get retryable() { return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500; }
}
export function isCancelled(error: unknown): boolean { return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"); }
export function abortError() { return new DOMException("Stopped", "AbortError"); }
export function sleepWithSignal(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const abort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export interface CompletionOptions {
  apiKey: string;
  model: string | ModelInfo;
  messages: unknown[];
  maxTokens: number;
  tools?: unknown[];
  toolChoice?: unknown;
  temperature?: number;
  reasoningEffort?: string;
  signal?: AbortSignal;
  budget?: RunBudget;
  onUsage?: (usage: ModelUsage) => void;
  onText?: (text: string) => void;
  maxAttempts?: number;
  baseDelayMs?: number;
  fetchImpl?: typeof fetch;
}

export function supportedEffort(model: ModelInfo, effort = "medium") {
  const supported = model.reasoning?.supported_efforts;
  if (!model.reasoning) return undefined;
  if (supported?.includes(effort)) return effort;
  if (supported?.length) {
    const order = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
    const index = Math.max(0, order.indexOf(effort));
    return [...supported].sort((a, b) => Math.abs(order.indexOf(a) - index) - Math.abs(order.indexOf(b) - index))[0];
  }
  return model.reasoning.mandatory && effort === "none" ? "low" : effort;
}

function errorMessage(error: unknown) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return "Provider returned an error";
}

async function readCompletion(res: Response, onText?: (text: string) => void): Promise<CompletionData> {
  if (!res.headers.get("content-type")?.includes("text/event-stream")) {
    const data = await res.json();
    if (data.error) throw new ProviderError(errorMessage(data.error), Number(data.error.code) || 502);
    return data;
  }
  if (!res.body) throw new ProviderError("Empty response stream", 502);
  const data: CompletionData = { choices: [{ message: { role: "assistant", content: "" } }] };
  const calls = new Map<number, ToolCall>();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let doneMarker = false;
  const parseLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    const text = line.slice(5).trim();
    if (text === "[DONE]") { doneMarker = true; return; }
    if (!text) return;
    const part = JSON.parse(text);
    if (part.error) throw new ProviderError(errorMessage(part.error), Number(part.error.code) || 502);
    if (part.id) data.id = part.id;
    if (part.model) data.model = part.model;
    if (part.usage) data.usage = part.usage;
    const choice = part.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) data.choices[0].finish_reason = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string") {
      data.choices[0].message.content += delta.content;
      onText?.(data.choices[0].message.content!);
    }
    if (Array.isArray(delta.reasoning_details)) data.choices[0].message.reasoning_details = [...(data.choices[0].message.reasoning_details ?? []), ...delta.reasoning_details];
    for (const call of delta.tool_calls ?? []) {
      const current = calls.get(call.index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
      if (call.id) current.id = call.id;
      if (call.function?.name) current.function.name += call.function.name;
      if (call.function?.arguments) current.function.arguments += call.function.arguments;
      calls.set(call.index, current);
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) parseLine(line);
      if (done) { if (pending) parseLine(pending); break; }
    }
  } finally { reader.releaseLock(); }
  if (calls.size) data.choices[0].message.tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
  if (!doneMarker && !data.choices[0].finish_reason) data.choices[0].finish_reason = "interrupted";
  return data;
}

export async function requestCompletion(opts: CompletionOptions): Promise<CompletionData> {
  const model = typeof opts.model === "string" ? getModel(opts.model) : opts.model;
  if (!model) throw new Error(`Missing current model metadata: ${opts.model}`);
  if (opts.tools?.length && model.toolCallApi === "responses") throw new Error(`${model.name} requires the Responses API for tool use. Choose a chat-tool-capable reviewer.`);
  const maxTokens = Math.min(opts.maxTokens, model.maxOutputTokens ?? opts.maxTokens);
  const inputEstimate = Math.ceil(JSON.stringify([opts.messages, opts.tools]).length / 2.5) + 512;
  if (inputEstimate + maxTokens > model.contextLength) throw new Error(`${model.name}: input plus output budget exceeds its context window.`);
  const attempts = opts.maxAttempts ?? 3;
  for (let attempt = 0; attempt < attempts; attempt++) {
    opts.signal?.throwIfAborted();
    const requestId = crypto.randomUUID();
    const ceiling = requestCeiling(model, opts.messages, maxTokens, opts.tools);
    opts.budget?.reserve(requestId, ceiling);
    let sent = false;
    let settled = false;
    const settle = (usage: ModelUsage) => {
      settled = true; opts.budget?.settle(requestId, usage); opts.onUsage?.(usage);
    };
    const signal = AbortSignal.any([...(opts.signal ? [opts.signal] : []), AbortSignal.timeout(240000)]);
    try {
      const effort = supportedEffort(model, opts.reasoningEffort);
      const parameters = model.supportedParameters;
      const supports = (key: string) => !parameters || parameters.includes(key);
      sent = true;
      const res = await (opts.fetchImpl ?? fetch)("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST", signal,
        headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json", "X-Title": "Model Prism", "HTTP-Referer": "https://model-prism.vercel.app" },
        body: JSON.stringify({ model: model.id, messages: opts.messages, max_tokens: maxTokens,
          stream: true, stream_options: { include_usage: true },
          ...(effort && supports("reasoning") ? { reasoning: { effort } } : {}),
          ...(opts.tools?.length ? { tools: opts.tools, ...(supports("tool_choice") ? { tool_choice: opts.toolChoice ?? "auto" } : {}) } : {}),
          ...(opts.temperature !== undefined && supports("temperature") ? { temperature: opts.temperature } : {}),
          provider: { require_parameters: true, max_price: { prompt: model.inputCostPer1k * 1000, completion: model.outputCostPer1k * 1000 } },
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        // Rejected requests did not generate output; do not count them as a model charge.
        opts.budget?.release(requestId); settled = true;
        const retry = res.headers.get("retry-after");
        const retryMs = retry ? (/^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now())) : 0;
        throw new ProviderError(`OpenRouter error: ${res.status} ${body.slice(0, 240)}`, res.status, retryMs);
      }
      const data = await readCompletion(res, opts.onText);
      const u = data.usage;
      const providerCost = typeof u?.cost === "number" && Number.isFinite(u.cost) && u.cost >= 0;
      const hasTokens = typeof u?.prompt_tokens === "number" && typeof u?.completion_tokens === "number";
      settle({ requestId, model: data.model ?? model.id, inputTokens: u?.prompt_tokens ?? 0, outputTokens: u?.completion_tokens ?? 0,
        cost: providerCost ? u!.cost! : hasTokens ? requestCost(model, u!.prompt_tokens!, u!.completion_tokens!) : ceiling,
        costSource: providerCost ? "provider" : hasTokens ? "estimated" : "reserved" });
      return data;
    } catch (error) {
      if (!settled) {
        if (sent) settle({ requestId, model: model.id, inputTokens: 0, outputTokens: 0, cost: ceiling, costSource: "reserved" });
        else opts.budget?.release(requestId);
      }
      if (isCancelled(error) || opts.signal?.aborted || error instanceof BudgetExceededError) throw error;
      if (error instanceof ProviderError && !error.retryable) throw error;
      if (attempt + 1 >= attempts) throw error;
      await sleepWithSignal(Math.max(error instanceof ProviderError ? error.retryAfterMs : 0, (opts.baseDelayMs ?? 1000) * 2 ** attempt), opts.signal);
    }
  }
  throw new Error("No model response");
}
