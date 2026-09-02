// ═══════════════════════════════════════════════════════════════════════════
// Shared OpenRouter chat-completions client.
//
// One implementation of the request/stream/parse/classify loop that used to be
// copied (with drifting retry rules) across fan-out.ts, synthesis.ts, fusion.ts,
// fusion-agentic.ts and context-packs.ts. Browser-safe: no node: imports.
//
// Why streaming by default: a non-streaming request only delivers its headers
// after the model has finished generating. Node's undici cuts the connection at
// 300s of header silence, so a 32k-token synthesis that takes longer than five
// minutes surfaced as a bare "fetch failed" and was retried at full cost. With
// stream:true the first bytes arrive immediately and the read is bounded by an
// explicit wall-clock timeout instead.
// ═══════════════════════════════════════════════════════════════════════════

export type OpenRouterErrorCode =
  | "auth"           // 401/403, bad key
  | "payment"        // 402 / credit balance exhausted
  | "bad_request"    // 400 (malformed request, context too long)
  | "no_provider"    // 404: nobody is serving this model right now
  | "rate_limited"   // 429
  | "upstream"       // 5xx / provider overloaded
  | "timeout"        // our wall-clock deadline
  | "aborted"        // caller's AbortSignal fired
  | "network"        // fetch failed / connection reset
  | "empty"          // 200 but no content (reasoning ate the budget, etc.)
  | "truncated"      // finish_reason=length
  | "no_tool_call"   // tool call requested but the model replied in prose
  | "malformed_json" // tool-call arguments not parseable
  | "stream";        // error object delivered mid-stream

export class OpenRouterError extends Error {
  code: OpenRouterErrorCode;
  status?: number;
  retryable: boolean;
  finishReason?: string | null;
  constructor(code: OpenRouterErrorCode, message: string, opts: { status?: number; retryable: boolean; finishReason?: string | null }) {
    super(message);
    this.name = "OpenRouterError";
    this.code = code;
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.finishReason = opts.finishReason;
  }
}

// A response body names a permanent condition regardless of the HTTP status that
// carried it (some "credit balance too low" replies come back as a plain 4xx).
export function isNonRetryableBody(body: string): boolean {
  const b = body.toLowerCase();
  return b.includes("credit balance") || b.includes("insufficient credit") ||
    b.includes("invalid_request") || b.includes("authentication");
}

export function classifyHttpError(status: number, body: string): OpenRouterError {
  const snippet = body.slice(0, 200);
  const msg = `OpenRouter error: ${status} ${snippet}`;
  if (status === 401 || status === 403) return new OpenRouterError("auth", msg, { status, retryable: false });
  if (status === 402) return new OpenRouterError("payment", msg, { status, retryable: false });
  if (status === 400) return new OpenRouterError("bad_request", msg, { status, retryable: false });
  if (status === 404) return new OpenRouterError("no_provider", "No provider online for this model right now", { status, retryable: false });
  if (status === 429) return new OpenRouterError("rate_limited", msg, { status, retryable: true });
  if (isNonRetryableBody(body)) return new OpenRouterError("payment", msg, { status, retryable: false });
  if (status >= 500) return new OpenRouterError("upstream", msg, { status, retryable: true });
  return new OpenRouterError("upstream", msg, { status, retryable: true });
}

export function toOpenRouterError(e: unknown): OpenRouterError {
  if (e instanceof OpenRouterError) return e;
  if (e instanceof Error) {
    if (e.name === "AbortError") return new OpenRouterError("aborted", "Request aborted", { retryable: false });
    if (e.name === "TimeoutError") return new OpenRouterError("timeout", e.message, { retryable: true });
    return new OpenRouterError("network", e.message || "Network error", { retryable: true });
  }
  return new OpenRouterError("network", String(e), { retryable: true });
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description?: string; parameters: unknown };
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  /** USD, as reported by OpenRouter when `usage.include` is honoured; null otherwise. */
  cost: number | null;
}

export interface ChatResult {
  content: string;
  toolCalls: Array<{ id?: string; name: string; arguments: string }>;
  finishReason: string | null;
  usage: ChatUsage;
}

export interface ChatOptions {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  /** Wall-clock deadline for the whole request including the streamed body. Default 5 min. */
  timeoutMs?: number;
  /** Caller-owned cancellation (e.g. the Stop button). */
  signal?: AbortSignal;
  /** Streaming is on by default; pass false for endpoints/mocks that only speak JSON. */
  stream?: boolean;
  /** Called with each content delta while streaming. */
  onDelta?: (text: string) => void;
  /** Shown in the OpenRouter dashboard. */
  title?: string;
}

export const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function readUsage(u: { prompt_tokens?: number; completion_tokens?: number; cost?: number } | undefined): ChatUsage {
  return {
    inputTokens: u?.prompt_tokens ?? 0,
    outputTokens: u?.completion_tokens ?? 0,
    cost: typeof u?.cost === "number" ? u.cost : null,
  };
}

interface StreamAccumulator {
  content: string;
  toolCalls: Map<number, { id?: string; name: string; arguments: string }>;
  finishReason: string | null;
  usage: ChatUsage;
}

