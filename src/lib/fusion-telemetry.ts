// ═══════════════════════════════════════════════════════════════════════════
// Model Prism — fusion run telemetry (Component E / T3 / G5)
//
// One structured record per fusion review, so the cost ceiling (≤~1.15× fusion per
// roster tier) and the L1 fallback-rate gate become CI-enforceable QUERIES, not
// manual retrofits. Pure builder + a JSONL sidecar ledger (separate file from the
// per-model model-telemetry.jsonl). Dashboard *visualization* is out of scope
// (Locked Decision 6 — no app/src); this module only EMITS the event.
// ═══════════════════════════════════════════════════════════════════════════

import * as path from "node:path";
import * as fs from "node:fs";
import type { PhaseUsage } from "./fusion";

export const FUSION_TELEMETRY_PATH =
  process.env.MODEL_PRISM_FUSION_TELEMETRY ||
  path.join(process.cwd(), ".model-prism", "fusion-telemetry.jsonl");

export interface FusionRunTelemetry {
  ts: string;
  plan: string;
  contextRepo: string;
  roster: string;                 // cost-by-roster-tier slicing (cheap | default | ...)
  prismMode: "fusion";
  fellBackToLegacy: boolean;      // L1 fallback-rate numerator
  // Per-phase token/cost (judge / synth / critic). Sum gives the per-run total.
  phases: PhaseUsage[];
  judgeAttempts: number;          // >1 ⇒ the judge retried (missing_key/empty/etc.)
  // Citation integrity outcomes.
  evidenceKept: number;
  evidenceDropped: number;
  citationsDropped: number;
  // Dual-lens output shape.
  lockedDecisionCount: number;
  strategicBlindSpotCount: number;
  strategicByCategory: Record<string, number>;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number | null;       // null if OpenRouter returned no cost on any phase
}

export interface BuildFusionTelemetryArgs {
  ts: string;
  plan: string;
  contextRepo: string;
  roster: string;
  fellBackToLegacy: boolean;
  phases: PhaseUsage[];
  evidenceKept: number;
  evidenceDropped: number;
  citationsDropped: number;
  lockedDecisions: string[];
  strategicBlindSpots: Array<{ category: string }>;
}

export function buildFusionTelemetry(a: BuildFusionTelemetryArgs): FusionRunTelemetry {
  const strategicByCategory: Record<string, number> = {};
  for (const s of a.strategicBlindSpots) {
    strategicByCategory[s.category] = (strategicByCategory[s.category] ?? 0) + 1;
  }

  const judgePhases = a.phases.filter((p) => p.phase === "judge");
  const judgeAttempts = judgePhases.reduce((m, p) => Math.max(m, p.attempts), 0);

  const totalInputTokens = a.phases.reduce((s, p) => s + p.inputTokens, 0);
  const totalOutputTokens = a.phases.reduce((s, p) => s + p.outputTokens, 0);
  // If ANY phase reported a cost, sum the known costs; if none did, leave null so a
  // missing-cost run isn't silently counted as $0 against the ceiling.
  const anyCost = a.phases.some((p) => p.cost !== null);
  const totalCost = anyCost ? a.phases.reduce((s, p) => s + (p.cost ?? 0), 0) : null;

  return {
    ts: a.ts,
    plan: a.plan,
    contextRepo: a.contextRepo,
    roster: a.roster,
    prismMode: "fusion",
    fellBackToLegacy: a.fellBackToLegacy,
    phases: a.phases,
    judgeAttempts,
    evidenceKept: a.evidenceKept,
    evidenceDropped: a.evidenceDropped,
    citationsDropped: a.citationsDropped,
    lockedDecisionCount: a.lockedDecisions.length,
    strategicBlindSpotCount: a.strategicBlindSpots.length,
    strategicByCategory,
    totalInputTokens,
    totalOutputTokens,
    totalCost,
  };
}

// Append one record to the JSONL ledger. Best-effort: a telemetry write must never
// fail a completed review (caller wraps in try/catch, same posture as appendRunTelemetry).
export function appendFusionTelemetry(record: FusionRunTelemetry, pathOverride?: string): void {
  const file = pathOverride || FUSION_TELEMETRY_PATH;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf-8");
}

export function loadFusionTelemetry(pathOverride?: string): FusionRunTelemetry[] {
  const file = pathOverride || FUSION_TELEMETRY_PATH;
  if (!fs.existsSync(file)) return [];
  const out: FusionRunTelemetry[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t) as FusionRunTelemetry); } catch { /* skip corrupt */ }
  }
  return out;
}

// Aggregate fallback-rate + per-roster cost ratio — the two Phase-5 rollout gates,
// as a checked-in query rather than a manual spreadsheet.
export interface FusionGateStats {
  runs: number;
  fallbackRate: number;                    // fellBackToLegacy / runs (L1 gate)
  avgCostByRoster: Record<string, number | null>;
  avgStrategicCount: number;
}

export function aggregateFusionGates(runs: FusionRunTelemetry[]): FusionGateStats {
  const n = runs.length;
  const fallbacks = runs.filter((r) => r.fellBackToLegacy).length;
  const byRoster = new Map<string, { cost: number; withCost: number }>();
  let strategicTotal = 0;
  for (const r of runs) {
    strategicTotal += r.strategicBlindSpotCount;
    const slot = byRoster.get(r.roster) ?? { cost: 0, withCost: 0 };
    if (r.totalCost !== null) { slot.cost += r.totalCost; slot.withCost += 1; }
    byRoster.set(r.roster, slot);
  }
  const avgCostByRoster: Record<string, number | null> = {};
  for (const [roster, slot] of byRoster) {
    avgCostByRoster[roster] = slot.withCost > 0 ? slot.cost / slot.withCost : null;
  }
  return {
    runs: n,
    fallbackRate: n > 0 ? fallbacks / n : 0,
    avgCostByRoster,
    avgStrategicCount: n > 0 ? strategicTotal / n : 0,
  };
}
