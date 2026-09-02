import { describe, it, expect } from "bun:test";
import { findingId, renderFindingsMarkdown, type Finding } from "./findings";
import { compareReviews, renderComparisonMarkdown, parseFindingRefsFromReview, type ReviewFindingRef } from "./review-compare";

const ref = (claim: string, severity = "medium", extra: Partial<ReviewFindingRef> = {}): ReviewFindingRef => ({
  id: findingId(claim),
  claim,
  severity,
  ...extra,
});

const DROP_TABLE = "The migration in db.ts drops the users table without a backup";
const NO_ZOD = "The review route reads request fields without zod validation";
const RATE_LIMIT = "The public endpoint has no rate limiting";

describe("compareReviews", () => {
  it("matches identical claims by id", () => {
    const prev = [ref(DROP_TABLE, "high"), ref(NO_ZOD)];
    const cur = [ref(NO_ZOD), ref(DROP_TABLE, "critical")];
    const c = compareReviews(prev, cur);
    expect(c.persisting).toHaveLength(2);
    expect(c.persisting.every((p) => p.matchedBy === "id")).toBe(true);
    // Presented in the current review's order, carrying both severities.
    expect(c.persisting[0].current.claim).toBe(NO_ZOD);
    expect(c.persisting[1].previous.severity).toBe("high");
    expect(c.persisting[1].current.severity).toBe("critical");
    expect(c.resolved).toEqual([]);
    expect(c.new).toEqual([]);
  });

  it("matches re-worded claims by similarity when ids differ", () => {
    const reworded = "Migration in db.ts drops users table with no backup taken";
    expect(findingId(reworded)).not.toBe(findingId(DROP_TABLE));
    const c = compareReviews([ref(DROP_TABLE, "high")], [ref(reworded, "high")]);
    expect(c.persisting).toHaveLength(1);
    expect(c.persisting[0].matchedBy).toBe("similarity");
    expect(c.persisting[0].previous.id).toBe(findingId(DROP_TABLE));
    expect(c.persisting[0].current.id).toBe(findingId(reworded));
    expect(c.summary).toContain("1 matched by similarity");
    // A stricter threshold turns the same pair into resolved + new.
    const strict = compareReviews([ref(DROP_TABLE)], [ref(reworded)], { similarityThreshold: 0.99 });
    expect(strict.persisting).toEqual([]);
    expect(strict.resolved).toHaveLength(1);
    expect(strict.new).toHaveLength(1);
  });

  it("classifies resolved and new findings", () => {
    const c = compareReviews([ref(DROP_TABLE), ref(NO_ZOD)], [ref(NO_ZOD), ref(RATE_LIMIT, "low")]);
    expect(c.resolved.map((r) => r.claim)).toEqual([DROP_TABLE]);
    expect(c.new.map((r) => r.claim)).toEqual([RATE_LIMIT]);
    expect(c.persisting.map((p) => p.current.claim)).toEqual([NO_ZOD]);
    expect(c.summary).toBe("1 resolved, 1 still open, 1 new.");
  });

  it("fills missing ids from the claim and ignores blank refs", () => {
    const c = compareReviews([{ id: "", claim: DROP_TABLE, severity: "high" }], [ref(DROP_TABLE), { id: "", claim: "   ", severity: "low" }]);
    expect(c.persisting).toHaveLength(1);
    expect(c.persisting[0].matchedBy).toBe("id");
    expect(c.new).toEqual([]);
  });

  it("handles empty inputs", () => {
    const c = compareReviews([], []);
    expect(c).toEqual({ resolved: [], new: [], persisting: [], summary: "No findings in either review." });
    expect(compareReviews([], [ref(RATE_LIMIT)]).new).toHaveLength(1);
    expect(compareReviews([ref(RATE_LIMIT)], []).resolved).toHaveLength(1);
  });
});

