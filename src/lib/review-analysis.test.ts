import { describe, expect, test } from "bun:test";
import { analyzeReviewQuality, buildActionChecklistMarkdown, extractActionItems } from "./review-analysis";
import { SynthesisResult } from "./types";

const synthesis: SynthesisResult = {
  masterDocument: `## Verdict
Do not ship until critical auth checks are fixed.

- Fix src/app/api/admin/route.ts authorization before approval.
- Add regression tests for tenant isolation.
- Decide whether launch can proceed without automated rollback.
- Later, document the runbook.`,
  consensus: [
    { point: "Auth boundaries need review", supportingModels: ["A", "B", "C"], strength: "strong" },
    { point: "Tests are missing", supportingModels: ["A", "B"], strength: "moderate" },
  ],
  uniqueInsights: [
    { model: "A", insight: "Rollback path is undefined", significance: "high" },
  ],
  disagreements: [
    { topic: "Launch readiness", positions: [{ models: ["A"], position: "Wait" }, { models: ["B"], position: "Ship with guardrails" }] },
  ],
  blindSpots: ["No production telemetry details were provided"],
  themeMatrix: [
    { theme: "Security", scores: { A: 3, B: 2 } },
    { theme: "Testing", scores: { A: 2, B: 3 } },
    { theme: "Operations", scores: { A: 2, B: 1 } },
  ],
};

describe("review analysis", () => {
  test("extracts prioritized action items from synthesis text", () => {
    const items = extractActionItems(synthesis);

    expect(items.some((item) => item.file === "src/app/api/admin/route.ts" && item.priority === "must")).toBe(true);
    expect(items.some((item) => item.category === "decision" && item.owner === "Human")).toBe(true);
    expect(items.some((item) => item.category === "risk")).toBe(true);
  });

  test("scores review quality with risk and actionability signals", () => {
    const score = analyzeReviewQuality(synthesis);

    expect(score.score).toBeGreaterThan(50);
    expect(["Medium", "High"]).toContain(score.risk);
    expect(score.actionability).not.toBe("Low");
    expect(score.reasons.length).toBeGreaterThan(0);
  });

  test("builds a copyable markdown checklist", () => {
    const checklist = buildActionChecklistMarkdown(extractActionItems(synthesis));

    expect(checklist).toContain("- [ ]");
    expect(checklist).toContain("SRC/APP/API/ADMIN/ROUTE.TS".toLowerCase());
  });
});
