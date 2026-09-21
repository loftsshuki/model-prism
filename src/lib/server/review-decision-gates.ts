import {
  clipDecisionText,
  resolveEscalation,
  resolveReviewDepth,
  type DecisionGateRecord,
  type ReviewDepthChoice,
} from "../decision-gate";
import type { RunCheckpoint } from "../run-checkpoint";
import type { BackgroundReviewInput } from "../review-policy";
import { evaluateWithJev, jevEnabled } from "./jev-evaluator";

type GateInput = {
  snapshot: RunCheckpoint;
  config: BackgroundReviewInput;
  execution: number;
};

function existingGate(snapshot: RunCheckpoint, key: DecisionGateRecord["key"], execution: number) {
  return snapshot.decisionGates?.find(record => record.key === key && record.execution === execution);
}

function choiceAnswer(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const answer = value as Record<string, unknown>;
  if (answer.type !== "choice" || typeof answer.choice !== "string") return null;
  const probabilities = answer.probabilities && typeof answer.probabilities === "object" && !Array.isArray(answer.probabilities)
    ? answer.probabilities as Record<string, unknown>
    : {};
  const probability = Number(probabilities[answer.choice]);
  return {
    choice: answer.choice,
    probability: Number.isFinite(probability) ? Math.max(0, Math.min(1, probability)) : null,
  };
}

function booleanProbability(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const answer = value as Record<string, unknown>;
  const probability = Number(answer.probability);
  return answer.type === "boolean" && Number.isFinite(probability) ? Math.max(0, Math.min(1, probability)) : null;
}

function baseRecord(input: GateInput, key: DecisionGateRecord["key"], mode: DecisionGateRecord["mode"], phase: string) {
  return {
    key,
    mode,
    phase,
    execution: input.execution,
    evaluatedAt: new Date().toISOString(),
  };
}

export async function evaluatePreReviewDepth(input: GateInput): Promise<{
  initialIds: string[];
  record?: DecisionGateRecord;
}> {
  const currentIds = input.snapshot.adaptive?.initialIds ?? input.snapshot.models.map(model => model.id);
  const prior = existingGate(input.snapshot, "pre-review-depth", input.execution);
  if (prior) return { initialIds: currentIds };

  const mode = input.config.decisionModes?.preReview ?? "assist";
  if (mode === "off") return { initialIds: currentIds };

  const deterministicDecision = `${currentIds.length}-reviewers`;
  const fallback = (error: unknown): { initialIds: string[]; record: DecisionGateRecord } => ({
    initialIds: currentIds,
    record: {
      ...baseRecord(input, "pre-review-depth", mode, "before-review"),
      deterministicDecision,
      effectiveDecision: deterministicDecision,
      action: "fallback",
      error: (error instanceof Error ? error.message : "Jev evaluation unavailable").slice(0, 1000),
    },
  });

  if (!jevEnabled()) return fallback(new Error("Jev disabled by MODEL_PRISM_JEV_ENABLED"));

  try {
    const result = await evaluateWithJev({
      state: {
        content: clipDecisionText(input.snapshot.content, 18_000),
        instructions: clipDecisionText(input.snapshot.prompt, 4_000),
        contextMetadata: clipDecisionText(input.snapshot.contextMetadata ?? "", 2_000),
        suppliedFiles: (input.snapshot.sources ?? []).slice(0, 40).map(source => source.path),
        configuredRisk: input.config.risk,
        adaptiveCouncil: input.config.adaptive,
        selectedReviewerCount: input.snapshot.models.length,
      },
      questions: {
        depth: {
          type: "choice",
          instructions: "Choose the minimum independent review depth that preserves reliability for this review. Prefer the smallest adequate level, but do not understate security, data-loss, auth, payment, migration, infrastructure, or irreversible risk.",
          criteria: {
            minimal: "Routine, narrow, reversible work with little blast radius and no meaningful security, auth, payments, data, migration, deployment, or architecture risk.",
            standard: "Non-trivial work that benefits from multiple independent reviewers but is still reasonably bounded and reversible.",
            full: "High-impact, cross-cutting, security-sensitive, auth/payment/data/migration/build/infrastructure work, irreversible changes, or ambiguity where missing a flaw would be costly.",
            uncertain: "The supplied state is insufficient or conflicting, so reducing review depth would be unsafe.",
          },
        },
      },
    });

    const depth = choiceAnswer(result.answers.depth);
    const validChoice = depth && ["minimal", "standard", "full", "uncertain"].includes(depth.choice)
      ? depth.choice as ReviewDepthChoice
      : null;
    const resolved = resolveReviewDepth({
      mode,
      choice: validChoice,
      selectedProbability: depth?.probability ?? null,
      deterministicCount: currentIds.length,
      totalCount: input.snapshot.models.length,
      adaptive: input.config.adaptive,
      explicitHighRisk: input.config.risk === "high",
    });

    const completed = new Set(input.snapshot.responses.filter(response => response.status === "complete").map(response => response.requestedModel ?? response.model));
    const target = resolved.count >= input.snapshot.models.length
      ? input.snapshot.models.map(model => model.id)
      : currentIds.slice(0, resolved.count);
    const initialIds = input.snapshot.models.map(model => model.id).filter(id => target.includes(id) || completed.has(id));

    return {
      initialIds,
      record: {
        ...baseRecord(input, "pre-review-depth", mode, "before-review"),
        answer: result.answers,
        selectedProbability: depth?.probability ?? undefined,
        deterministicDecision,
        effectiveDecision: `${initialIds.length}-reviewers`,
        action: resolved.action,
        latencyMs: result.latencyMs,
        costUsd: result.costUsd,
        generationId: result.generationId,
      },
    };
  } catch (error) {
    return fallback(error);
  }
}

