import { describe, it, expect, afterEach } from "bun:test";
import { classifyHttpError, openrouterChat, parseToolCall, withRetry, OpenRouterError } from "./openrouter";
import { isRetryableFailure } from "./fan-out";
import { coerceSynthesisResult } from "./synthesis";
import { clipForPrompt } from "./prompt-budget";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function sse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + ": OPENROUTER PROCESSING\n\ndata: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("openrouterChat", () => {
  it("accumulates streamed content, tool-call argument deltas, finish_reason and usage", async () => {
    globalThis.fetch = (async () => sse([
      { choices: [{ delta: { content: "Hel" } }] },
      { choices: [{ delta: { content: "lo" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "emit", arguments: "{\"a\":" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0012 } },
    ])) as typeof fetch;
    const deltas: string[] = [];
    const r = await openrouterChat({ apiKey: "k", model: "m", messages: [{ role: "user", content: "x" }], maxTokens: 10, onDelta: (t) => deltas.push(t) });
    expect(r.content).toBe("Hello");
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(r.toolCalls).toEqual([{ id: "c1", name: "emit", arguments: "{\"a\":1}" }]);
    expect(r.finishReason).toBe("tool_calls");
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5, cost: 0.0012 });
    expect(parseToolCall(r, "emit")).toEqual({ a: 1 });
  });

  it("still parses a plain JSON (non-streamed) completion", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "plain" } }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const r = await openrouterChat({ apiKey: "k", model: "m", messages: [], maxTokens: 10 });
    expect(r.content).toBe("plain");
    expect(r.usage.cost).toBeNull();
  });

  it("surfaces an error object delivered mid-stream", async () => {
    globalThis.fetch = (async () => sse([{ error: { message: "provider exploded", code: 502 } }])) as typeof fetch;
    await expect(openrouterChat({ apiKey: "k", model: "m", messages: [], maxTokens: 10 })).rejects.toMatchObject({ code: "stream", retryable: true });
  });

  it("classifies HTTP failures: 401/402/400/404 fail fast, 429/5xx retry", () => {
    expect(classifyHttpError(401, "bad key")).toMatchObject({ code: "auth", retryable: false });
    expect(classifyHttpError(402, "insufficient credits")).toMatchObject({ code: "payment", retryable: false });
    expect(classifyHttpError(400, "context too long")).toMatchObject({ code: "bad_request", retryable: false });
    expect(classifyHttpError(404, "")).toMatchObject({ code: "no_provider", retryable: false });
    expect(classifyHttpError(429, "")).toMatchObject({ code: "rate_limited", retryable: true });
    expect(classifyHttpError(503, "no healthy upstream")).toMatchObject({ code: "upstream", retryable: true });
    // A permanent condition named in the body wins regardless of status.
    expect(classifyHttpError(500, "credit balance is too low")).toMatchObject({ code: "payment", retryable: false });
  });

  it("honours the wall-clock timeout and reports it as retryable", async () => {
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    })) as typeof fetch;
    await expect(openrouterChat({ apiKey: "k", model: "m", messages: [], maxTokens: 10, timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout", retryable: true });
  });

  it("propagates a caller abort as non-retryable", async () => {
    const ac = new AbortController();
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    })) as typeof fetch;
    const p = openrouterChat({ apiKey: "k", model: "m", messages: [], maxTokens: 10, signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: "aborted", retryable: false });
  });
});

describe("parseToolCall", () => {
  it("flags prose-instead-of-tool as retryable and length-truncated JSON as non-retryable", () => {
    const prose = { content: "hi", toolCalls: [], finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0, cost: null } };
    expect(() => parseToolCall(prose)).toThrow(expect.objectContaining({ code: "no_tool_call", retryable: true }));
    const cut = { content: "", toolCalls: [{ name: "t", arguments: "{\"a\": \"unterminated" }], finishReason: "length", usage: prose.usage };
    expect(() => parseToolCall(cut)).toThrow(expect.objectContaining({ code: "truncated", retryable: false }));
  });
});

describe("withRetry", () => {
  it("retries retryable errors with backoff and stops on non-retryable ones", async () => {
    let calls = 0;
    const r = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new OpenRouterError("upstream", "503", { retryable: true });
      return "ok";
    }, { baseDelayMs: 1 });
    expect(r).toBe("ok");
    expect(calls).toBe(3);

    calls = 0;
    await expect(withRetry(async () => {
      calls++;
      throw new OpenRouterError("auth", "401", { retryable: false });
    }, { baseDelayMs: 1 })).rejects.toMatchObject({ code: "auth" });
    expect(calls).toBe(1);
  });
});

describe("isRetryableFailure", () => {
  it("uses the typed error code when present and message heuristics otherwise", () => {
    const base = { model: "m", modelName: "M", status: "error" as const };
    expect(isRetryableFailure({ ...base, errorCode: "no_provider", error: "No provider online" })).toBe(false);
    expect(isRetryableFailure({ ...base, errorCode: "auth", error: "401" })).toBe(false);
    expect(isRetryableFailure({ ...base, errorCode: "upstream", error: "503" })).toBe(true);
    expect(isRetryableFailure({ ...base, error: "No provider online for this model right now" })).toBe(false);
    expect(isRetryableFailure({ ...base, error: "OpenRouter error: 503 overloaded" })).toBe(true);
    expect(isRetryableFailure({ ...base, status: "complete" })).toBe(false);
  });
});

describe("coerceSynthesisResult", () => {
  it("defaults bad enums and missing arrays instead of passing garbage to the renderer", () => {
    const out = coerceSynthesisResult({
      masterDocument: "# Plan",
      consensus: [{ point: "A", supportingModels: ["x"], strength: "very-strong" }, { supportingModels: [] }],
      uniqueInsights: [{ model: "m", insight: "gold" }],
      themeMatrix: [{ theme: "T", scores: { m: 7, n: "2" } }],
    });
    expect(out.consensus).toEqual([{ point: "A", supportingModels: ["x"], strength: "moderate" }]);
    expect(out.uniqueInsights[0].significance).toBe("medium");
    expect(out.disagreements).toEqual([]);
    expect(out.blindSpots).toEqual([]);
    expect(out.themeMatrix).toEqual([{ theme: "T", scores: { m: 3, n: 2 } }]);
  });

  it("rejects a payload with no masterDocument as retryable", () => {
    expect(() => coerceSynthesisResult({ consensus: [] })).toThrow(expect.objectContaining({ code: "malformed_json", retryable: true }));
  });
});

describe("clipForPrompt", () => {
  it("passes short text through and marks what was removed otherwise", () => {
    expect(clipForPrompt("abc", 10)).toBe("abc");
    const clipped = clipForPrompt("x".repeat(30), 10, "plan");
    expect(clipped.startsWith("x".repeat(10))).toBe(true);
    expect(clipped).toContain("plan truncated: 20 characters omitted");
  });
});