describe("renderComparisonMarkdown", () => {
  it("renders counts and the three sections with ids and severities", () => {
    const reworded = "Migration in db.ts drops users table with no backup taken";
    const c = compareReviews(
      [ref(DROP_TABLE, "high", { category: "data" }), ref(NO_ZOD, "medium", { category: "security", location: "src/app/api/review/route.ts" })],
      [ref(reworded, "critical", { category: "data" }), ref(RATE_LIMIT, "low")],
    );
    const md = renderComparisonMarkdown(c);
    expect(md.startsWith("## Since last review")).toBe(true);
    expect(md).toContain("**1 resolved · 1 still open · 1 new**");
    expect(md).toContain("### Resolved");
    expect(md).toContain(`- **[medium] [security]** ${NO_ZOD} _(src/app/api/review/route.ts)_ \`${findingId(NO_ZOD)}\``);
    expect(md).toContain("### Still open");
    expect(md).toContain(`\`${findingId(reworded)}\` _(was [high]; matched by similarity to \`${findingId(DROP_TABLE)}\`)_`);
    expect(md).toContain("### New");
    expect(md).toContain(`- **[low]** ${RATE_LIMIT} \`${findingId(RATE_LIMIT)}\``);
  });

  it("omits empty sections and returns an empty string when there is nothing to compare", () => {
    expect(renderComparisonMarkdown(compareReviews([], []))).toBe("");
    const md = renderComparisonMarkdown(compareReviews([], [ref(RATE_LIMIT)]));
    expect(md).toContain("### New");
    expect(md).not.toContain("### Resolved");
    expect(md).not.toContain("### Still open");
  });
});

describe("parseFindingRefsFromReview", () => {
  const findings: Finding[] = [
    { id: findingId(DROP_TABLE), claim: DROP_TABLE, severity: "high", category: "data", location: "src/lib/db.ts", evidence: "DROP TABLE users", recommendation: "Back up first.", confidence: "high" },
    { id: findingId(NO_ZOD), claim: NO_ZOD, severity: "medium", category: "security", confidence: "medium", unverified: true },
  ];

  it("recovers refs from renderFindingsMarkdown output", () => {
    const md = "# Review\n\nSome preamble.\n\n" + renderFindingsMarkdown(findings, "Overall the plan is risky.") + "\n\n## Other section\n- a plain bullet\n";
    const refs = parseFindingRefsFromReview(md);
    expect(refs).toEqual([
      { id: findingId(DROP_TABLE), claim: DROP_TABLE, severity: "high", category: "data", location: "src/lib/db.ts" },
      { id: findingId(NO_ZOD), claim: NO_ZOD, severity: "medium", category: "security", location: undefined },
    ]);
  });

  it("tolerates extra text, missing category, missing id, and dedupes", () => {
    const md = [
      `- **[critical] [data]** ${DROP_TABLE} _(src/lib/db.ts)_ (3 of 5 models) \`${findingId(DROP_TABLE)}\` — judge agrees`,
      `* **[Low]** ${RATE_LIMIT}`,
      `- **[critical] [data]** duplicate wording \`${findingId(DROP_TABLE)}\``,
    ].join("\n");
    const refs = parseFindingRefsFromReview(md);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual({ id: findingId(DROP_TABLE), claim: `${DROP_TABLE} (3 of 5 models)`, severity: "critical", category: "data", location: "src/lib/db.ts" });
    expect(refs[1]).toEqual({ id: findingId(RATE_LIMIT), claim: RATE_LIMIT, severity: "low", category: undefined, location: undefined });
  });

  it("accepts a fenced json block tagged findings", () => {
    const md = [
      "## Findings",
      "```json findings",
      JSON.stringify({ findings: [{ id: "f_000000000001", claim: NO_ZOD, severity: "HIGH", category: "security", models: ["a/x", 3] }, { claim: RATE_LIMIT }, { nope: true }] }),
      "```",
      "```json",
      JSON.stringify([{ claim: "not tagged, ignored" }]),
      "```",
      "```findings",
      "{ broken json",
      "```",
    ].join("\n");
    const refs = parseFindingRefsFromReview(md);
    expect(refs).toEqual([
      { id: "f_000000000001", claim: NO_ZOD, severity: "high", category: "security", location: undefined, models: ["a/x"] },
      { id: findingId(RATE_LIMIT), claim: RATE_LIMIT, severity: "medium", category: undefined, location: undefined, models: undefined },
    ]);
  });

  it("returns an empty list for empty or unrelated markdown", () => {
    expect(parseFindingRefsFromReview("")).toEqual([]);
    expect(parseFindingRefsFromReview("# Title\n\n- **bold** but not a finding\n- [high] no bold\n")).toEqual([]);
  });
});
