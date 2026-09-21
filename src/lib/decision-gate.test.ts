import { describe, expect, test } from "bun:test";
import { resolveEscalation, resolveReviewDepth } from "./decision-gate";

describe("decision gate modes", () => {
  test("shadow observes without changing review depth", () => {
    expect(resolveReviewDepth({
      mode: "shadow", choice: "full", selectedProbability: 0.99,
      deterministicCount: 3, totalCount: 5, adaptive: true, explicitHighRisk: false,
    })).toEqual({ count: 3, action: "preserved" });
  });

  test("assist can add scrutiny but cannot reduce it", () => {
    expect(resolveReviewDepth({
      mode: "assist", choice: "full", selectedProbability: 0.95,
      deterministicCount: 3, totalCount: 5, adaptive: true, explicitHighRisk: false,
    })).toEqual({ count: 5, action: "expanded" });
    expect(resolveReviewDepth({
      mode: "assist", choice: "minimal", selectedProbability: 0.99,
      deterministicCount: 3, totalCount: 5, adaptive: true, explicitHighRisk: false,
    })).toEqual({ count: 3, action: "preserved" });
  });

  test("enforce can reduce an adaptive standard-risk council, but never an explicit high-risk review", () => {
    expect(resolveReviewDepth({
      mode: "enforce", choice: "minimal", selectedProbability: 0.99,
      deterministicCount: 3, totalCount: 5, adaptive: true, explicitHighRisk: false,
    })).toEqual({ count: 2, action: "reduced" });
    expect(resolveReviewDepth({
      mode: "enforce", choice: "minimal", selectedProbability: 0.99,
      deterministicCount: 5, totalCount: 5, adaptive: true, explicitHighRisk: true,
    })).toEqual({ count: 5, action: "preserved" });
  });

  test("assist escalation is one-way and enforce preserves hard safeguards", () => {
    expect(resolveEscalation({
      mode: "assist", probabilityTrue: 0.95, deterministic: false, hardDeterministic: false,
    })).toEqual({ escalate: true, action: "expanded" });
    expect(resolveEscalation({
      mode: "assist", probabilityTrue: 0.01, deterministic: true, hardDeterministic: false,
    })).toEqual({ escalate: true, action: "preserved" });
    expect(resolveEscalation({
      mode: "enforce", probabilityTrue: 0.01, deterministic: true, hardDeterministic: false,
    })).toEqual({ escalate: false, action: "suppressed" });
    expect(resolveEscalation({
      mode: "enforce", probabilityTrue: 0.01, deterministic: true, hardDeterministic: true,
    })).toEqual({ escalate: true, action: "preserved" });
  });

  test("uncertain probabilities fall back to the deterministic decision", () => {
    expect(resolveEscalation({
      mode: "enforce", probabilityTrue: 0.51, deterministic: true, hardDeterministic: false,
    })).toEqual({ escalate: true, action: "preserved" });
  });
});
