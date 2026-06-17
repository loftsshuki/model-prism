import { describe, it, expect, afterEach } from "bun:test";
import {
  evidenceId, judgeViaOpenRouter, synthesizeFromJudge, judgeToSynthesisFields,
  extractCitedIds, dropUnresolvedCitations, quoteSupported, tightenProse,
  JudgeResult, JudgeJsonSchema, coerceStrategicCategory, STRATEGIC_CATEGORIES,
  renderDualLensSections, normalizeReviewForSnapshot,
  type JudgeResult as JudgeResultT,
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
  it("defaults a missing schemaVersion to \"2\" (tolerant reader, L6/T5)", () => {
    const p = judgePayload();
    delete (p as Record<string, unknown>).schemaVersion;
    const parsed = JudgeResult.safeParse(p);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.schemaVersion).toBe("2");
  });
  it("still parses legacy schemaVersion \"1\" (no strategic data ≠ parse failure)", () => {
    const parsed = JudgeResult.safeParse(judgePayload({ schemaVersion: "1" }));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.strategic_blind_spots).toEqual([]);
    expect(parsed.success && parsed.data.locked_decisions).toEqual([]);
  });
  it("rejects an unknown schemaVersion (only 1 and 2 are valid)", () => {
    expect(JudgeResult.safeParse(judgePayload({ schemaVersion: "9" as never })).success).toBe(false);
  });
});

describe("dual-lens schema (Phase 1)", () => {
  it("treats an absent strategic_blind_spots array as [] (tolerant, L1)", () => {
    const parsed = JudgeResult.safeParse(judgePayload());
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.strategic_blind_spots).toEqual([]);
  });

  it("validates and tags a strategic blind spot with lens=strategic", () => {
    const p = judgePayload({
      strategic_blind_spots: [{ category: "accessibility", gap: "no keyboard nav", why_it_matters: "WCAG", severity: "high" }] as never,
    });
    const parsed = JudgeResult.safeParse(p);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.strategic_blind_spots[0].lens).toBe("strategic");
  });

  it("coerces an unknown category to 'other' instead of failing (L10/T2)", () => {
    const p = judgePayload({
      strategic_blind_spots: [{ category: "made-up-thing", gap: "g", why_it_matters: "w", severity: "low" }] as never,
    });
    const parsed = JudgeResult.safeParse(p);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.strategic_blind_spots[0].category).toBe("other");
  });

  it("coerceStrategicCategory passes known values through and maps unknowns to other", () => {
    expect(coerceStrategicCategory("i18n")).toBe("i18n");
    expect(coerceStrategicCategory("")).toBe("other");
    expect(coerceStrategicCategory("nonsense")).toBe("other");
    expect(STRATEGIC_CATEGORIES).toContain("accessibility");
  });

  it("PARITY (G10): JudgeJsonSchema properties == Zod keys minus parser-owned locked_decisions", () => {
    const zodKeys = Object.keys((JudgeResult as unknown as { shape: Record<string, unknown> }).shape).sort();
    const schemaKeys = Object.keys(JudgeJsonSchema.properties).sort();
    // locked_decisions is parser-owned (D1) — intentionally absent from the LLM schema.
    expect(zodKeys.filter((k) => k !== "locked_decisions")).toEqual(schemaKeys);
    // Every required key in the LLM schema is a real Zod key.
    for (const req of JudgeJsonSchema.required) expect(zodKeys).toContain(req);
  });

  it("judgeToSynthesisFields backfills lockedDecisions + strategicBlindSpots", () => {
    const judge = JudgeResult.parse(judgePayload({
      locked_decisions: ["Council stays at 10 models"],
      strategic_blind_spots: [{ category: "success-metrics", gap: "no metric", why_it_matters: "unmeasurable", severity: "medium" }] as never,
    }));
    const fields = judgeToSynthesisFields(judge);
    expect(fields.lockedDecisions).toEqual(["Council stays at 10 models"]);
    expect(fields.strategicBlindSpots?.[0]).toEqual({ category: "success-metrics", gap: "no metric", whyItMatters: "unmeasurable", severity: "medium" });
  });

  it("judge overwrites locked_decisions with the parser's output, ignoring any LLM echo", async () => {
    // Even if the model emits its own locked_decisions, the parser's value wins.
    globalThis.fetch = (async () => toolResponse(judgePayload({ locked_decisions: ["LLM-INVENTED"] as never }))) as typeof fetch;
    const r = await judgeViaOpenRouter({
      openrouterKey: "k", draft: "d", responses: [], reviewPrompt: "p",
      lockedDecisions: ["PARSER-TRUTH"], ...FAST,
    });
    expect(r.locked_decisions).toEqual(["PARSER-TRUTH"]);
  });
});

describe("renderDualLensSections (Phase 2 / L7 / L8 / L9)", () => {
  it("LEGACY byte-stability: undefined fields render ZERO lines", () => {
    expect(renderDualLensSections({ criticalityHigh: false })).toEqual([]);
    expect(renderDualLensSections({ criticalityHigh: true })).toEqual([]);
  });

  it("STRATEGIC always renders when the lens ran, even when empty", () => {
    const out = renderDualLensSections({ strategicBlindSpots: [], criticalityHigh: false }).join("\n");
    expect(out).toContain("Strategic Blind Spots — DO NOT SKIP");
    expect(out).toContain("_No strategic blind spots surfaced._");
  });

  it("STRATEGIC orders findings high → medium → low (T9)", () => {
    const out = renderDualLensSections({
      strategicBlindSpots: [
        { category: "i18n", gap: "low one", whyItMatters: "x", severity: "low" },
        { category: "accessibility", gap: "high one", whyItMatters: "y", severity: "high" },
        { category: "success-metrics", gap: "med one", whyItMatters: "z", severity: "medium" },
      ],
      criticalityHigh: false,
    }).join("\n");
    expect(out.indexOf("high one")).toBeLessThan(out.indexOf("med one"));
    expect(out.indexOf("med one")).toBeLessThan(out.indexOf("low one"));
  });

  it("LOCKED renders the constraints block when non-empty", () => {
    const out = renderDualLensSections({ lockedDecisions: ["Council stays at 10"], criticalityHigh: false }).join("\n");
    expect(out).toContain("Locked Founder Decisions");
    expect(out).toContain("1. Council stays at 10");
  });

  it("LOCKED warns when empty AND criticality:high (T7)", () => {
    const out = renderDualLensSections({ lockedDecisions: [], criticalityHigh: true }).join("\n");
    expect(out).toContain("⚠️ High-criticality plan with no locked decisions");
  });

  it("LOCKED omits silently when empty and NOT high-criticality", () => {
    const out = renderDualLensSections({ lockedDecisions: [], criticalityHigh: false });
    // No locked heading; only nothing (strategic absent here too).
    expect(out.join("\n")).not.toContain("Locked Founder Decisions");
    expect(out.join("\n")).not.toContain("⚠️");
  });

  it("normalizeReviewForSnapshot strips timestamps + SHAs for stable diffing", () => {
    const a = "reviewed-at: 2026-06-17T19:43:06.320Z\npinned-sha: a1b2c3d4e5f6\n\n\nbody  ";
    const b = "reviewed-at: 2026-01-01T00:00:00.000Z\npinned-sha: ffffffffffff\n\nbody";
    expect(normalizeReviewForSnapshot(a)).toBe(normalizeReviewForSnapshot(b));
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
