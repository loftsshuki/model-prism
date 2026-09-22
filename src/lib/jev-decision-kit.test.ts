import { describe, expect, test } from "bun:test";
import {
  decisionTelemetry,
  resolveClassify,
  resolveDedupe,
  resolveRank,
  resolveRoute,
  resolveShortlist,
  resolveVerify,
} from "./jev-decision-kit";

describe("shared Jev decision primitives", () => {
  test("classify is observational in assist and authoritative only in confident enforce", () => {
    expect(resolveClassify({
      mode: "assist", baselineLabel: "unknown", jevLabel: "sales", confidence: 0.99,
    })).toEqual({ label: "unknown", action: "preserved" });

    expect(resolveClassify({
      mode: "enforce", baselineLabel: "unknown", jevLabel: "sales", confidence: 0.99,
    })).toEqual({ label: "sales", action: "enforced" });

    expect(resolveClassify({
      mode: "enforce", baselineLabel: "unknown", jevLabel: "sales", confidence: 0.55,
    })).toEqual({ label: "unknown", action: "fallback" });
  });

  test("verify assist can add scrutiny but never remove it", () => {
    expect(resolveVerify({
      mode: "assist", baseline: "pass", jev: "review", confidence: 0.95,
    })).toEqual({ decision: "review", action: "expanded" });

    expect(resolveVerify({
      mode: "assist", baseline: "fail", jev: "pass", confidence: 0.99,
    })).toEqual({ decision: "fail", action: "preserved" });
  });

  test("verify enforce may reduce only to the configured hard floor", () => {
    expect(resolveVerify({
      mode: "enforce", baseline: "fail", jev: "pass", confidence: 0.99,
      hardFloor: "review",
    })).toEqual({ decision: "review", action: "suppressed" });

    expect(resolveVerify({
      mode: "enforce", baseline: "review", jev: "pass", confidence: 0.99,
      hardFloor: "review",
    })).toEqual({ decision: "review", action: "preserved" });
  });

  test("dedupe assist uses the more conservative novelty label", () => {
    const order = [
      "new", "adjacent", "update_existing", "near_duplicate", "duplicate", "contradiction",
    ] as const;

    expect(resolveDedupe({
      mode: "assist", baselineLabel: "new", jevLabel: "near_duplicate",
      confidence: 0.95, order,
    })).toEqual({ label: "near_duplicate", action: "expanded" });

    expect(resolveDedupe({
      mode: "assist", baselineLabel: "duplicate", jevLabel: "new",
      confidence: 0.99, order,
    })).toEqual({ label: "duplicate", action: "preserved" });
  });

  test("rank assist promotes only while enforce may reorder either way", () => {
    expect(resolveRank({
      mode: "assist", baselineScore: 70, jevScore: 91, confidence: 0.95,
    })).toEqual({ score: 91, action: "promoted" });
    expect(resolveRank({
      mode: "assist", baselineScore: 70, jevScore: 30, confidence: 0.95,
    })).toEqual({ score: 70, action: "preserved" });
    expect(resolveRank({
      mode: "enforce", baselineScore: 70, jevScore: 30, confidence: 0.95,
    })).toEqual({ score: 30, action: "suppressed" });
  });

  test("shortlist assist is a union and enforce may deselect", () => {
    expect(resolveShortlist({
      mode: "assist", baselineSelected: false, jevSelected: true, confidence: 0.96,
    })).toEqual({ selected: true, action: "promoted" });
    expect(resolveShortlist({
      mode: "assist", baselineSelected: true, jevSelected: false, confidence: 0.96,
    })).toEqual({ selected: true, action: "preserved" });
    expect(resolveShortlist({
      mode: "enforce", baselineSelected: true, jevSelected: false, confidence: 0.96,
    })).toEqual({ selected: false, action: "suppressed" });
    expect(resolveShortlist({
      mode: "enforce", baselineSelected: false, jevSelected: false, confidence: 0.96,
      hardSelected: true,
    })).toEqual({ selected: true, action: "preserved" });
  });

  test("route assist moves only toward more expensive scrutiny", () => {
    const order = ["deterministic", "cheap-model", "strong-model", "human"] as const;

    expect(resolveRoute({
      mode: "assist", baselineRoute: "cheap-model", jevRoute: "human",
      confidence: 0.93, order,
    })).toEqual({ route: "human", action: "expanded" });

    expect(resolveRoute({
      mode: "assist", baselineRoute: "strong-model", jevRoute: "deterministic",
      confidence: 0.99, order,
    })).toEqual({ route: "strong-model", action: "preserved" });
  });

  test("route enforce may save cost but respects the hard floor", () => {
    const order = ["deterministic", "cheap-model", "strong-model", "human"] as const;

    expect(resolveRoute({
      mode: "enforce", baselineRoute: "strong-model", jevRoute: "cheap-model",
      confidence: 0.95, order,
    })).toEqual({ route: "cheap-model", action: "suppressed" });

    expect(resolveRoute({
      mode: "enforce", baselineRoute: "strong-model", jevRoute: "deterministic",
      confidence: 0.95, order, hardFloor: "cheap-model",
    })).toEqual({ route: "cheap-model", action: "suppressed" });
  });

  test("decision telemetry uses one versioned fleet-wide shape", () => {
    expect(decisionTelemetry({
      primitive: "shortlist",
      key: "content-opportunities",
      mode: "assist",
      baselineDecision: false,
      effectiveDecision: true,
      action: "promoted",
      answer: { selected: true, priority: 93 },
      confidence: 0.94,
      probabilities: { selected: 0.94 },
      latencyMs: 211,
      costUsd: 0.000004,
      generationId: "gen_test",
      evaluatorVersion: "content-opportunity-v1",
    })).toEqual({
      specVersion: "jev-decision-spec/v1",
      primitive: "shortlist",
      key: "content-opportunities",
      mode: "assist",
      baselineDecision: false,
      effectiveDecision: true,
      action: "promoted",
      answer: { selected: true, priority: 93 },
      confidence: 0.94,
      probabilities: { selected: 0.94 },
      latencyMs: 211,
      costUsd: 0.000004,
      generationId: "gen_test",
      evaluatorVersion: "content-opportunity-v1",
    });
  });
});
