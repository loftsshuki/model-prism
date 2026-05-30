import { describe, it, expect, afterEach } from "bun:test";
import { synthesizeDirect } from "./synthesis";

// Minimal council output passed INTO synthesis — the whole point of the retry is that
// these are already in hand, so a synthesis retry never re-runs the fan-out.
const RESPONSES = [{ model: "openai/gpt-oss-120b", modelName: "GPT-OSS 120B", family: "gpt-oss", response: "looks fine" }];

// A well-formed Anthropic tool_use response carrying a synthesis result.
function ok() {
  return new Response(
    JSON.stringify({ content: [{ type: "tool_use", input: { masterDocument: "SYNTHESIZED" } }] }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Tiny baseDelayMs so the retry path runs without real-time backoff.
const FAST = { baseDelayMs: 1 };

describe("synthesizeDirect — synthesis-only retry", () => {
  it("retries a transient 'fetch failed' then returns one synthesis result (no re-fanout)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed"); // transient network blip
      return ok();
    }) as typeof fetch;

    const result = await synthesizeDirect("key", "opus", "plan", "prompt", RESPONSES, undefined, null, FAST);

    expect(calls).toBe(2); // exactly one failed synthesis attempt + one success — council untouched
    expect((result as { masterDocument: string }).masterDocument).toBe("SYNTHESIZED");
  });

  it("retries on HTTP 503 then succeeds", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return new Response("no healthy upstream", { status: 503 });
      return ok();
    }) as typeof fetch;

    const result = await synthesizeDirect("key", "opus", "p", "pr", RESPONSES, undefined, null, FAST);
    expect(calls).toBe(2);
    expect((result as { masterDocument: string }).masterDocument).toBe("SYNTHESIZED");
  });

  it("fast-fails on a 400 credit-balance body (no retry, original message preserved)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "Your credit balance is too low" } }), { status: 400 });
    }) as typeof fetch;

    await expect(
      synthesizeDirect("key", "opus", "p", "pr", RESPONSES, undefined, null, FAST)
    ).rejects.toThrow(/credit balance/i);
    expect(calls).toBe(1); // non-retryable — must not burn the remaining attempts
  });

  it("gives up after maxAttempts and re-throws the original error verbatim", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("internal error", { status: 500 });
    }) as typeof fetch;

    await expect(
      synthesizeDirect("key", "opus", "p", "pr", RESPONSES, undefined, null, { maxAttempts: 3, baseDelayMs: 1 })
    ).rejects.toThrow(/Anthropic error: 500/);
    expect(calls).toBe(3); // retried up to the bound, then surfaced the last error
  });
});
