// ═══════════════════════════════════════════════════════════════════════════
// Model Prism — eval scoring.
//
// Turns "did this roster / prompt / mode change make reviews better?" into
// numbers. A golden plan carries SEEDED flaws (evals/golden/<plan>.expected.json);
// the council's structured findings for that plan are matched against them:
//   - recall:    seeded flaws that at least one finding matched / seeded flaws;
//   - precision: findings that matched some flaw / all findings (a PROXY — see
//                scorePlan; an unmatched finding is not necessarily wrong);
//   - criticalRecall: recall restricted to flaws seeded as `critical`.
//
// Matching is deliberately cheap and deterministic (keyword groups, then the same
// claimSimilarity the consensus clustering uses) so the harness has no model in
// the loop and CI can run it offline against recorded fixtures.
//
// Browser-safe: no node: imports (the web app may render eval summaries later).
// ═══════════════════════════════════════════════════════════════════════════

import { claimSimilarity, findingId } from "./findings";

export interface SeededFlaw {
  id: string;
  severity: string;
  category?: string;
  description: string;
  /** Lowercased match terms; each entry may be a `|`-separated alternative group. */
  keywords: string[];
  location?: string;
}

export interface EvalFinding {
  id?: string;
  claim: string;
  severity?: string;
  category?: string;
  location?: string;
  evidence?: string;
  model?: string;
}

export interface PlanScore {
  plan: string;
  recall: number;
  precision: number;
  matched: Array<{ flaw: string; finding: string; by: "keywords" | "similarity" }>;
  missed: string[];
  falseFindings: number;
  totalFindings: number;
  criticalRecall: number;
}

export interface EvalRunSummary {
  runs: PlanScore[];
  meanRecall: number;
  meanPrecision: number;
  meanCriticalRecall: number;
  totalCost: number;
  totalDurationSec: number;
  roster: string;
  mode: string;
  ts: string;
}

/** Share of a flaw's keyword groups a finding must satisfy (ceil'd) to count as a keyword match. */
export const KEYWORD_COVERAGE = 0.7;
/** claimSimilarity floor for the fallback match. Above the cluster threshold (0.42) on purpose: a flaw description is not a peer claim. */
export const SIMILARITY_THRESHOLD = 0.5;
/** Rate deltas smaller than this are noise (one flaw on a 6-plan set moves recall by ~0.03). */
export const RATE_EPSILON = 0.02;
/** Cost changes within ±20% are treated as "same" — OpenRouter usage varies run to run. */
export const COST_EPSILON_RATIO = 0.2;

/** The id the scorer reports for a finding: its own id when present, else the stable claim hash. */
export function evalFindingId(f: EvalFinding): string {
  return f.id && f.id.trim() ? f.id : findingId(f.claim);
}

function findingText(f: EvalFinding): string {
  return [f.claim, f.evidence ?? "", f.location ?? ""].join(" ").toLowerCase();
}

function keywordGroups(flaw: SeededFlaw): string[][] {
  return flaw.keywords
    .map((k) => k.split("|").map((alt) => alt.trim().toLowerCase()).filter(Boolean))
    .filter((g) => g.length > 0);
}

/** How many groups a finding must hit. Integer arithmetic so 0.7 × n never rounds up on float error. */
export function requiredGroups(groupCount: number): number {
  return Math.ceil((groupCount * (KEYWORD_COVERAGE * 10)) / 10);
}

export function matchFlaw(flaw: SeededFlaw, finding: EvalFinding): "keywords" | "similarity" | null {
  const groups = keywordGroups(flaw);
  // A flaw with no usable keywords can only match by similarity — otherwise
  // ceil(0) = 0 groups would make every finding a match.
  if (groups.length > 0) {
    const text = findingText(finding);
    let hit = 0;
    for (const g of groups) if (g.some((alt) => text.includes(alt))) hit++;
    if (hit >= requiredGroups(groups.length)) return "keywords";
  }
  if (claimSimilarity(finding.claim, flaw.description) >= SIMILARITY_THRESHOLD) return "similarity";
  return null;
}

