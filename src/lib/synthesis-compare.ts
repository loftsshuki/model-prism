import { SynthesisResult } from "./types";

export interface SynthesisComparison {
  oldRiskCount: number;
  newRiskCount: number;
  addedRisks: string[];
  removedRisks: string[];
  changedRecommendations: string[];
  modelRosterChanged: boolean;
}

const RISK_WORDS = /\b(risk|blocker|critical|security|vulnerab|leak|expose|unsafe|regression|failure|missing|must|do not ship|broken)\b/i;
const ACTION_WORDS = /\b(add|change|fix|remove|replace|review|test|verify|validate|harden|block|ship|approve|revise|implement)\b/i;

function normalize(line: string) {
  return line
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/^#+\s+/, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function significantLines(text = "", matcher: RegExp) {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const line = normalize(raw);
    if (line.length < 18 || !matcher.test(line)) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
  return lines;
}

function hasSimilarLine(line: string, candidates: string[]) {
  const words = new Set(line.toLowerCase().split(/\W+/).filter((word) => word.length > 4));
  if (!words.size) return false;
  return candidates.some((candidate) => {
    const candidateWords = candidate.toLowerCase().split(/\W+/).filter((word) => word.length > 4);
    const overlap = candidateWords.filter((word) => words.has(word)).length;
    return overlap / Math.max(words.size, candidateWords.length, 1) >= 0.55;
  });
}

export function compareSyntheses(previous: SynthesisResult, next: SynthesisResult): SynthesisComparison {
  const previousText = previous.masterDocument || "";
  const nextText = next.masterDocument || "";
  const previousRisks = [
    ...significantLines(previousText, RISK_WORDS),
    ...(previous.blindSpots || []).map((item) => normalize(item)),
    ...(previous.disagreements || []).map((item) => normalize(item.topic)),
  ].filter(Boolean);
  const nextRisks = [
    ...significantLines(nextText, RISK_WORDS),
    ...(next.blindSpots || []).map((item) => normalize(item)),
    ...(next.disagreements || []).map((item) => normalize(item.topic)),
  ].filter(Boolean);

  const previousActions = significantLines(previousText, ACTION_WORDS);
  const nextActions = significantLines(nextText, ACTION_WORDS);

  return {
    oldRiskCount: previousRisks.length,
    newRiskCount: nextRisks.length,
    addedRisks: nextRisks.filter((line) => !hasSimilarLine(line, previousRisks)).slice(0, 8),
    removedRisks: previousRisks.filter((line) => !hasSimilarLine(line, nextRisks)).slice(0, 8),
    changedRecommendations: nextActions.filter((line) => !hasSimilarLine(line, previousActions)).slice(0, 8),
    modelRosterChanged: false,
  };
}
