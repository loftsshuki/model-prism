import { describe, it, expect } from "bun:test";
import {
  findingId, normalizeClaim, claimSimilarity, coerceFindings, clusterFindings, classifyCluster,
  consensusBlock, SaturationTracker, renderFindingsMarkdown, type MemberFindings,
} from "./findings";

describe("findingId", () => {
  it("is stable across whitespace, case and punctuation differences", () => {
    const a = findingId("The `deleteListing` route has no auth check.");
    const b = findingId("the deleteListing route has   no auth check");
    expect(a).toBe(b);
    expect(a).toMatch(/^f_[0-9a-f]{12}$/);
    expect(findingId("something else entirely")).not.toBe(a);
  });
  it("normalizes claims predictably", () => {
    expect(normalizeClaim("  Hello, `World`!  ")).toBe("hello world");
  });
});

describe("claimSimilarity", () => {
  it("scores paraphrases high and unrelated claims low", () => {
    const a = "The DELETE listings route is missing an authorization check";
    const b = "Listings DELETE endpoint has no authorization check on the route";
    const c = "The nightly backfill job will time out on the bookings table";
    expect(claimSimilarity(a, b)).toBeGreaterThan(0.42);
    expect(claimSimilarity(a, c)).toBeLessThan(0.2);
    expect(claimSimilarity(a, a)).toBe(1);
  });
});

describe("coerceFindings", () => {
  it("defaults bad enums, salvages claim-only items, assigns ids, dedupes, sorts by severity", () => {
    const out = coerceFindings({
      summary: "  Mostly fine. ",
      findings: [
        { claim: "Low thing", severity: "low", category: "other" },
        { claim: "Critical thing", severity: "CRITICAL", category: "bogus" },
        { claim: "Critical thing", severity: "critical" },
        { severity: "high" },
        "junk",
      ],
    });
    expect(out.summary).toBe("Mostly fine.");
    expect(out.findings.map((f) => f.claim)).toEqual(["Critical thing", "Low thing"]);
    expect(out.findings[0].severity).toBe("medium"); // "CRITICAL" is not a valid enum → default
    expect(out.findings[0].category).toBe("other");
    expect(out.findings[0].id).toMatch(/^f_/);
  });
  it("tolerates a non-object payload", () => {
    expect(coerceFindings(null)).toEqual({ findings: [], summary: "" });
  });
});

function member(model: string, family: string, claims: Array<[string, "critical" | "high" | "medium" | "low" | "info"]>): MemberFindings {
  return {
    model, modelName: model, family,
    findings: claims.map(([claim, severity]) => ({ id: findingId(claim), claim, severity, category: "other" as const, confidence: "medium" as const })),
  };
}

describe("clusterFindings", () => {
  it("groups paraphrased claims across families and keeps distinct ones apart", () => {
    const clusters = clusterFindings([
      member("m1", "gpt", [["The DELETE listings route is missing an authorization check", "critical"], ["No index on bookings.listing_id makes the search query slow", "medium"]]),
      member("m2", "gemini", [["Listings DELETE endpoint has no authorization check on the route", "high"]]),
      member("m3", "gpt", [["DELETE listings route lacks an authorization check", "high"]]),
      member("m4", "deepseek", [["The plan references src/lib/payments.ts which does not exist", "high"]]),
    ]);
    const auth = clusters.find((c) => /authorization/.test(c.claim))!;
    expect(auth.families.sort()).toEqual(["gemini", "gpt"]);
    expect(auth.models.length).toBe(3);
    expect(auth.severity).toBe("critical");
    expect(clusters.length).toBe(3);
    expect(clusters[0]).toBe(auth); // most-supported first
    expect(classifyCluster(auth, 3)).toBe("consensus");
    expect(classifyCluster(clusters[1], 3)).toBe("unique");
  });
  it("renders a computed consensus block the judge can cite", () => {
    const clusters = clusterFindings([member("m1", "gpt", [["A thing", "high"]])]);
    const block = consensusBlock(clusters, 1);
    expect(block).toContain("<computed_consensus");
    expect(block).toContain(clusters[0].id);
    expect(consensusBlock([], 1)).toBe("");
  });
});

describe("SaturationTracker", () => {
  it("reports saturation only after a window of responses that added nothing", () => {
    const t = new SaturationTracker();
    expect(t.add(member("m1", "a", [["The DELETE route is missing an authorization check", "high"]]))).toBe(1);
    expect(t.add(member("m2", "b", [["A nightly backfill will time out on the bookings table", "medium"]]))).toBe(1);
    expect(t.isSaturated()).toBe(false);
    t.add(member("m3", "c", [["DELETE route lacks an authorization check", "high"]]));
    t.add(member("m4", "d", [["Nightly backfill times out on the bookings table", "medium"]]));
    expect(t.isSaturated(2)).toBe(true);
    expect(t.isSaturated(3)).toBe(false);
    t.add(member("m5", "e", [["The DELETE route is missing an authorization check", "high"]]));
    expect(t.isSaturated(3)).toBe(true);
    expect(t.clusters).toBe(2);
  });
});

describe("renderFindingsMarkdown", () => {
  it("emits the id on each line so review files can be diffed later", () => {
    const md = renderFindingsMarkdown(coerceFindings({ findings: [{ claim: "X is broken", severity: "high", category: "correctness", evidence: "x()", recommendation: "fix x" }] }).findings, "Summary.");
    expect(md).toContain("Summary.");
    expect(md).toMatch(/\*\*\[high\] \[correctness\]\*\* X is broken `f_[0-9a-f]{12}`/);
    expect(md).toContain("Evidence:");
    expect(md).toContain("Fix: fix x");
  });
});