export function scorePlan(plan: string, flaws: SeededFlaw[], findings: EvalFinding[]): PlanScore {
  const matched: PlanScore["matched"] = [];
  const missed: string[] = [];
  // Every finding that matches ANY flaw counts as a true finding for precision, so
  // we walk all findings per flaw rather than stopping at the first hit.
  const trueFindings = new Set<string>();

  for (const flaw of flaws) {
    let best: { finding: string; by: "keywords" | "similarity" } | null = null;
    for (const f of findings) {
      const by = matchFlaw(flaw, f);
      if (!by) continue;
      const id = evalFindingId(f);
      trueFindings.add(id);
      // Prefer a keyword match as the representative: it is the more explainable of the two.
      if (!best || (best.by === "similarity" && by === "keywords")) best = { finding: id, by };
    }
    if (best) matched.push({ flaw: flaw.id, ...best });
    else missed.push(flaw.id);
  }

  const critical = flaws.filter((f) => f.severity === "critical");
  const criticalHit = critical.filter((f) => matched.some((m) => m.flaw === f.id)).length;
  const totalFindings = findings.length;
  // Precision is a PROXY: an unmatched finding may be a real problem the golden set
  // never seeded. It still measures signal density — a council that buries the
  // seeded flaws under thirty generic notes scores lower than one that does not.
  // With zero findings there is nothing false, so precision is reported as 1 (and
  // recall as 0 through the normal path); with zero flaws recall is vacuously 1.
  const falseFindings = totalFindings - trueFindings.size;

  return {
    plan,
    recall: flaws.length > 0 ? matched.length / flaws.length : 1,
    precision: totalFindings > 0 ? trueFindings.size / totalFindings : 1,
    matched,
    missed,
    falseFindings,
    totalFindings,
    criticalRecall: critical.length > 0 ? criticalHit / critical.length : 1,
  };
}

