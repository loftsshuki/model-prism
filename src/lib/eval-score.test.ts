import { describe, it, expect } from "bun:test";
import {
  matchFlaw, scorePlan, summarize, compareSummaries, renderEvalMarkdown, requiredGroups,
  type SeededFlaw, type EvalFinding, type EvalRunSummary,
} from "./eval-score";
import { findingId } from "./findings";

const authFlaw: SeededFlaw = {
  id: "auth-missing-on-delete",
  severity: "critical",
  category: "security",
  description: "The DELETE /api/listings/[id] route has no session or role check, so anyone can delete listings",
  keywords: ["delete", "listings", "auth|authoriz|session|anyone"],
  location: "app/api/listings/[id]/route.ts",
};

const indexFlaw: SeededFlaw = {
  id: "missing-index",
  severity: "high",
  description: "The neighbourhood query has no composite index on neighborhood_id and status",
  keywords: ["index", "neighborhood_id", "status|published_at", "composite|covering"],
};

describe("requiredGroups", () => {
  it("is ceil(70%) computed without float drift", () => {
    expect(requiredGroups(1)).toBe(1);
    expect(requiredGroups(2)).toBe(2);
    expect(requiredGroups(3)).toBe(3);
    expect(requiredGroups(4)).toBe(3);
    expect(requiredGroups(5)).toBe(4);
    expect(requiredGroups(10)).toBe(7);
  });
});

describe("matchFlaw", () => {
  it("matches by keywords when enough groups hit, using claim + evidence + location", () => {
    const f: EvalFinding = {
      claim: "The DELETE handler for listings is unchanged and has no session check.",
      location: "app/api/listings/[id]/route.ts",
    };
    expect(matchFlaw(authFlaw, f)).toBe("keywords");
  });

  it("any alternative in a group satisfies it, case-insensitively", () => {
    const f: EvalFinding = { claim: "Anyone can DELETE Listings via the API." };
    expect(matchFlaw(authFlaw, f)).toBe("keywords");
  });

  it("allows one miss out of four groups (ceil 70%)", () => {
    const f: EvalFinding = { claim: "Add an index on neighborhood_id and status for the hot query." };
    // "composite|covering" is missing → 3/4 groups → still a keyword match.
    expect(matchFlaw(indexFlaw, f)).toBe("keywords");
  });

  it("falls back to claim similarity against the flaw description", () => {
    const f: EvalFinding = { claim: "The neighbourhood query has no composite index on neighborhood_id and status columns" };
    // Keywords: "index" ✓ "neighborhood_id" ✓ "status" ✓ "composite" ✓ → keywords wins first.
    expect(matchFlaw(indexFlaw, f)).toBe("keywords");
    const flawNoKeywords: SeededFlaw = { ...indexFlaw, keywords: [] };
    expect(matchFlaw(flawNoKeywords, f)).toBe("similarity");
  });

  it("returns null for an unrelated finding", () => {
    const f: EvalFinding = { claim: "The rollout plan lacks a monitoring window after the flag flip." };
    expect(matchFlaw(authFlaw, f)).toBeNull();
    expect(matchFlaw(indexFlaw, f)).toBeNull();
  });

  it("never keyword-matches a flaw with no keywords (ceil(0) guard)", () => {
    const empty: SeededFlaw = { ...authFlaw, keywords: [" ", "|"] };
    expect(matchFlaw(empty, { claim: "Totally unrelated remark about CSS." })).toBeNull();
  });
});

describe("scorePlan", () => {
  const findings: EvalFinding[] = [
    { id: "f_a", claim: "DELETE on listings has no auth check.", location: "app/api/listings/[id]/route.ts" },
    { claim: "Add a composite index on neighborhood_id and status." },
    { id: "f_false", claim: "Consider adding dark mode to the admin dashboard." },
  ];

  it("computes recall, precision, matched, missed and false findings", () => {
    const s = scorePlan("p.md", [authFlaw, indexFlaw], findings);
    expect(s.recall).toBe(1);
    expect(s.criticalRecall).toBe(1);
    expect(s.totalFindings).toBe(3);
    expect(s.falseFindings).toBe(1);
    expect(s.precision).toBeCloseTo(2 / 3);
    expect(s.missed).toEqual([]);
    expect(s.matched.map((m) => m.flaw).sort()).toEqual(["auth-missing-on-delete", "missing-index"]);
    // A finding without an id is reported under its stable claim hash.
    const idx = s.matched.find((m) => m.flaw === "missing-index")!;
    expect(idx.finding).toBe(findingId("Add a composite index on neighborhood_id and status."));
    expect(idx.by).toBe("keywords");
  });

  it("reports missed flaws and partial critical recall", () => {
    const race: SeededFlaw = { id: "race", severity: "critical", description: "Concurrent holds on one unit both succeed", keywords: ["race|concurrent", "hold"] };
    const s = scorePlan("p.md", [authFlaw, race], [findings[0]]);
    expect(s.recall).toBe(0.5);
    expect(s.criticalRecall).toBe(0.5);
    expect(s.missed).toEqual(["race"]);
    expect(s.falseFindings).toBe(0);
    expect(s.precision).toBe(1);
  });

  it("handles empty inputs without NaN", () => {
    expect(scorePlan("p.md", [authFlaw], []).recall).toBe(0);
    expect(scorePlan("p.md", [authFlaw], []).precision).toBe(1);
    expect(scorePlan("p.md", [], findings).recall).toBe(1);
    expect(scorePlan("p.md", [], findings).criticalRecall).toBe(1);
    expect(scorePlan("p.md", [], findings).falseFindings).toBe(3);
  });

  it("a finding matching two flaws is one true finding, not two", () => {
    const both: EvalFinding = { claim: "DELETE on listings has no auth check and the neighborhood_id/status query needs a composite index." };
    const s = scorePlan("p.md", [authFlaw, indexFlaw], [both]);
    expect(s.recall).toBe(1);
    expect(s.falseFindings).toBe(0);
    expect(s.precision).toBe(1);
  });
});

