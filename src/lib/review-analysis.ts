import { SynthesisResult } from "./types";

export type ReviewRisk = "Low" | "Medium" | "High" | "Unassessed";
export type ReviewSignal = "Low" | "Medium" | "High";

export interface ReviewQualityScore {
  score: number | null;
  risk: ReviewRisk;
  actionability: ReviewSignal;
  coverage: ReviewSignal | "Unscored";
  disagreementLevel: ReviewSignal;
  confidence: ReviewSignal;
  missingContextRisk: ReviewRisk;
  fatalFlawsFound: number;
  reasons: string[];
}

export interface ExtractedActionItem {
  id: string;
  text: string;
  category: "todo" | "risk" | "file" | "decision";
  priority: "must" | "should" | "could";
  owner: "Agent" | "Human" | "Unassigned";
  file?: string;
}

const ACTION_VERBS = /\b(add|audit|block|change|check|confirm|create|delete|document|ensure|fix|guard|harden|implement|investigate|measure|move|prevent|refactor|remove|replace|review|ship|simplify|test|update|validate|verify)\b/i;
const MUST_FIX = /\b(must|blocker|blocking|critical|fatal|security|before approval|before shipping|do not ship|required|urgent)\b/i;
const DECISION = /\b(approve|choose|decide|decision|confirm|manual|owner|product call)\b/i;
const FILE_PATH = /([\w./\\-]+\.(?:cjs|css|env|html|js|jsx|json|md|mjs|prisma|py|sh|sql|ts|tsx|yaml|yml))/i;

function getDocumentLines(synthesis: SynthesisResult) {
  return (synthesis.masterDocument || "")
    .split("\n")
    .map((line) => line.trim())
    .map((line) => line.replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, "").replace(/^\[[ xX]\]\s+/, ""))
    .filter(Boolean);
}

export function extractActionItems(synthesis: SynthesisResult): ExtractedActionItem[] {
  const seen = new Set<string>();
  const items: ExtractedActionItem[] = [];

  const addItem = (text: string, fallbackCategory: ExtractedActionItem["category"] = "todo") => {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length < 12 || seen.has(normalized.toLowerCase())) return;
    seen.add(normalized.toLowerCase());

    const file = normalized.match(FILE_PATH)?.[1];
    const priority: ExtractedActionItem["priority"] = MUST_FIX.test(normalized)
      ? "must"
      : /\b(nice to have|optional|later|could)\b/i.test(normalized)
        ? "could"
        : "should";
    const category: ExtractedActionItem["category"] = file
      ? "file"
      : DECISION.test(normalized)
        ? "decision"
        : fallbackCategory;
    const owner: ExtractedActionItem["owner"] = category === "decision" ? "Human" : "Agent";

    items.push({
      id: `action-${items.length + 1}`,
      text: normalized,
      category,
      priority,
      owner,
      file,
    });
  };

  for (const finding of synthesis.findings ?? []) {
    addItem(finding.recommendation, "risk");
    const item = items[items.length - 1];
    if (item) item.priority = ["critical", "high"].includes(finding.severity) ? "must" : finding.severity === "medium" ? "should" : "could";
  }

  for (const line of synthesis.findings ? [] : getDocumentLines(synthesis).filter((line) => !line.startsWith("#"))) {
    if (ACTION_VERBS.test(line) && !/\b(no|without|not a)\b.{0,30}\b(critical|blocker|security|fatal)\b/i.test(line)) addItem(line);
    if (items.length >= 20) break;
  }

  for (const blindSpot of synthesis.blindSpots || []) {
    addItem(`Investigate blind spot: ${blindSpot}`, "risk");
  }

  for (const disagreement of synthesis.disagreements || []) {
    addItem(`Resolve disagreement: ${disagreement.topic}`, "decision");
  }

  return items.slice(0, 24);
}

export function analyzeReviewQuality(synthesis: SynthesisResult): ReviewQualityScore {
  const findings = synthesis.findings;
  const verified = (findings ?? []).filter((finding) => finding.evidenceVerified);
  const actions = extractActionItems(synthesis);
  const count = findings?.length ?? 0;
  const score = count ? Math.round(100 * verified.length / count) : null;
  const fatalFlawsFound = verified.filter((finding) => finding.severity === "critical").length;
  const risk: ReviewRisk = !findings ? "Unassessed" : verified.some((finding) => ["critical", "high"].includes(finding.severity)) ? "High"
    : verified.some((finding) => finding.severity === "medium") ? "Medium" : count > verified.length ? "Unassessed" : "Low";
  return { score, risk, fatalFlawsFound,
    actionability: actions.length >= 3 ? "High" : actions.length ? "Medium" : "Low",
    coverage: score === null ? "Unscored" : score < 50 ? "Low" : score < 100 ? "Medium" : "High",
    disagreementLevel: synthesis.disagreements.length >= 3 ? "High" : synthesis.disagreements.length ? "Medium" : "Low",
    // This is evidence traceability, not an accuracy or probability score.
    confidence: "Low",
    missingContextRisk: synthesis.blindSpots.length ? "Medium" : "Unassessed",
    reasons: findings ? [count ? verified.length + " of " + count + " findings have exact quotes traceable to supplied sources." : "No concrete findings reported; coverage is unscored.",
      "Source matches do not establish correctness. Model agreement is not independent validation."]
      : ["Legacy review: no structured evidence, so risk and coverage are unscored."],
  };
}

export function buildActionChecklistMarkdown(items: ExtractedActionItem[]) {
  if (!items.length) return "No action items extracted.";
  return items
    .map((item) => `- [ ] [${item.priority.toUpperCase()}] ${item.text}${item.file ? ` (${item.file})` : ""}`)
    .join("\n");
}
