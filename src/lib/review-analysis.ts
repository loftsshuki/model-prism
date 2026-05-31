import { SynthesisResult } from "./types";

export type ReviewRisk = "Low" | "Medium" | "High";
export type ReviewSignal = "Low" | "Medium" | "High";

export interface ReviewQualityScore {
  score: number;
  risk: ReviewRisk;
  actionability: ReviewSignal;
  coverage: ReviewSignal;
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

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function levelFromScore(value: number): ReviewSignal {
  if (value >= 70) return "High";
  if (value >= 40) return "Medium";
  return "Low";
}

function riskFromScore(value: number): ReviewRisk {
  if (value >= 70) return "High";
  if (value >= 35) return "Medium";
  return "Low";
}

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

  for (const line of getDocumentLines(synthesis)) {
    if (ACTION_VERBS.test(line) || MUST_FIX.test(line)) addItem(line);
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
  const document = synthesis.masterDocument || "";
  const actions = extractActionItems(synthesis);
  const strongConsensus = (synthesis.consensus || []).filter((item) => item.strength === "strong").length;
  const highUniqueInsights = (synthesis.uniqueInsights || []).filter((item) => item.significance === "high").length;
  const disagreementCount = synthesis.disagreements?.length || 0;
  const blindSpotCount = synthesis.blindSpots?.length || 0;
  const themeCount = synthesis.themeMatrix?.length || 0;
  const fatalFlawsFound = (document.match(/\b(fatal|blocker|critical|must fix|do not ship|security)\b/gi) || []).length;

  const actionabilityRaw = clamp(actions.length * 9 + actions.filter((item) => item.priority === "must").length * 10, 0, 100);
  const coverageRaw = clamp(themeCount * 12 + strongConsensus * 8 + highUniqueInsights * 10 - blindSpotCount * 4, 0, 100);
  const disagreementRaw = clamp(disagreementCount * 28, 0, 100);
  const missingContextRaw = clamp(blindSpotCount * 18 + (/\b(missing context|unknown|not enough information|cannot determine)\b/i.test(document) ? 25 : 0), 0, 100);
  const confidenceRaw = clamp(strongConsensus * 16 + themeCount * 8 + actions.length * 3 - missingContextRaw * 0.35 - disagreementRaw * 0.15, 0, 100);

  const score = Math.round(clamp(
    35 + actionabilityRaw * 0.28 + coverageRaw * 0.26 + confidenceRaw * 0.2 + highUniqueInsights * 4 + fatalFlawsFound * 2 - missingContextRaw * 0.18,
    0,
    100
  ));

  const risk: ReviewRisk = fatalFlawsFound >= 3 || disagreementCount >= 3 || missingContextRaw >= 70
    ? "High"
    : fatalFlawsFound > 0 || disagreementCount > 0 || blindSpotCount >= 2
      ? "Medium"
      : "Low";

  const reasons = [
    `${actions.length} extracted action item${actions.length === 1 ? "" : "s"}`,
    `${strongConsensus} strong consensus point${strongConsensus === 1 ? "" : "s"}`,
    `${highUniqueInsights} high-significance unique insight${highUniqueInsights === 1 ? "" : "s"}`,
  ];
  if (fatalFlawsFound) reasons.push(`${fatalFlawsFound} fatal/critical signal${fatalFlawsFound === 1 ? "" : "s"}`);
  if (blindSpotCount) reasons.push(`${blindSpotCount} blind spot${blindSpotCount === 1 ? "" : "s"}`);
  if (disagreementCount) reasons.push(`${disagreementCount} disagreement${disagreementCount === 1 ? "" : "s"}`);

  return {
    score,
    risk,
    actionability: levelFromScore(actionabilityRaw),
    coverage: levelFromScore(coverageRaw),
    disagreementLevel: levelFromScore(disagreementRaw),
    confidence: levelFromScore(confidenceRaw),
    missingContextRisk: riskFromScore(missingContextRaw),
    fatalFlawsFound,
    reasons,
  };
}

export function buildActionChecklistMarkdown(items: ExtractedActionItem[]) {
  if (!items.length) return "No action items extracted.";
  return items
    .map((item) => `- [ ] [${item.priority.toUpperCase()}] ${item.text}${item.file ? ` (${item.file})` : ""}`)
    .join("\n");
}
