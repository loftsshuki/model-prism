import type { DecisionMode } from "./decision-gate";

export const JEV_DECISION_SPEC_VERSION = "jev-decision-spec/v1" as const;
export type JevPrimitive =
  | "classify"
  | "verify"
  | "gate"
  | "dedupe"
  | "rank"
  | "shortlist"
  | "route";

export type DecisionAction =
  | "baseline"
  | "observed"
  | "expanded"
  | "promoted"
  | "enforced"
  | "preserved"
  | "suppressed"
  | "fallback";

export interface JevDecisionTelemetry<TAnswer = unknown, TDecision = unknown> {
  specVersion: typeof JEV_DECISION_SPEC_VERSION;
  primitive: JevPrimitive;
  key: string;
  mode: DecisionMode;
  answer?: TAnswer;
  confidence?: number;
  probabilities?: Record<string, number>;
  baselineDecision: TDecision;
  effectiveDecision: TDecision;
  action: DecisionAction;
  latencyMs?: number;
  costUsd?: number;
  generationId?: string;
  evaluatorVersion?: string;
  error?: string;
}

function threshold(value?: number) {
  return value ?? 0.8;
}

function isConfident(confidence: number | null | undefined, minimum: number) {
  return confidence !== null && confidence !== undefined && confidence >= minimum;
}

function indexOfOrThrow<T extends string>(order: readonly T[], value: T) {
  const index = order.indexOf(value);
  if (index < 0) throw new Error(`Decision value "${value}" is missing from the configured order`);
  return index;
}

function baseAction(mode: DecisionMode, confident: boolean): DecisionAction {
  if (mode === "off") return "baseline";
  if (mode === "shadow") return "observed";
  return confident ? "preserved" : "fallback";
}

/**
 * Classification itself is descriptive. Assist records the Jev label but leaves
 * the deterministic label authoritative; routing/gating may consume it to add scrutiny.
 * Enforce may make the Jev label authoritative when confidence clears threshold.
 */
export function resolveClassify<T extends string>(input: {
  mode: DecisionMode;
  baselineLabel: T;
  jevLabel: T | null;
  confidence: number | null;
  threshold?: number;
}) {
  const confident = isConfident(input.confidence, threshold(input.threshold));
  if (input.mode === "enforce" && input.jevLabel && confident) {
    return { label: input.jevLabel, action: "enforced" as const };
  }
  return {
    label: input.baselineLabel,
    action: baseAction(input.mode, confident),
  };
}

export type VerifyDecision = "pass" | "review" | "fail";
const VERIFY_ORDER: readonly VerifyDecision[] = ["pass", "review", "fail"];

/**
 * Verify/Gate semantics are asymmetric:
 * - Assist may only increase scrutiny.
 * - Enforce may use Jev when confident, but cannot go below hardFloor.
 */
export function resolveVerify(input: {
  mode: DecisionMode;
  baseline: VerifyDecision;
  jev: VerifyDecision | null;
  confidence: number | null;
  threshold?: number;
  hardFloor?: VerifyDecision;
}) {
  const confident = isConfident(input.confidence, threshold(input.threshold));
  if (!input.jev || !confident || input.mode === "off" || input.mode === "shadow") {
    return { decision: input.baseline, action: baseAction(input.mode, confident) };
  }

  const baselineIndex = indexOfOrThrow(VERIFY_ORDER, input.baseline);
  const jevIndex = indexOfOrThrow(VERIFY_ORDER, input.jev);
  const floorIndex = indexOfOrThrow(VERIFY_ORDER, input.hardFloor ?? "pass");

  if (input.mode === "assist") {
    const index = Math.max(baselineIndex, jevIndex, floorIndex);
    return {
      decision: VERIFY_ORDER[index],
      action: index > baselineIndex ? "expanded" as const : "preserved" as const,
    };
  }

  const index = Math.max(jevIndex, floorIndex);
  return {
    decision: VERIFY_ORDER[index],
    action: index === baselineIndex
      ? "preserved" as const
      : index > baselineIndex
        ? "expanded" as const
        : "suppressed" as const,
  };
}

export const resolveGate = resolveVerify;

/**
 * Dedupe labels are domain-defined. The caller supplies a conservative order,
 * e.g. new < adjacent < update_existing < near_duplicate < duplicate < contradiction.
 */
export function resolveDedupe<T extends string>(input: {
  mode: DecisionMode;
  baselineLabel: T;
  jevLabel: T | null;
  confidence: number | null;
  order: readonly T[];
  threshold?: number;
  hardFloor?: T;
}) {
  const confident = isConfident(input.confidence, threshold(input.threshold));
  if (!input.jevLabel || !confident || input.mode === "off" || input.mode === "shadow") {
    return { label: input.baselineLabel, action: baseAction(input.mode, confident) };
  }

  const baselineIndex = indexOfOrThrow(input.order, input.baselineLabel);
  const jevIndex = indexOfOrThrow(input.order, input.jevLabel);
  const floorIndex = input.hardFloor === undefined ? 0 : indexOfOrThrow(input.order, input.hardFloor);

  if (input.mode === "assist") {
    const index = Math.max(baselineIndex, jevIndex, floorIndex);
    return {
      label: input.order[index],
      action: index > baselineIndex ? "expanded" as const : "preserved" as const,
    };
  }

  const index = Math.max(jevIndex, floorIndex);
  return {
    label: input.order[index],
    action: index === baselineIndex
      ? "preserved" as const
      : index > baselineIndex
        ? "expanded" as const
        : "suppressed" as const,
  };
}

