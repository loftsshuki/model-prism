import { describe, expect, test } from "bun:test";
import dataset from "../../evals/repository-regressions.json";
import { parseEvaluationAnswer, scoreEvaluation, summarizeEvaluations, type EvaluationFixture } from "./evaluation";

const fixtures = dataset.fixtures as EvaluationFixture[];
describe("repository evaluation scoring", () => {
  test("the suite contains paired real regressions and safe controls with pinned provenance", () => {
    expect(fixtures).toHaveLength(20);
    expect(fixtures.filter(f => f.provenance.kind === "repository")).toHaveLength(16);
    expect(fixtures.filter(f => !f.expected.length)).toHaveLength(10);
    for (const fixture of fixtures) {
      for (const expected of fixture.expected) {
        const file = fixture.files.find(file => file.path === expected.path)!;
        expect(expected.startLine).toBeGreaterThanOrEqual(file.startLine);
        expect(expected.endLine).toBeLessThan(file.startLine + file.text.split("\n").length);
      }
      if (fixture.provenance.kind === "repository") expect(fixture.provenance.commit).toMatch(/^[a-f0-9]{40}$/);
    }
  });
  test("unknown claims, fake quotes, wrong locations and duplicate findings count as false positives", () => {
    const fixture = fixtures[0], expected = fixture.expected[0], file = fixture.files[0];
    const finding = { rule: expected.rule, path: expected.path, line: expected.startLine, quote: file.text.split("\n")[expected.startLine - file.startLine], explanation: "overwrites total" };
    expect(scoreEvaluation(fixture, [finding])).toMatchObject({ truePositives: 1, pass: true });
    expect(scoreEvaluation(fixture, [finding, finding])).toMatchObject({ truePositives: 1, falsePositives: 1, pass: false });
    for (const change of [{ quote: "this quote is entirely invented" }, { line: 99999 }, { rule: "made-up" }]) expect(scoreEvaluation(fixture, [{ ...finding, ...change }])).toMatchObject({ falsePositives: 1, falseNegatives: 1, pass: false });
  });
  test("safe fixtures still fail malformed or unsupported outputs", () => {
    const safe = fixtures[1];
    expect(scoreEvaluation(safe, []).pass).toBe(true);
    expect(scoreEvaluation(safe, [], false).pass).toBe(false);
    expect(() => parseEvaluationAnswer("Everything looks fine")).toThrow();
    expect(() => parseEvaluationAnswer('{"findings":[{"rule":"guess"}]}')).toThrow();
  });
  test("metrics retain failed cases and all spending", () => {
    const a = scoreEvaluation(fixtures[0], [], false), b = scoreEvaluation(fixtures[1], []);
    expect(summarizeEvaluations([{ ...a, cost: .05, timeMs: 20 }, { ...b, cost: .03, timeMs: 10 }])).toMatchObject({ cases: 2, invalid: 1, passed: 1, recall: 0, precision: null, cost: .08, costPerUsefulFinding: null });
  });
});
