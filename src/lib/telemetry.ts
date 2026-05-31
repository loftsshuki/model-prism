import { ModelInfo, ModelResponse, SynthesisResult } from "./types";

// Per-run, per-model telemetry. This module intentionally stays pure (no filesystem
// imports) so it can be used by both browser/client-adjacent code and Next.js routes
// without triggering server bundle tracing warnings.

export interface ModelRunTelemetry {
  id: string;
  name: string;
  family: string;
  tier: string;
  status: "complete" | "error" | "fallback";
  cost: number;
  tokensIn: number;
  tokensOut: number;
  themeAvg: number | null; // mean 0–3 coverage across themes that scored this model
  themeCount: number;
  uniqueHigh: number;
  uniqueMed: number;
  uniqueLow: number;
  consensusSupports: number;
}

export interface RunTelemetry {
  ts: string;
  plan: string;
  contentHash: string;
  contextRepo: string;
  roster: string;
  synthesisModel: string;
  durationSec: number;
  models: ModelRunTelemetry[];
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Match a free-text model reference from the synthesis (which is told to use model NAMES)
// against a roster model. Exact normalized name/id wins; a contained-substring match is the
// fallback for minor naming wobble, gated on length so short tokens don't over-match.
function refMatches(ref: string, m: ModelInfo): boolean {
  const r = norm(ref);
  const n = norm(m.name);
  const id = norm(m.id);
  if (!r) return false;
  if (r === n || r === id) return true;
  return n.length >= 4 && (r.includes(n) || n.includes(r));
}

export interface BuildRunArgs {
  ts: string;
  plan: string;
  contentHash: string;
  contextRepo: string;
  roster: string;
  synthesisModel: string;
  durationSec: number;
  synthesis: SynthesisResult;
  responses: ModelResponse[];
  usedModels: ModelInfo[];
}

export function buildRunTelemetry(a: BuildRunArgs): RunTelemetry {
  const models: ModelRunTelemetry[] = a.usedModels.map((m) => {
    const resp = a.responses.find((r) => r.model === m.id);
    const status: ModelRunTelemetry["status"] = resp?.fallbackFrom
      ? "fallback"
      : resp?.status === "complete"
        ? "complete"
        : "error";

    // Theme coverage: average this model's score across the themes that mention it.
    const themeScores: number[] = [];
    for (const t of a.synthesis.themeMatrix ?? []) {
      for (const [key, score] of Object.entries(t.scores)) {
        if (refMatches(key, m)) {
          themeScores.push(score);
          break;
        }
      }
    }
    const themeAvg = themeScores.length ? themeScores.reduce((s, x) => s + x, 0) / themeScores.length : null;

    // Unique insights attributed to this model, bucketed by significance (the "gold").
    let uniqueHigh = 0;
    let uniqueMed = 0;
    let uniqueLow = 0;
    for (const ins of a.synthesis.uniqueInsights ?? []) {
      if (!refMatches(ins.model, m)) continue;
      if (ins.significance === "high") uniqueHigh++;
      else if (ins.significance === "medium") uniqueMed++;
      else uniqueLow++;
    }

    const consensusSupports = (a.synthesis.consensus ?? []).filter((c) =>
      (c.supportingModels ?? []).some((sm) => refMatches(sm, m))
    ).length;

    return {
      id: m.id,
      name: m.name,
      family: m.family,
      tier: m.tier,
      status,
      cost: resp?.cost ?? 0,
      tokensIn: resp?.inputTokens ?? 0,
      tokensOut: resp?.outputTokens ?? 0,
      themeAvg,
      themeCount: themeScores.length,
      uniqueHigh,
      uniqueMed,
      uniqueLow,
      consensusSupports,
    };
  });

  return {
    ts: a.ts,
    plan: a.plan,
    contentHash: a.contentHash,
    contextRepo: a.contextRepo,
    roster: a.roster,
    synthesisModel: a.synthesisModel,
    durationSec: a.durationSec,
    models,
  };
}

export interface ModelValueRow {
  id: string;
  name: string;
  family: string;
  tier: string;
  appearances: number;
  completes: number;
  errors: number;
  fallbacks: number;
  successRate: number; // completes / appearances
  themeAvg: number | null; // mean coverage across runs
  uniquePerRun: number; // significance-weighted unique insights per appearance
  uniqueTotal: number;
  consensusPerRun: number;
  totalCost: number;
  costPerInsight: number | null; // totalCost / weighted unique (gold), null if no gold
  valueScore: number; // composite for ranking
  verdict: string;
}

export interface ModelFailureDiagnostic {
  id: string;
  name: string;
  severity: "low" | "medium" | "high";
  failureRate: number;
  fallbackRate: number;
  appearances: number;
  message: string;
}

export interface RosterRecommendation {
  id: string;
  type: "keep" | "watch" | "replace" | "promote";
  modelId: string;
  modelName: string;
  reason: string;
}

function weightedUnique(m: ModelRunTelemetry): number {
  return m.uniqueHigh * 3 + m.uniqueMed * 2 + m.uniqueLow;
}

// Aggregate the ledger into one ranked row per model. The headline signal is
// unique-insight rate (what a council is FOR); coverage and reliability shape the verdict.
export function aggregateModelValue(runs: RunTelemetry[]): ModelValueRow[] {
  const byId = new Map<string, ModelRunTelemetry[]>();
  const meta = new Map<string, { name: string; family: string; tier: string }>();
  for (const run of runs) {
    for (const m of run.models) {
      if (!byId.has(m.id)) byId.set(m.id, []);
      byId.get(m.id)!.push(m);
      meta.set(m.id, { name: m.name, family: m.family, tier: m.tier });
    }
  }

  const rows: ModelValueRow[] = [];
  for (const [id, entries] of byId) {
    const appearances = entries.length;
    const completes = entries.filter((e) => e.status === "complete").length;
    const errors = entries.filter((e) => e.status === "error").length;
    const fallbacks = entries.filter((e) => e.status === "fallback").length;
    const themeVals = entries.map((e) => e.themeAvg).filter((v): v is number => v !== null);
    const themeAvg = themeVals.length ? themeVals.reduce((s, x) => s + x, 0) / themeVals.length : null;
    const uniqueTotal = entries.reduce((s, e) => s + weightedUnique(e), 0);
    const uniquePerRun = uniqueTotal / appearances;
    const consensusPerRun = entries.reduce((s, e) => s + e.consensusSupports, 0) / appearances;
    const totalCost = entries.reduce((s, e) => s + e.cost, 0);
    const costPerInsight = uniqueTotal > 0 ? totalCost / uniqueTotal : null;
    const successRate = appearances ? completes / appearances : 0;

    // Composite value score: reward the gold (unique insight) most, then coverage, gated by
    // reliability. Free models that score well are the real bargains.
    const valueScore = (uniquePerRun * 2 + (themeAvg ?? 0)) * (0.5 + 0.5 * successRate);

    const info = meta.get(id)!;
    rows.push({
      id,
      name: info.name,
      family: info.family,
      tier: info.tier,
      appearances,
      completes,
      errors,
      fallbacks,
      successRate,
      themeAvg,
      uniquePerRun,
      uniqueTotal,
      consensusPerRun,
      totalCost,
      costPerInsight,
      valueScore,
      verdict: verdictFor({ uniquePerRun, themeAvg, successRate, fallbacks, appearances, tier: info.tier }),
    });
  }

  return rows.sort((a, b) => b.valueScore - a.valueScore);
}

function verdictFor(x: {
  uniquePerRun: number;
  themeAvg: number | null;
  successRate: number;
  fallbacks: number;
  appearances: number;
  tier: string;
}): string {
  const theme = x.themeAvg ?? 0;
  if (x.successRate < 0.5 || x.fallbacks / x.appearances > 0.5) return "🔴 unreliable — failing/falling back often";
  if (x.uniquePerRun >= 1.5) return x.tier === "free" ? "🌟 free & high-value — bargain" : "🌟 high value — earns its slot";
  if (x.uniquePerRun >= 0.5 || theme >= 2) return "✅ solid contributor";
  if (x.uniquePerRun < 0.25 && theme < 1.5) return "🔻 low signal — swap candidate";
  return "⚠️ marginal — watch";
}

export function analyzeModelFailures(rows: ModelValueRow[]): ModelFailureDiagnostic[] {
  return rows
    .filter((row) => row.appearances > 0)
    .map((row) => {
      const failureRate = row.errors / row.appearances;
      const fallbackRate = row.fallbacks / row.appearances;
      const combined = Math.max(failureRate, fallbackRate);
      const severity: ModelFailureDiagnostic["severity"] = combined >= 0.4
        ? "high"
        : combined >= 0.15
          ? "medium"
          : "low";
      return {
        id: row.id,
        name: row.name,
        severity,
        failureRate,
        fallbackRate,
        appearances: row.appearances,
        message: `${Math.round(failureRate * 100)}% errors, ${Math.round(fallbackRate * 100)}% fallback usage across ${row.appearances} run${row.appearances === 1 ? "" : "s"}`,
      };
    })
    .filter((item) => item.severity !== "low")
    .sort((a, b) => {
      const severityRank = { high: 2, medium: 1, low: 0 };
      return severityRank[b.severity] - severityRank[a.severity] || Math.max(b.failureRate, b.fallbackRate) - Math.max(a.failureRate, a.fallbackRate);
    });
}

export function recommendRosterChanges(rows: ModelValueRow[]): RosterRecommendation[] {
  const recommendations: RosterRecommendation[] = [];
  const ranked = [...rows].sort((a, b) => b.valueScore - a.valueScore);

  for (const row of ranked) {
    const failureRate = row.errors / Math.max(row.appearances, 1);
    const fallbackRate = row.fallbacks / Math.max(row.appearances, 1);
    const theme = row.themeAvg ?? 0;

    if (row.appearances >= 2 && (failureRate >= 0.4 || fallbackRate >= 0.4)) {
      recommendations.push({
        id: `replace-${row.id}`,
        type: "replace",
        modelId: row.id,
        modelName: row.name,
        reason: `Unreliable: ${Math.round(failureRate * 100)}% errors and ${Math.round(fallbackRate * 100)}% fallbacks.`,
      });
      continue;
    }

    if (row.appearances >= 2 && row.uniquePerRun < 0.25 && theme < 1.5 && row.totalCost > 0) {
      recommendations.push({
        id: `watch-${row.id}`,
        type: "watch",
        modelId: row.id,
        modelName: row.name,
        reason: "Low unique-insight and theme coverage signal for paid spend.",
      });
      continue;
    }

    if (row.appearances >= 1 && row.uniquePerRun >= 1.5 && row.successRate >= 0.8) {
      recommendations.push({
        id: `promote-${row.id}`,
        type: "promote",
        modelId: row.id,
        modelName: row.name,
        reason: `High value contributor: ${row.uniquePerRun.toFixed(1)} weighted unique insights per run.`,
      });
      continue;
    }

    if (row.appearances >= 3 && row.successRate >= 0.85 && (row.uniquePerRun >= 0.5 || theme >= 2)) {
      recommendations.push({
        id: `keep-${row.id}`,
        type: "keep",
        modelId: row.id,
        modelName: row.name,
        reason: "Reliable model with useful coverage or unique insight contribution.",
      });
    }
  }

  return recommendations.slice(0, 12);
}
