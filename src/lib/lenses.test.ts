import { describe, it, expect } from "bun:test";
import { REVIEW_LENSES, assignLenses, lensPrompt, lensCoverage, type LensModel } from "./lenses";

const COUNCIL: LensModel[] = [
  { id: "openai/gpt-5.5", family: "openai", tier: "paid" },
  { id: "anthropic/claude-sonnet-4.8", family: "anthropic", tier: "paid" },
  { id: "google/gemini-3.1-pro", family: "google", tier: "paid" },
  { id: "anthropic/claude-opus-4.8", family: "anthropic", tier: "paid" },
  { id: "openai/gpt-5.5-mini", family: "openai", tier: "cheap" },
  { id: "deepseek/deepseek-v4", family: "deepseek", tier: "cheap" },
  { id: "x-ai/grok-5", family: "xai", tier: "paid" },
  { id: "meta-llama/llama-5-70b", family: "meta", tier: "free" },
];

describe("REVIEW_LENSES", () => {
  it("defines the seven lenses with unique ids and non-trivial focus text", () => {
    const ids = REVIEW_LENSES.map((l) => l.id).sort();
    expect(ids).toEqual([
      "correctness-and-logic",
      "data-and-migrations",
      "operations-and-rollout",
      "performance-and-scale",
      "product-and-user",
      "security",
      "testing-and-verification",
    ]);
    for (const lens of REVIEW_LENSES) {
      expect(lens.focus.length).toBeGreaterThan(200);
      expect(lens.categories.length).toBeGreaterThan(0);
    }
  });
});

describe("assignLenses", () => {
  it("is deterministic regardless of input order", () => {
    const a = assignLenses(COUNCIL);
    const b = assignLenses([...COUNCIL].reverse());
    const c = assignLenses([...COUNCIL].sort(() => 0.5));
    for (const [id, lens] of a) {
      expect(b.get(id)?.id).toBe(lens.id);
      expect(c.get(id)?.id).toBe(lens.id);
    }
    expect(a.size).toBe(COUNCIL.length);
  });

  it("never gives two models of the same family the same lens when avoidable", () => {
    const assignments = assignLenses(COUNCIL);
    const byFamily = new Map<string, string[]>();
    for (const model of COUNCIL) {
      const lensId = assignments.get(model.id)!.id;
      byFamily.set(model.family, [...(byFamily.get(model.family) ?? []), lensId]);
    }
    for (const lensIds of byFamily.values()) {
      expect(new Set(lensIds).size).toBe(lensIds.length);
    }
  });

  it("separates families even when one family would wrap around the lens list", () => {
    // Eight anthropic models: seven must be distinct, the eighth is an
    // unavoidable repeat; the single openai model must not collide with it.
    const models: LensModel[] = [
      ...Array.from({ length: 8 }, (_, i) => ({ id: `anthropic/m${i}`, family: "anthropic" })),
      { id: "openai/only", family: "openai" },
    ];
    const assignments = assignLenses(models);
    const anthropic = models.slice(0, 8).map((m) => assignments.get(m.id)!.id);
    expect(new Set(anthropic).size).toBe(REVIEW_LENSES.length);
    // Nine models over seven lenses: every lens used, none used more than twice.
    const coverage = lensCoverage(assignments);
    expect(Object.keys(coverage)).toHaveLength(REVIEW_LENSES.length);
    expect(Math.max(...Object.values(coverage))).toBe(2);
    expect(Object.values(coverage).reduce((a, b) => a + b, 0)).toBe(models.length);
  });

  it("uses every lens at least once when there are at least as many models as lenses", () => {
    const coverage = lensCoverage(assignLenses(COUNCIL));
    expect(Object.keys(coverage).sort()).toEqual(REVIEW_LENSES.map((l) => l.id).sort());
    expect(Object.values(coverage).reduce((a, b) => a + b, 0)).toBe(COUNCIL.length);
  });

  it("uses the highest-priority lenses first when there are fewer models than lenses", () => {
    const three = COUNCIL.slice(0, 3);
    const coverage = lensCoverage(assignLenses(three));
    expect(Object.keys(coverage).sort()).toEqual(REVIEW_LENSES.slice(0, 3).map((l) => l.id).sort());
  });

  it("accepts a custom lens list and handles empty input", () => {
    const custom = REVIEW_LENSES.slice(0, 2);
    const assignments = assignLenses(COUNCIL, custom);
    for (const lens of assignments.values()) expect(custom).toContain(lens);
    expect(assignLenses([]).size).toBe(0);
    expect(assignLenses(COUNCIL, []).size).toBe(0);
  });
});

describe("lensPrompt", () => {
  it("keeps the base prompt intact and appends a delimited lens section", () => {
    const base = "You are a reviewer.\nUntrusted data follows.\n";
    const lens = REVIEW_LENSES.find((l) => l.id === "data-and-migrations")!;
    const prompt = lensPrompt(base, lens);
    expect(prompt.startsWith(base.trimEnd())).toBe(true);
    expect(prompt).toContain("YOUR LENS: Data & Migrations (data-and-migrations)");
    expect(prompt).toContain(lens.focus);
    expect(prompt).toContain('"data"');
    expect(prompt).toContain("critical");
    expect(prompt).toContain("==== END LENS ====");
  });
});

describe("lensCoverage", () => {
  it("counts models per lens id", () => {
    const [first, second] = REVIEW_LENSES;
    const assignments = new Map([
      ["a", first],
      ["b", first],
      ["c", second],
    ]);
    expect(lensCoverage(assignments)).toEqual({ [first.id]: 2, [second.id]: 1 });
    expect(lensCoverage(new Map())).toEqual({});
  });
});
