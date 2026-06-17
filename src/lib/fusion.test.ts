import { describe, it, expect, afterEach } from "bun:test";
import {
  evidenceId, judgeViaOpenRouter, synthesizeFromJudge, judgeToSynthesisFields,
  extractCitedIds, dropUnresolvedCitations, quoteSupported, tightenProse,
  JudgeResult, type JudgeResult as JudgeResultT,
} from "./fusion";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const FAST = { baseDelayMs: 1 };

// A complete, valid judge payload.
function judgePayload(overrides: Partial<JudgeResultT> = {}) {
  return {
    schemaVersion: "1",
    consensus: [{ claim: "use a lock", support: ["m1", "m2"] }],
    contradictions: [],
    partial_coverage: [],
    unique_insights: [{ insight: "race on rename", raised_by: ["m3"] }],
    blind_spots: [{ gap: "no rollback", why_it_matters: "prod risk" }],
    evidence: [{ id: "", source: "model:m1", quote: "acquire a lock first", confidence: "high" }],
    ...overrides,
  };
}

function toolResponse(args: unknown, finishReason = "tool_calls") {
  return new Response(
    JSON.stringify({ choices: [{ finish_reason: finishReason, message: { tool_calls: [{ function: { arguments: JSON.stringify(args) } }] } }] }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("evidenceId", () => {
  it("is deterministic and content-addressed", () => {
    const a = evidenceId("model:m1", "hello world");
    expect(a).toBe(evidenceId("model:m1", "hello world"));
    expect(a).not.toBe(evidenceId("model:m2", "hello world"));
    expect(a).toMatch(/^e_[0-9a-f]{12}$/);
  });
});

describe("JudgeResult schema", () => {
  it("validates a full payload and applies array defaults", () => {
    const parsed = JudgeResult.safeParse(judgePayload());
    expect(parsed.success).toBe(true);
  });
  it("rejects a payload missing schemaVersion", () => {
    const p = judgePayload();
    delete (p as Record<string, unknown>).schemaVersion;
    expect(JudgeResult.safeParse(p).success).toBe(false);
  });
});

describe("judgeViaOpenRouter", () => {
  it("returns a validated result and recomputes evidence ids deterministically", async () => {
    globalThis.fetch = (async () => toolResponse(judgePayload())) as typeof fetch;
    const r = await judgeViaOpenRouter({ openrouterKey: "k", draft: "d", responses: [], reviewPrompt: "p", ...FAST });
    expect(r.consensus[0].claim).toBe("use a lock");
    // id was blank in the payload; must be recomputed
    expect(r.evidence[0].id).toBe(evidenceId("model:m1", "acquire a lock first"));
  });

  it("retries on a no-tool-call (prose) response then succeeds", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "prose" } }] }), { status: 200 });
      return toolResponse(judgePayload());
    }) as typeof fetch;
    const r = await judgeViaOpenRouter({ openrouterKey: "k", draft: "d", responses: [], reviewPrompt: "p", ...FAST });
    expect(calls).toBe(2);
    expect(r.unique_insights).toHaveLength(1);
  });

  it("fast-fails (non-retryable) on a type_mismatch and throws JudgeError", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return toolResponse(judgePayload({ consensus: [{ claim: 123 as unknown as string, support: [] }] }));
    }) as typeof fetch;
    await expect(
      judgeViaOpenRouter({ openrouterKey: "k", draft: "d", responses: [], reviewPrompt: "p", maxAttempts: 4, baseDelayMs: 1 })
    ).rejects.toThrow(/type mismatch/i);
    expect(calls).toBe(1); // non-retryable → no wasted retries
  });

  it("nudges temperature on vacuous output then accepts a real one", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return toolResponse(judgePayload({ consensus: [], unique_insights: [], blind_spots: [] }));
      return toolResponse(judgePayload());
    }) as typeof fetch;
    const r = await judgeViaOpenRouter({ openrouterKey: "k", draft: "d", responses: [], reviewPrompt: "p", ...FAST });
    expect(calls).toBe(2);
    expect(r.blind_spots).toHaveLength(1);
  });

  it("fast-fails on a 401 (non-retryable HTTP)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response("auth", { status: 401 }); }) as typeof fetch;
    await expect(
      judgeViaOpenRouter({ openrouterKey: "k", draft: "d", responses: [], reviewPrompt: "p", maxAttempts: 4, baseDelayMs: 1 })
    ).rejects.toThrow(/401/);
    expect(calls).toBe(1);
  });
});

describe("synthesizeFromJudge", () => {
  const judge = JudgeResult.parse(judgePayload());
  it("returns masterDocument and backfills structured fields from the judge when synthesizer omits them", async () => {
    globalThis.fetch = (async () => toolResponse({ masterDocument: "MASTER", consensus: [], uniqueInsights: [], disagreements: [], blindSpots: [] })) as typeof fetch;
    const r = await synthesizeFromJudge({ openrouterKey: "k", judge, draft: "d", ...FAST });
    expect(r.masterDocument).toBe("MASTER");
    // empty synthesizer arrays → backfilled from judge
    expect(r.blindSpots.length).toBe(1);
    expect(r.uniqueInsights.length).toBe(1);
  });
});

describe("judgeToSynthesisFields", () => {
  it("maps consensus support count to strength", () => {
    const j = JudgeResult.parse(judgePayload({
      consensus: [
        { claim: "a", support: ["1", "2", "3", "4"] },
        { claim: "b", support: ["1", "2"] },
        { claim: "c", support: ["1"] },
      ],
    }));
    const f = judgeToSynthesisFields(j);
    expect(f.consensus.map((c) => c.strength)).toEqual(["strong", "moderate", "weak"]);
  });
});

describe("citation integrity", () => {
  it("extracts cited evidence ids", () => {
    expect(extractCitedIds("ground it (e_abcdef012345) here and e_001122334455 too")).toEqual(["e_abcdef012345", "e_001122334455"]);
  });
  it("drops invented citations but keeps valid ones", () => {
    const valid = new Set(["e_abcdef012345"]);
    const { text, dropped } = dropUnresolvedCitations("real (e_abcdef012345) fake (e_999999999999) end", valid);
    expect(dropped).toEqual(["e_999999999999"]);
    expect(text).toContain("(e_abcdef012345)");
    expect(text).not.toContain("e_999999999999");
  });
  it("quoteSupported: exact normalized match passes, fabricated fails", () => {
    expect(quoteSupported("acquire a   LOCK first", "you must acquire a lock first before writing")).toBe(true);
    expect(quoteSupported("delete the database", "you must acquire a lock first")).toBe(false);
  });
  it("quoteSupported: long quote tolerates elision via token overlap", () => {
    const long = "the worker must acquire an exclusive per plan lock before it begins synthesizing the council output into a master document for the founder";
    const src = "the worker must acquire an exclusive per plan lock before it begins synthesizing the council output into a master document";
    expect(quoteSupported(long, src)).toBe(true);
  });
});

describe("tightenProse", () => {
  it("collapses blank-line runs and strips trailing whitespace", () => {
    expect(tightenProse("a  \n\n\n\nb   \n")).toBe("a\n\nb");
  });
});
