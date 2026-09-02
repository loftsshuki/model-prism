import { describe, it, expect } from "bun:test";
import { tfidfVectors, cosine, pairwiseSimilarity, redundantPairs, summarizeSimilarity, aggregateRedundancy } from "./similarity";

const REVIEW_A = `The migration in src/lib/db.ts drops the legacy_users table without taking a backup first.
The API route in src/app/api/review/route.ts does not validate the body with zod before reading fields.
Streaming responses are never cancelled when the client disconnects, so paid tokens keep flowing.`;

// Same three points, lightly reworded: what a second model in the same family tends to produce.
const REVIEW_B = `The migration in src/lib/db.ts drops the legacy_users table and never takes a backup.
The API route src/app/api/review/route.ts reads fields without validating the body with zod.
Streaming responses are not cancelled when the client disconnects, so paid tokens keep flowing.`;

const REVIEW_C = `Rate limiting is absent on the public endpoint, allowing unbounded spend by anonymous callers.
The roster price table is stale for two models and the cost estimate under-reports by roughly 30 percent.`;

describe("tfidfVectors / cosine", () => {
  it("identical documents score 1.0", () => {
    const [a, b] = tfidfVectors([REVIEW_A, REVIEW_A]);
    expect(cosine(a, b)).toBeCloseTo(1, 6);
  });

  it("documents with disjoint vocabularies score ~0", () => {
    const [a, b] = tfidfVectors(["apples bananas cherries dates", "quantum kernel scheduler latency"]);
    expect(cosine(a, b)).toBeLessThan(0.05);
  });

  it("vectors are L2-normalized and stopwords/short words are dropped", () => {
    const [v] = tfidfVectors(["the a an of to in is are migration migration"]);
    let sum = 0;
    for (const x of v.values()) sum += x * x;
    expect(sum).toBeCloseTo(1, 6);
    expect(v.has("the")).toBe(false);
    expect(v.has("migration")).toBe(true);
  });

  it("empty input does not throw", () => {
    expect(tfidfVectors([])).toEqual([]);
    expect(cosine(new Map(), new Map())).toBe(0);
    expect(cosine(new Map([["x", 1]]), new Map())).toBe(0);
  });
});

describe("pairwiseSimilarity / redundantPairs", () => {
  const responses = [
    { model: "a/one", text: REVIEW_A },
    { model: "b/two", text: REVIEW_B },
    { model: "c/three", text: REVIEW_C },
  ];

  it("returns every unordered pair sorted by score desc", () => {
    const pairs = pairwiseSimilarity(responses);
    expect(pairs).toHaveLength(3);
    for (let i = 1; i < pairs.length; i++) expect(pairs[i - 1].score).toBeGreaterThanOrEqual(pairs[i].score);
    expect(pairs[0]).toMatchObject({ a: "a/one", b: "b/two" });
  });

  it("flags the reworded pair as redundant and not the distinct one", () => {
    const pairs = pairwiseSimilarity(responses);
    const redundant = redundantPairs(pairs, 0.7);
    expect(redundant.map((p) => `${p.a}|${p.b}`)).toEqual(["a/one|b/two"]);
    expect(pairs.find((p) => p.b === "c/three")!.score).toBeLessThan(0.3);
  });

  it("summarizeSimilarity picks the most distinct model", () => {
    const s = summarizeSimilarity(responses, 0.7);
    expect(s.mostDistinct).toBe("c/three");
    expect(s.redundant).toHaveLength(1);
    expect(s.meanSimilarity).toBeGreaterThan(0);
    expect(s.meanSimilarity).toBeLessThan(1);
  });

  it("empty and single-response inputs do not throw", () => {
    expect(summarizeSimilarity([])).toEqual({ pairs: [], meanSimilarity: 0, redundant: [], mostDistinct: null });
    expect(summarizeSimilarity([{ model: "a", text: REVIEW_A }])).toEqual({ pairs: [], meanSimilarity: 0, redundant: [], mostDistinct: null });
    expect(pairwiseSimilarity([{ model: "a", text: "" }, { model: "b", text: "" }])[0].score).toBe(0);
  });
});

describe("aggregateRedundancy", () => {
  it("keeps pairs that clear the threshold over enough runs, merging reversed order", () => {
    const runs = [
      { pairs: [{ a: "x", b: "y", score: 0.9 }, { a: "x", b: "z", score: 0.95 }] },
      { pairs: [{ a: "y", b: "x", score: 0.85 }, { a: "x", b: "z", score: 0.2 }] },
      { pairs: [{ a: "x", b: "y", score: 0.95 }, { a: "y", b: "z", score: 0.9 }] },
    ];
    const out = aggregateRedundancy(runs, 3, 0.8);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ a: "x", b: "y", runs: 3 });
    expect(out[0].meanScore).toBeCloseTo(0.9, 6);
  });

  it("drops pairs seen in fewer than minRuns runs even if their mean is high", () => {
    const runs = [{ pairs: [{ a: "x", b: "y", score: 0.99 }] }, { pairs: [{ a: "x", b: "y", score: 0.99 }] }];
    expect(aggregateRedundancy(runs, 3)).toEqual([]);
    expect(aggregateRedundancy(runs, 2)).toHaveLength(1);
  });

  it("handles no runs", () => {
    expect(aggregateRedundancy([])).toEqual([]);
  });
});