function mean(xs: number[]): number {
  return xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

export function summarize(runs: PlanScore[], meta: { roster: string; mode: string; cost: number; durationSec: number }): EvalRunSummary {
  return {
    runs,
    meanRecall: mean(runs.map((r) => r.recall)),
    meanPrecision: mean(runs.map((r) => r.precision)),
    meanCriticalRecall: mean(runs.map((r) => r.criticalRecall)),
    totalCost: meta.cost,
    totalDurationSec: meta.durationSec,
    roster: meta.roster,
    mode: meta.mode,
    ts: new Date().toISOString(),
  };
}

export interface SummaryComparison {
  recallDelta: number;
  precisionDelta: number;
  costDelta: number;
  verdict: "better" | "worse" | "mixed" | "same";
  notes: string[];
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const signed = (x: number, digits = 0) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(digits)}pp`;
const usd = (x: number) => `$${x.toFixed(4)}`;

/**
 * Verdict rules (documented here because they encode a policy, not just arithmetic):
 *   - A drop in recall or critical recall beyond RATE_EPSILON is "worse", full stop.
 *     The tool exists to catch seeded flaws; no cost saving or precision gain offsets
 *     missing one.
 *   - Otherwise gains vs losses across precision and cost decide better / mixed / same.
 */
export function compareSummaries(baseline: EvalRunSummary, candidate: EvalRunSummary): SummaryComparison {
  const recallDelta = candidate.meanRecall - baseline.meanRecall;
  const criticalDelta = candidate.meanCriticalRecall - baseline.meanCriticalRecall;
  const precisionDelta = candidate.meanPrecision - baseline.meanPrecision;
  const costDelta = candidate.totalCost - baseline.totalCost;
  const costRatio = baseline.totalCost > 0 ? candidate.totalCost / baseline.totalCost : candidate.totalCost > 0 ? Infinity : 1;
  const notes: string[] = [];

  if (baseline.roster !== candidate.roster || baseline.mode !== candidate.mode) {
    notes.push(`comparing ${baseline.roster}/${baseline.mode} → ${candidate.roster}/${candidate.mode}`);
  }
  if (baseline.runs.length !== candidate.runs.length) {
    notes.push(`plan count differs (${baseline.runs.length} → ${candidate.runs.length}); means are not like-for-like`);
  }

  let ups = 0, downs = 0;
  const rate = (label: string, delta: number, from: number, to: number) => {
    if (Math.abs(delta) < RATE_EPSILON) return;
    notes.push(`${label} ${pct(from)} → ${pct(to)} (${signed(delta)})`);
    if (delta > 0) ups++; else downs++;
  };
  rate("recall", recallDelta, baseline.meanRecall, candidate.meanRecall);
  rate("critical recall", criticalDelta, baseline.meanCriticalRecall, candidate.meanCriticalRecall);
  const recallRegressed = recallDelta < -RATE_EPSILON || criticalDelta < -RATE_EPSILON;
  rate("precision", precisionDelta, baseline.meanPrecision, candidate.meanPrecision);

  if (costRatio === Infinity || Math.abs(costRatio - 1) >= COST_EPSILON_RATIO) {
    notes.push(`cost ${usd(baseline.totalCost)} → ${usd(candidate.totalCost)} (${costRatio === Infinity ? "from $0" : `${costRatio.toFixed(2)}×`})`);
    if (costDelta > 0) downs++; else ups++;
  }

  let verdict: SummaryComparison["verdict"];
  if (recallRegressed) {
    verdict = "worse";
    notes.push("recall regressed — no cost or precision gain offsets a missed seeded flaw");
  } else if (ups > 0 && downs === 0) verdict = "better";
  else if (downs > 0 && ups === 0) verdict = "worse";
  else if (ups > 0 && downs > 0) verdict = "mixed";
  else verdict = "same";

  return { recallDelta, precisionDelta, costDelta, verdict, notes };
}

/** Markdown for $GITHUB_STEP_SUMMARY: one row per plan plus a totals row, missed flaws, and the baseline comparison. */
export function renderEvalMarkdown(summary: EvalRunSummary, baseline?: EvalRunSummary): string {
  const lines: string[] = [];
  lines.push(`## Model Prism eval — roster \`${summary.roster}\`, mode \`${summary.mode}\``);
  lines.push("");
  lines.push(`${summary.runs.length} plan(s) · cost ${usd(summary.totalCost)} · ${summary.totalDurationSec.toFixed(1)}s · ${summary.ts}`);
  lines.push("");
  lines.push("| Plan | Recall | Critical recall | Precision | Found | Missed | False | Findings |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|");
  let found = 0, missed = 0, falseFindings = 0, findings = 0;
  for (const r of summary.runs) {
    const flaws = r.matched.length + r.missed.length;
    found += r.matched.length; missed += r.missed.length; falseFindings += r.falseFindings; findings += r.totalFindings;
    lines.push(`| ${r.plan} | ${pct(r.recall)} (${r.matched.length}/${flaws}) | ${pct(r.criticalRecall)} | ${pct(r.precision)} | ${r.matched.length} | ${r.missed.length} | ${r.falseFindings} | ${r.totalFindings} |`);
  }
  lines.push(`| **Mean / total** | **${pct(summary.meanRecall)}** | **${pct(summary.meanCriticalRecall)}** | **${pct(summary.meanPrecision)}** | ${found} | ${missed} | ${falseFindings} | ${findings} |`);

  const withMisses = summary.runs.filter((r) => r.missed.length > 0);
  if (withMisses.length > 0) {
    lines.push("", "<details><summary>Missed seeded flaws</summary>", "");
    for (const r of withMisses) lines.push(`- **${r.plan}**: ${r.missed.map((m) => `\`${m}\``).join(", ")}`);
    lines.push("", "</details>");
  }

  if (baseline) {
    const c = compareSummaries(baseline, summary);
    lines.push("", `### vs baseline (${baseline.roster}/${baseline.mode}, ${baseline.ts}) — **${c.verdict}**`, "");
    lines.push("| Metric | Baseline | Candidate | Δ |");
    lines.push("|---|---:|---:|---:|");
    lines.push(`| Recall | ${pct(baseline.meanRecall)} | ${pct(summary.meanRecall)} | ${signed(c.recallDelta)} |`);
    lines.push(`| Critical recall | ${pct(baseline.meanCriticalRecall)} | ${pct(summary.meanCriticalRecall)} | ${signed(summary.meanCriticalRecall - baseline.meanCriticalRecall)} |`);
    lines.push(`| Precision | ${pct(baseline.meanPrecision)} | ${pct(summary.meanPrecision)} | ${signed(c.precisionDelta)} |`);
    lines.push(`| Cost | ${usd(baseline.totalCost)} | ${usd(summary.totalCost)} | ${c.costDelta >= 0 ? "+" : "-"}${usd(Math.abs(c.costDelta))} |`);
    if (c.notes.length > 0) {
      lines.push("");
      for (const n of c.notes) lines.push(`- ${n}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
