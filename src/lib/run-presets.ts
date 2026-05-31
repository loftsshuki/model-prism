import { ModelInfo } from "./types";

export type ModelSelectionPreset = "frontier" | "diverse" | "all" | "free";

export interface RunPreset {
  id: string;
  name: string;
  description: string;
  prompt: string;
  modelPreset: ModelSelectionPreset;
  synthesisModel: "sonnet" | "opus";
  maxCost: number;
}

export const DEFAULT_RUN_PRESETS: RunPreset[] = [
  {
    id: "plan-review",
    name: "Plan Review",
    description: "Adversarial review before implementation.",
    modelPreset: "diverse",
    synthesisModel: "opus",
    maxCost: 1.5,
    prompt: `Review this implementation plan before execution. Identify fatal flaws, production landmines, missing requirements, sequencing risks, and high-ROI improvements. Be specific, cite exact sections or files when possible, and finish with a clear approve / revise / reject recommendation.`,
  },
  {
    id: "code-review",
    name: "Code Review",
    description: "Find bugs, security issues, and maintainability problems.",
    modelPreset: "diverse",
    synthesisModel: "opus",
    maxCost: 1.25,
    prompt: `Review this code or diff. Focus on correctness, security, performance, edge cases, maintainability, and missing tests. Prioritize concrete findings over style opinions. Include exact fixes or refactor recommendations where possible.`,
  },
  {
    id: "security-review",
    name: "Security Review",
    description: "Threat-model secrets, auth, data access, and unsafe flows.",
    modelPreset: "frontier",
    synthesisModel: "opus",
    maxCost: 2,
    prompt: `Perform a security review. Look for exposed secrets, auth/authorization flaws, unsafe data access, injection risks, insecure defaults, dangerous automation, supply-chain risks, and privacy issues. Rank findings by severity and provide practical remediation steps.`,
  },
  {
    id: "product-critique",
    name: "Product Critique",
    description: "Pressure-test UX, positioning, and customer value.",
    modelPreset: "diverse",
    synthesisModel: "sonnet",
    maxCost: 0.75,
    prompt: `Critique this product idea, feature, or UX. Evaluate value proposition, target user clarity, friction, missing user journeys, differentiation, and launch risks. Suggest concrete improvements and the smallest useful next experiment.`,
  },
  {
    id: "architecture-review",
    name: "Architecture Review",
    description: "Review seams, data flow, reliability, and future change cost.",
    modelPreset: "frontier",
    synthesisModel: "opus",
    maxCost: 1.75,
    prompt: `Review this architecture. Evaluate module boundaries, interfaces, data flow, scalability, reliability, operational risk, testability, migration path, and blast radius. Identify the highest-leverage simplifications and the most dangerous coupling.`,
  },
  {
    id: "debugging-council",
    name: "Debugging Council",
    description: "Generate hypotheses and debugging steps for hard failures.",
    modelPreset: "diverse",
    synthesisModel: "sonnet",
    maxCost: 0.9,
    prompt: `Help debug this issue. Generate likely root causes, evidence to gather, commands or checks to run, and a prioritized fix plan. Separate confirmed facts from hypotheses. Prefer fast, reversible debugging steps first.`,
  },
];

export function selectModelsForPreset(
  models: ModelInfo[],
  preset: ModelSelectionPreset,
  tooSmall: Set<string> = new Set()
): Set<string> {
  const available = models.filter((model) => !tooSmall.has(model.id));

  if (preset === "free") {
    return new Set(available.filter((model) => model.tier === "free").map((model) => model.id));
  }

  if (preset === "frontier") {
    return new Set(available.filter((model) => model.tier === "frontier").slice(0, 8).map((model) => model.id));
  }

  if (preset === "diverse") {
    const seen = new Set<string>();
    const diverse: string[] = [];
    for (const model of available) {
      const key = `${model.family}-${model.tier}`;
      if (!seen.has(key)) {
        seen.add(key);
        diverse.push(model.id);
      }
      if (diverse.length >= 10) break;
    }
    return new Set(diverse);
  }

  return new Set(available.map((model) => model.id));
}
