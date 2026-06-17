#!/usr/bin/env tsx
// ═══════════════════════════════════════════════════════════════════════════
// Model Prism — Phase 5 rollout gate check (automated, checked-in, rerunnable)
//
// Converts the "founder eyeballs the diffs" gate (council G4/T4/D3) into a hard,
// re-runnable query. Run AFTER a real dual-lens run on the golden set; this reports
// PASS/FAIL against the minimum bar set BEFORE running (E4). It does NOT flip the
// default — the founder reviews this report and then approves the two flip commits.
//
// Usage:
//   npm run fusion-gate -- --judge <path-to-persisted-judge.json> [--telemetry <jsonl>]
//   (judge JSON is written by runFusionMerge to <plan-dir>/reviews/<slug>/latest-fusion.judge.json)
//
// Gates (all must pass):
//   1. Strategic parity: ≥4 of the 6 manual-blend categories reproduced.
//   2. Fallback-rate:    below FALLBACK_THRESHOLD across the telemetry ledger.
//   3. Cost:             reported per roster; compared to --baseline-cost if provided
//                        (gate: ≤ 1.15× the supplied current-fusion baseline).
// ═══════════════════════════════════════════════════════════════════════════

import * as fs from "node:fs";
import { JudgeResult } from "../src/lib/fusion";
import { loadFusionTelemetry, aggregateFusionGates } from "../src/lib/fusion-telemetry";

// The 6 strategic categories the manual blend surfaced on the self-teaching-system
// plan (docs/plans/reviews/2026-06-08-self-teaching-system.ab-blended.review.md, LA
// branch window/panel-prism-fusion-build). teaching-efficacy folds into core-assumption.
const MANUAL_BLEND_CATEGORIES = [
  "core-assumption",          // teaching-efficacy / ZPD value-prop bet
  "success-metrics",          // widget instrumentation absent
  "accessibility",            // a11y of iframe lessons + widget
  "i18n",                     // i18n / timezone for lastUsed
  "product-viability",        // EROFS / serverless persistence viability
  "performance-scalability",  // cold-start / scale behavior
];

const PARITY_MIN = 4;              // ≥4 of 6
const FALLBACK_THRESHOLD = 0.15;   // L1 — under 15% fallback across the reference set
const COST_RATIO_CEIL = 1.15;      // ≤1.15× current fusion per roster tier

function getArg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function checkParity(judgePath: string): { covered: string[]; missing: string[]; pass: boolean } {
  const raw = JSON.parse(fs.readFileSync(judgePath, "utf-8"));
  // The persisted file wraps the judge under `.judge`; tolerate a bare judge too.
  const judge = JudgeResult.parse(raw.judge ?? raw);
  const present = new Set(judge.strategic_blind_spots.map((s) => s.category));
  const covered = MANUAL_BLEND_CATEGORIES.filter((c) => present.has(c));
  const missing = MANUAL_BLEND_CATEGORIES.filter((c) => !present.has(c));
  return { covered, missing, pass: covered.length >= PARITY_MIN };
}

function main(): void {
  const judgePath = getArg("--judge");
  const telemetryPath = getArg("--telemetry") ?? undefined;
  const baselineCost = getArg("--baseline-cost");

  console.log("═══ Model Prism — Phase 5 rollout gate ═══\n");

  let allPass = true;

  // Gate 1 — strategic parity
  if (judgePath) {
    const p = checkParity(judgePath);
    console.log(`[Gate 1] Strategic parity: ${p.covered.length}/${MANUAL_BLEND_CATEGORIES.length} categories (need ≥${PARITY_MIN})`);
    console.log(`         covered: ${p.covered.join(", ") || "(none)"}`);
    console.log(`         missing: ${p.missing.join(", ") || "(none)"}`);
    console.log(`         → ${p.pass ? "PASS" : "FAIL"}\n`);
    allPass = allPass && p.pass;
  } else {
    console.log("[Gate 1] Strategic parity: SKIPPED (pass --judge <path>)\n");
    allPass = false;
  }

  // Gates 2 & 3 — fallback-rate + cost from telemetry
  const runs = loadFusionTelemetry(telemetryPath);
  if (runs.length === 0) {
    console.log("[Gate 2/3] No fusion telemetry found — run the golden set first.\n");
    allPass = false;
  } else {
    const stats = aggregateFusionGates(runs);
    const fbPass = stats.fallbackRate <= FALLBACK_THRESHOLD;
    console.log(`[Gate 2] Fallback-rate: ${(stats.fallbackRate * 100).toFixed(1)}% across ${stats.runs} run(s) (ceil ${FALLBACK_THRESHOLD * 100}%)`);
    console.log(`         → ${fbPass ? "PASS" : "FAIL"}\n`);
    allPass = allPass && fbPass;

    console.log(`[Gate 3] Cost per roster (avg, from telemetry):`);
    for (const [roster, cost] of Object.entries(stats.avgCostByRoster)) {
      let verdict = "";
      if (baselineCost && cost !== null) {
        const ratio = cost / Number.parseFloat(baselineCost);
        verdict = ` — ${ratio.toFixed(2)}× baseline (ceil ${COST_RATIO_CEIL}×) → ${ratio <= COST_RATIO_CEIL ? "PASS" : "FAIL"}`;
        allPass = allPass && ratio <= COST_RATIO_CEIL;
      }
      console.log(`         ${roster}: ${cost === null ? "no cost data" : `$${cost.toFixed(4)}`}${verdict}`);
    }
    if (!baselineCost) console.log("         (pass --baseline-cost <usd> to gate the ratio)");
    console.log("");
    console.log(`         avg strategic findings/run: ${stats.avgStrategicCount.toFixed(1)}\n`);
  }

  console.log("═══════════════════════════════════════════");
  console.log(`OVERALL: ${allPass ? "✅ ALL GATES PASS — present to founder, then flip" : "❌ GATES NOT MET — do NOT flip the default"}`);
  console.log("Reminder: founder must record approval of THIS result before the two flip commits.");
  process.exit(allPass ? 0 : 1);
}

main();
