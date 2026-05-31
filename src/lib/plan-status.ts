export type PlanApprovalStatus = "draft" | "council-reviewed" | "needs-changes" | "founder-approved" | "ready" | "executed";

export const PLAN_APPROVAL_STATUSES: Array<{ id: PlanApprovalStatus; label: string; description: string }> = [
  { id: "draft", label: "Draft", description: "Not reviewed yet" },
  { id: "council-reviewed", label: "Council reviewed", description: "Multi-model review completed" },
  { id: "needs-changes", label: "Needs changes", description: "Must revise before approval" },
  { id: "founder-approved", label: "Founder approved", description: "Human approval recorded" },
  { id: "ready", label: "Ready for execution", description: "Approved and ready to implement" },
  { id: "executed", label: "Executed", description: "Implementation completed" },
];

const STORAGE_KEY = "model-prism-plan-statuses";

function readStore(): Record<string, PlanApprovalStatus> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function getPlanStatus(runId: string): PlanApprovalStatus {
  return readStore()[runId] || "council-reviewed";
}

export function setPlanStatus(runId: string, status: PlanApprovalStatus) {
  if (typeof window === "undefined") return;
  const store = readStore();
  store[runId] = status;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

export function buildPlanFrontmatter(input: {
  status: PlanApprovalStatus;
  reviewedAt?: string;
  approvedAt?: string;
  reviewModel?: string | null;
  roster?: string[];
  criticality?: "low" | "medium" | "high";
}) {
  const lines = [
    "---",
    `status: ${input.status}`,
    `reviewed-at: ${input.reviewedAt || new Date().toISOString()}`,
  ];
  if (input.approvedAt) lines.push(`approved-at: ${input.approvedAt}`);
  if (input.reviewModel) lines.push(`review-model: ${input.reviewModel}`);
  if (input.roster?.length) lines.push(`roster: [${input.roster.map((item) => `"${item}"`).join(", ")}]`);
  if (input.criticality) lines.push(`criticality: ${input.criticality}`);
  lines.push("---");
  return lines.join("\n");
}
