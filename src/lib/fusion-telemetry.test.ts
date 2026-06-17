import { describe, it, expect } from "bun:test";
import { buildFusionTelemetry, aggregateFusionGates, type FusionRunTelemetry } from "./fusion-telemetry";
import type { PhaseUsage } from "./fusion";

const judgePhase: PhaseUsage = { phase: "judge", model: "m", inputTokens: 1000, outputTokens: 500, cost: 0.01, attempts: 2 };
const synthPhase: PhaseUsage = { phase: "synth", model: "m", inputTokens: 800, outputTokens: 1200, cost: 0.02, attempts: 1 };

describe("buildFusionTelemetry", () => {
  it("sums tokens/cost across phases and records judge attempts", () => {
    const r = buildFusionTelemetry({
      ts: "t", plan: "p.md", contextRepo: "repo", roster: "default", fellBackToLegacy: false,
      phases: [judgePhase, synthPhase],
      evidenceKept: 3, evidenceDropped: 1, citationsDropped: 2,
      lockedDecisions: ["a", "b"],
      strategicBlindSpots: [{ category: "i18n" }, { category: "i18n" }, { category: "accessibility" }],
    });
    expect(r.totalInputTokens).toBe(1800);
    expect(r.totalOutputTokens).toBe(1700);
    expect(r.totalCost).toBeCloseTo(0.03, 5);
    expect(r.judgeAttempts).toBe(2);
    expect(r.lockedDecisionCount).toBe(2);
    expect(r.strategicBlindSpotCount).toBe(3);
    expect(r.strategicByCategory).toEqual({ i18n: 2, accessibility: 1 });
  });

  it("leaves totalCost null when no phase reported a cost (not silently $0)", () => {
    const r = buildFusionTelemetry({
      ts: "t", plan: "p.md", contextRepo: "repo", roster: "cheap", fellBackToLegacy: true,
      phases: [{ ...judgePhase, cost: null }],
      evidenceKept: 0, evidenceDropped: 0, citationsDropped: 0,
      lockedDecisions: [], strategicBlindSpots: [],
    });
    expect(r.totalCost).toBeNull();
    expect(r.fellBackToLegacy).toBe(true);
  });
});

describe("aggregateFusionGates (Phase-5 gate query)", () => {
  it("computes fallback-rate and per-roster average cost", () => {
    const runs: FusionRunTelemetry[] = [
      buildFusionTelemetry({ ts: "t", plan: "a", contextRepo: "r", roster: "default", fellBackToLegacy: false, phases: [judgePhase, synthPhase], evidenceKept: 0, evidenceDropped: 0, citationsDropped: 0, lockedDecisions: [], strategicBlindSpots: [{ category: "i18n" }] }),
      buildFusionTelemetry({ ts: "t", plan: "b", contextRepo: "r", roster: "default", fellBackToLegacy: true, phases: [judgePhase], evidenceKept: 0, evidenceDropped: 0, citationsDropped: 0, lockedDecisions: [], strategicBlindSpots: [] }),
    ];
    const stats = aggregateFusionGates(runs);
    expect(stats.runs).toBe(2);
    expect(stats.fallbackRate).toBe(0.5);
    expect(stats.avgStrategicCount).toBe(0.5);
    expect(stats.avgCostByRoster.default).toBeCloseTo((0.03 + 0.01) / 2, 5);
  });

  it("handles an empty ledger without dividing by zero", () => {
    const stats = aggregateFusionGates([]);
    expect(stats.runs).toBe(0);
    expect(stats.fallbackRate).toBe(0);
  });
});