/**
 * Rank is intentionally one-way in Assist: Jev can promote but cannot demote.
 * Enforce can use Jev's score when confident.
 */
export function resolveRank(input: {
  mode: DecisionMode;
  baselineScore: number;
  jevScore: number | null;
  confidence: number | null;
  threshold?: number;
  min?: number;
  max?: number;
}) {
  const min = input.min ?? 0;
  const max = input.max ?? 100;
  const clamp = (value: number) => Math.max(min, Math.min(max, value));
  const baseline = clamp(input.baselineScore);
  const confident = isConfident(input.confidence, threshold(input.threshold));

  if (input.jevScore === null || !confident || input.mode === "off" || input.mode === "shadow") {
    return { score: baseline, action: baseAction(input.mode, confident) };
  }

  const jev = clamp(input.jevScore);
  if (input.mode === "assist") {
    const score = Math.max(baseline, jev);
    return { score, action: score > baseline ? "promoted" as const : "preserved" as const };
  }

  return {
    score: jev,
    action: jev === baseline
      ? "preserved" as const
      : jev > baseline
        ? "promoted" as const
        : "suppressed" as const,
  };
}

/**
 * Shortlist is also asymmetric in Assist: baseline-selected items cannot disappear.
 * Enforce may select/deselect when confident. hardSelected always wins.
 */
export function resolveShortlist(input: {
  mode: DecisionMode;
  baselineSelected: boolean;
  jevSelected: boolean | null;
  confidence: number | null;
  threshold?: number;
  hardSelected?: boolean;
}) {
  if (input.hardSelected) return { selected: true, action: "preserved" as const };
  const confident = isConfident(input.confidence, threshold(input.threshold));

  if (input.jevSelected === null || !confident || input.mode === "off" || input.mode === "shadow") {
    return { selected: input.baselineSelected, action: baseAction(input.mode, confident) };
  }

  if (input.mode === "assist") {
    const selected = input.baselineSelected || input.jevSelected;
    return {
      selected,
      action: selected && !input.baselineSelected ? "promoted" as const : "preserved" as const,
    };
  }

  return {
    selected: input.jevSelected,
    action: input.jevSelected === input.baselineSelected
      ? "preserved" as const
      : input.jevSelected
        ? "promoted" as const
        : "suppressed" as const,
  };
}

/**
 * Route uses an explicit least-to-most-expensive/scrutinized order.
 * Assist may only move upward. Enforce may move either direction but never below hardFloor.
 */
export function resolveRoute<T extends string>(input: {
  mode: DecisionMode;
  baselineRoute: T;
  jevRoute: T | null;
  confidence: number | null;
  order: readonly T[];
  threshold?: number;
  hardFloor?: T;
}) {
  const confident = isConfident(input.confidence, threshold(input.threshold));
  if (!input.jevRoute || !confident || input.mode === "off" || input.mode === "shadow") {
    return { route: input.baselineRoute, action: baseAction(input.mode, confident) };
  }

  const baselineIndex = indexOfOrThrow(input.order, input.baselineRoute);
  const jevIndex = indexOfOrThrow(input.order, input.jevRoute);
  const floorIndex = input.hardFloor === undefined ? 0 : indexOfOrThrow(input.order, input.hardFloor);

  if (input.mode === "assist") {
    const index = Math.max(baselineIndex, jevIndex, floorIndex);
    return {
      route: input.order[index],
      action: index > baselineIndex ? "expanded" as const : "preserved" as const,
    };
  }

  const index = Math.max(jevIndex, floorIndex);
  return {
    route: input.order[index],
    action: index === baselineIndex
      ? "preserved" as const
      : index > baselineIndex
        ? "expanded" as const
        : "suppressed" as const,
  };
}

export function decisionTelemetry<TAnswer, TDecision>(input: {
  primitive: JevPrimitive;
  key: string;
  mode: DecisionMode;
  baselineDecision: TDecision;
  effectiveDecision: TDecision;
  action: DecisionAction;
  answer?: TAnswer;
  confidence?: number | null;
  probabilities?: Record<string, number>;
  latencyMs?: number;
  costUsd?: number;
  generationId?: string;
  evaluatorVersion?: string;
  error?: string;
}): JevDecisionTelemetry<TAnswer, TDecision> {
  return {
    specVersion: JEV_DECISION_SPEC_VERSION,
    primitive: input.primitive,
    key: input.key,
    mode: input.mode,
    baselineDecision: input.baselineDecision,
    effectiveDecision: input.effectiveDecision,
    action: input.action,
    ...(input.answer === undefined ? {} : { answer: input.answer }),
    ...(input.confidence === null || input.confidence === undefined ? {} : { confidence: input.confidence }),
    ...(input.probabilities ? { probabilities: input.probabilities } : {}),
    ...(input.latencyMs === undefined ? {} : { latencyMs: input.latencyMs }),
    ...(input.costUsd === undefined ? {} : { costUsd: input.costUsd }),
    ...(input.generationId ? { generationId: input.generationId } : {}),
    ...(input.evaluatorVersion ? { evaluatorVersion: input.evaluatorVersion } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
}