const HARD_ESCALATION_REASONS = new Set([
  "High-risk review requested",
  "Fewer than three reviewers completed",
  "A reviewer raised a high-impact finding",
  "Some findings lack verified quotations",
]);

export async function evaluatePostSynthesisEscalation(input: GateInput, deterministicReasons: string[]): Promise<{
  escalate: boolean;
  record?: DecisionGateRecord;
}> {
  const deterministic = deterministicReasons.length > 0;
  const prior = existingGate(input.snapshot, "post-synthesis-escalation", input.execution);
  if (prior) return { escalate: prior.effectiveDecision === "escalate" };

  const mode = input.config.decisionModes?.escalation ?? "assist";
  if (mode === "off" || !input.snapshot.synthesis) return { escalate: deterministic };

  const deterministicDecision = deterministic ? "escalate" : "stop";
  const fallback = (error: unknown): { escalate: boolean; record: DecisionGateRecord } => ({
    escalate: deterministic,
    record: {
      ...baseRecord(input, "post-synthesis-escalation", mode, "after-draft-synthesis"),
      deterministicDecision,
      effectiveDecision: deterministicDecision,
      action: "fallback",
      error: (error instanceof Error ? error.message : "Jev evaluation unavailable").slice(0, 1000),
    },
  });

  if (!jevEnabled()) return fallback(new Error("Jev disabled by MODEL_PRISM_JEV_ENABLED"));

  try {
    const synthesis = input.snapshot.synthesis;
    const result = await evaluateWithJev({
      state: {
        configuredRisk: input.config.risk,
        completedReviewers: input.snapshot.responses.filter(response => response.status === "complete").length,
        totalSelectedReviewers: input.snapshot.models.length,
        deterministicReasons,
        disagreements: synthesis.disagreements.slice(0, 20).map(item => item.topic),
        blindSpots: synthesis.blindSpots.slice(0, 20),
        findings: (synthesis.findings ?? []).slice(0, 30).map(finding => ({
          title: clipDecisionText(finding.title, 180),
          severity: finding.severity,
          evidenceVerified: finding.evidenceVerified ?? false,
          supportingModels: finding.supportingModels.length,
        })),
        consensus: synthesis.consensus.slice(0, 20).map(item => ({ point: clipDecisionText(item.point, 240), strength: item.strength })),
      },
      questions: {
        escalate: {
          type: "boolean",
          instructions: "Would adding the remaining independent reviewers materially improve reliability before this review is finalized?",
          criteria: {
            true: "There are unresolved contradictions, consequential uncertainty, weak or missing evidence, high-impact findings, material blind spots, or too little independent coverage.",
            false: "Evidence is sufficiently verified, the important conclusions are stable, and additional reviewers are unlikely to change a material action or finding.",
          },
        },
      },
    });

    const probabilityTrue = booleanProbability(result.answers.escalate);
    const hardDeterministic = deterministicReasons.some(reason => HARD_ESCALATION_REASONS.has(reason));
    const resolved = resolveEscalation({ mode, probabilityTrue, deterministic, hardDeterministic });

    return {
      escalate: resolved.escalate,
      record: {
        ...baseRecord(input, "post-synthesis-escalation", mode, "after-draft-synthesis"),
        answer: result.answers,
        selectedProbability: probabilityTrue ?? undefined,
        deterministicDecision,
        effectiveDecision: resolved.escalate ? "escalate" : "stop",
        action: resolved.action,
        latencyMs: result.latencyMs,
        costUsd: result.costUsd,
        generationId: result.generationId,
      },
    };
  } catch (error) {
    return fallback(error);
  }
}