function applyChunk(acc: StreamAccumulator, chunk: Record<string, unknown>, onDelta?: (t: string) => void) {
  const err = chunk.error as { message?: string; code?: number } | undefined;
  if (err) {
    throw new OpenRouterError("stream", `OpenRouter stream error: ${err.message ?? JSON.stringify(err)}`, {
      status: err.code, retryable: true,
    });
  }
  const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0];
  if (choice) {
    const delta = choice.delta as { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } | undefined;
    if (delta?.content) {
      acc.content += delta.content;
      onDelta?.(delta.content);
    }
    for (const tc of delta?.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      const existing = acc.toolCalls.get(idx) ?? { id: tc.id, name: "", arguments: "" };
      if (tc.id) existing.id = tc.id;
      if (tc.function?.name) existing.name += tc.function.name;
      if (tc.function?.arguments) existing.arguments += tc.function.arguments;
      acc.toolCalls.set(idx, existing);
    }
    const fr = (choice.finish_reason ?? choice.native_finish_reason) as string | null | undefined;
    if (fr) acc.finishReason = fr;
  }
  if (chunk.usage) acc.usage = readUsage(chunk.usage as Parameters<typeof readUsage>[0]);
}

async function readEventStream(res: Response, onDelta?: (t: string) => void): Promise<ChatResult> {
  const acc: StreamAccumulator = { content: "", toolCalls: new Map(), finishReason: null, usage: readUsage(undefined) };
  if (!res.body) throw new OpenRouterError("network", "Empty response body", { retryable: true });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (!line || line.startsWith(":")) continue; // keep-alive comments
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      let chunk: Record<string, unknown>;
      try { chunk = JSON.parse(payload); } catch { continue; }
      applyChunk(acc, chunk, onDelta);
    }
  }
  return {
    content: acc.content,
    toolCalls: [...acc.toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v),
    finishReason: acc.finishReason,
    usage: acc.usage,
  };
}

function parseJsonCompletion(data: Record<string, unknown>): ChatResult {
  const err = data.error as { message?: string } | undefined;
  if (err && !data.choices) {
    throw new OpenRouterError("upstream", `OpenRouter error: ${err.message ?? JSON.stringify(err)}`, { retryable: true });
  }
  const choice = (data.choices as Array<Record<string, unknown>> | undefined)?.[0];
  const message = choice?.message as { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } | undefined;
  return {
    content: message?.content ?? "",
    toolCalls: (message?.tool_calls ?? []).map((tc) => ({ id: tc.id, name: tc.function?.name ?? "", arguments: tc.function?.arguments ?? "" })),
    finishReason: ((choice?.finish_reason ?? choice?.native_finish_reason) as string | null | undefined) ?? null,
    usage: readUsage(data.usage as Parameters<typeof readUsage>[0]),
  };
}

/**
 * One OpenRouter chat-completions call. Throws OpenRouterError (with `.retryable`)
 * on any failure; never retries by itself — callers own the retry policy.
 */
export async function openrouterChat(opts: ChatOptions): Promise<ChatResult> {
  const stream = opts.stream ?? true;
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onOuterAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) { clearTimeout(timer); throw new OpenRouterError("aborted", "Request aborted", { retryable: false }); }
    opts.signal.addEventListener("abort", onOuterAbort, { once: true });
  }

  try {
    const res = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://model-prism.vercel.app",
        "X-Title": opts.title ?? "Model Prism",
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.tools ? { tools: opts.tools } : {}),
        ...(opts.toolChoice ? { tool_choice: opts.toolChoice } : {}),
        usage: { include: true },
        stream,
        messages: opts.messages,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw classifyHttpError(res.status, body);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      return await readEventStream(res, opts.onDelta);
    }
    const data = await res.json();
    const result = parseJsonCompletion(data);
    if (result.content && opts.onDelta) opts.onDelta(result.content);
    return result;
  } catch (e) {
    if (timedOut) throw new OpenRouterError("timeout", `Request exceeded ${Math.round(timeoutMs / 1000)}s`, { retryable: true });
    if (opts.signal?.aborted) throw new OpenRouterError("aborted", "Request aborted", { retryable: false });
    throw toOpenRouterError(e);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * Extract and parse the first tool call from a result. Classifies the two failure
 * modes the pipeline cares about: prose instead of a tool call (retryable) and
 * JSON cut off by max_tokens (not retryable at the same cap).
 */
export function parseToolCall<T = unknown>(result: ChatResult, toolName?: string): T {
  const call = toolName ? result.toolCalls.find((c) => c.name === toolName) ?? result.toolCalls[0] : result.toolCalls[0];
  if (!call || !call.arguments) {
    throw new OpenRouterError("no_tool_call", `No structured output (tool_call) returned (finish_reason=${result.finishReason ?? "unknown"})`, {
      retryable: true, finishReason: result.finishReason,
    });
  }
  try {
    return JSON.parse(call.arguments) as T;
  } catch {
    const truncated = result.finishReason === "length";
    const detail = `finish_reason=${result.finishReason ?? "unknown"}, args_len=${call.arguments.length}, tail=${JSON.stringify(call.arguments.slice(-60))}`;
    throw new OpenRouterError(
      truncated ? "truncated" : "malformed_json",
      truncated ? `Tool_call truncated by max_tokens (${detail})` : `Tool_call arguments were not valid JSON (${detail})`,
      { retryable: !truncated, finishReason: result.finishReason },
    );
  }
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  /** Called before sleeping; return false to stop retrying. */
  onRetry?: (error: OpenRouterError, attempt: number, delayMs: number) => void | boolean;
}

/** Exponential backoff with jitter over a function that throws OpenRouterError. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 2000;
  let lastError: OpenRouterError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      const err = toOpenRouterError(e);
      lastError = err;
      if (!err.retryable || attempt >= maxAttempts) throw err;
      const delayMs = baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
      const keepGoing = opts.onRetry?.(err, attempt, delayMs);
      if (keepGoing === false) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError ?? new OpenRouterError("network", "Retry loop exited without result", { retryable: false });
}