function mkSummary(over: Partial<EvalRunSummary>): EvalRunSummary {
  return {
    runs: [], meanRecall: 0.6, meanPrecision: 0.7, meanCriticalRecall: 0.8, totalCost: 0.1, totalDurationSec: 10,
    roster: "cheap", mode: "fusion", ts: "2026-09-01T00:00:00.000Z", ...over,
  };
}

describe("summarize", () => {
  it("averages per-plan scores and carries the meta through", () => {
    const a = scorePlan("a.md", [authFlaw, indexFlaw], [{ claim: "DELETE on listings lacks auth." }]);
    const b = scorePlan("b.md", [authFlaw], [{ claim: "DELETE on listings lacks auth." }, { claim: "Noise." }]);
    const s = summarize([a, b], { roster: "cheap", mode: "legacy", cost: 0.25, durationSec: 42 });
    expect(s.meanRecall).toBeCloseTo((0.5 + 1) / 2);
    expect(s.meanPrecision).toBeCloseTo((1 + 0.5) / 2);
    expect(s.meanCriticalRecall).toBe(1);
    expect(s.totalCost).toBe(0.25);
    expect(s.totalDurationSec).toBe(42);
    expect(s.roster).toBe("cheap");
    expect(s.mode).toBe("legacy");
    expect(Number.isNaN(Date.parse(s.ts))).toBe(false);
  });

  it("is zero, not NaN, with no runs", () => {
    const s = summarize([], { roster: "x", mode: "fusion", cost: 0, durationSec: 0 });
    expect(s.meanRecall).toBe(0);
    expect(s.meanPrecision).toBe(0);
  });
});

describe("compareSummaries", () => {
  it("is 'same' within the noise floor", () => {
    const c = compareSummaries(mkSummary({}), mkSummary({ meanRecall: 0.61, totalCost: 0.105 }));
    expect(c.verdict).toBe("same");
    expect(c.recallDelta).toBeCloseTo(0.01);
  });

  it("is 'better' when recall rises and nothing regresses", () => {
    const c = compareSummaries(mkSummary({}), mkSummary({ meanRecall: 0.8 }));
    expect(c.verdict).toBe("better");
    expect(c.notes.some((n) => n.startsWith("recall"))).toBe(true);
  });

  it("is 'worse' when recall drops, even if cost falls", () => {
    const c = compareSummaries(mkSummary({}), mkSummary({ meanRecall: 0.4, totalCost: 0.01 }));
    expect(c.verdict).toBe("worse");
    expect(c.costDelta).toBeCloseTo(-0.09);
  });

  it("is 'worse' when only critical recall drops", () => {
    const c = compareSummaries(mkSummary({}), mkSummary({ meanCriticalRecall: 0.5 }));
    expect(c.verdict).toBe("worse");
  });

  it("is 'mixed' when precision rises but cost rises too", () => {
    const c = compareSummaries(mkSummary({}), mkSummary({ meanPrecision: 0.9, totalCost: 0.3 }));
    expect(c.verdict).toBe("mixed");
    expect(c.precisionDelta).toBeCloseTo(0.2);
  });

  it("is 'worse' when only cost rises", () => {
    expect(compareSummaries(mkSummary({}), mkSummary({ totalCost: 0.5 })).verdict).toBe("worse");
  });

  it("notes a roster/mode mismatch and a plan-count mismatch", () => {
    const base = mkSummary({ runs: [scorePlan("a.md", [], [])] });
    const c = compareSummaries(base, mkSummary({ roster: "default", mode: "legacy" }));
    expect(c.notes.join("\n")).toContain("cheap/fusion → default/legacy");
    expect(c.notes.join("\n")).toContain("plan count differs");
  });
});

describe("renderEvalMarkdown", () => {
  it("renders a row per plan, a totals row, missed flaws and the baseline block", () => {
    const a = scorePlan("a.md", [authFlaw, indexFlaw], [{ claim: "DELETE on listings lacks auth." }, { claim: "Noise." }]);
    const s = summarize([a], { roster: "cheap", mode: "fusion", cost: 0.02, durationSec: 3 });
    const md = renderEvalMarkdown(s, mkSummary({}));
    expect(md).toContain("| a.md | 50% (1/2) |");
    expect(md).toContain("**Mean / total**");
    expect(md).toContain("`missing-index`");
    expect(md).toContain("### vs baseline");
    expect(md).toMatch(/\| Recall \| 60% \| 50% \| -10pp \|/);
    // No baseline → no comparison section.
    expect(renderEvalMarkdown(s)).not.toContain("vs baseline");
  });
});
