import { describe, expect, test } from "bun:test";
import { compareSyntheses } from "./synthesis-compare";
import { SynthesisResult } from "./types";

function synth(masterDocument: string, blindSpots: string[] = []): SynthesisResult {
  return { masterDocument, consensus: [], uniqueInsights: [], disagreements: [], blindSpots };
}

describe("compareSyntheses", () => {
  test("detects added and removed risks between synthesis versions", () => {
    const previous = synth("- Risk: missing auth checks in admin route\n- Fix tests before shipping", ["No telemetry details"]);
    const next = synth("- Critical security risk: exposed token in API route\n- Add rollback validation before shipping");

    const comparison = compareSyntheses(previous, next);

    expect(comparison.addedRisks.some((line) => line.toLowerCase().includes("exposed token"))).toBe(true);
    expect(comparison.removedRisks.some((line) => line.toLowerCase().includes("telemetry"))).toBe(true);
    expect(comparison.changedRecommendations.some((line) => line.toLowerCase().includes("rollback"))).toBe(true);
  });
});
