export const DECISION_MODES = ["off", "shadow", "assist", "enforce"] as const;
export type DecisionMode = (typeof DECISION_MODES)[number];

export interface DecisionModes {
  preReview: DecisionMode;
  escalation: DecisionMode;
}

export const DEFAULT_DECISION_MODES: DecisionModes = {
  preReview: "assist",
  escalation: "assist",
};

export type DecisionGateKey = "pre-review-depth" | "post-synthesis-escalation";
export type ReviewDepthChoice = "minimal" | "standard" | "full" | "uncertain";

export interface DecisionGateRecord {
  key: DecisionGateKey;
  mode: DecisionMode;
  phase: string;
  execution: number;
  evaluatedAt: string;
  answer?: Record<string, unknown>;
  selectedProbability?: number;
  deterministicDecision: string;
  effectiveDecision: string;
  action: string;
  latencyMs?: number;
  costUsd?: number;
  generationId?: string;
  error?: string;
}

export function resolveReviewDepth(input: {
  mode: DecisionMode;
  choice: ReviewDepthChoice | null;
  selectedProbability: number | null;
  threshold?: number;
  deterministicCount: number;
  totalCount: number;
  adaptive: boolean;
  explicitHighRisk: boolean;
}) {
  const threshold = input.threshold ?? 0.8;
  const deterministicCount = Math.max(2, Math.min(input.totalCount, input.deterministicCount));

  if (input.explicitHighRisk || !input.adaptive || input.mode === "off" || input.mode === "shadow") {
    return { count: input.explicitHighRisk ? input.totalCount : deterministicCount, action: "preserved" as const };
  }
  if (!input.choice || input.choice === "uncertain" || input.selectedProbability === null || input.selectedProbability < threshold) {
    return { count: deterministicCount, action: "preserved" as const };
  }

  if (input.mode === "assist") {
    return input.choice === "full"
      ? { count: input.totalCount, action: input.totalCount > deterministicCount ? "expanded" as const : "preserved" as const }
      : { count: deterministicCount, action: "preserved" as const };
  }

  if (input.choice === "full") {
    return { count: input.totalCount, action: input.totalCount > deterministicCount ? "expanded" as const : "preserved" as const };
  }
  if (input.choice === "minimal") {
    const count = Math.min(input.totalCount, 2);
    return { count, action: count < deterministicCount ? "reduced" as const : "preserved" as const };
  }

  const count = Math.min(input.totalCount, 3);
  return {
    count,
    action: count < deterministicCount ? "reduced" as const : count > deterministicCount ? "expanded" as const : "preserved" as const,
  };
}

export function resolveEscalation(input: {
  mode: DecisionMode;
  probabilityTrue: number | null;
  threshold?: number;
  deterministic: boolean;
  hardDeterministic: boolean;
}) {
  const threshold = input.threshold ?? 0.8;

  if (input.mode === "off" || input.mode === "shadow" || input.probabilityTrue === null) {
    return { escalate: input.deterministic, action: "preserved" as const };
  }

  if (input.mode === "assist") {
    if (input.probabilityTrue >= threshold && !input.deterministic) return { escalate: true, action: "expanded" as const };
    return { escalate: input.deterministic, action: "preserved" as const };
  }

  if (input.hardDeterministic) return { escalate: true, action: "preserved" as const };
  if (input.probabilityTrue >= threshold) return { escalate: true, action: input.deterministic ? "preserved" as const : "expanded" as const };
  if (input.probabilityTrue <= 1 - threshold) return { escalate: false, action: input.deterministic ? "suppressed" as const : "preserved" as const };
  return { escalate: input.deterministic, action: "preserved" as const };
}

export function clipDecisionText(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  const head = Math.max(1, Math.floor(maxChars * 0.7));
  const tail = Math.max(1, maxChars - head - 32);
  return `${value.slice(0, head)}\n...[decision-state clipped]...\n${value.slice(-tail)}`;
}
