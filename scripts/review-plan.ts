#!/usr/bin/env node
/**
 * Model Prism CLI — review plans with 10 free models + Opus synthesis.
 *
 * Usage:
 *   npx tsx scripts/review-plan.ts <path-to-plan-or-folder> [options]
 *
 * Options:
 *   --batch          Process all plans in folder (vs single file)
 *   --force          Re-review even if review file already exists with matching hash
 *   --dry-run        Print what would run, make no API calls
 *   --max-cost N     Abort batch if cumulative cost exceeds N dollars
 *   --no-enhance     Skip AI enhancement of the repo brief (use template only)
 *
 * Environment:
 *   OPENROUTER_API_KEY   Required — bills the ENTIRE pipeline (council fan-out,
 *                        brief enhancement via Sonnet, and Opus synthesis). The
 *                        Anthropic API is never called directly.
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { fanOut } from "../src/lib/fan-out";
import { synthesizeViaOpenRouter, OPENROUTER_SYNTHESIS_MODEL_ID } from "../src/lib/synthesis";
// Fusion path (judge→synthesizer). Only reachable under --prism-mode fusion; legacy
// (single-Opus merge) is untouched and remains the default + permanent fallback.
import {
  judgeViaOpenRouter, synthesizeFromJudge, JudgeError,
  dropUnresolvedCitations, tightenProse, renderDualLensSections,
  type JudgeResult, type PhaseUsage,
  type JudgeExtras,
} from "../src/lib/fusion";
import { buildFusionTelemetry, appendFusionTelemetry } from "../src/lib/fusion-telemetry";
import { computeRiskScore, summarizeRisk, type RiskScore } from "../src/lib/risk-score";
import { extractLockedDecisions, lintLockedDecisions } from "../src/lib/locked-decisions";
import { pinHeadSha, verifyJudgeEvidence } from "../src/lib/fusion-integrity";
import { shouldRunAgentic, runAgenticMember } from "../src/lib/fusion-agentic";
import {
  buildLocalContext, buildLocalContextString, findRepoRoot, LocalContext,
  detectPlanReferencedFiles, loadReferencedFiles, detectSemanticReferences,
} from "../src/lib/local-context";
import { ModelInfo, ModelResponse, SynthesisResult } from "../src/lib/types";
// Council rosters live in their own module so the freshness checker
// (scripts/check-roster-freshness.ts) reads the exact rosters that run here.
import { ROSTERS, resolveAutoRoster, AUTO_THRESHOLD_TOKENS, readCriticality } from "../src/lib/rosters";
import { buildRunTelemetry } from "../src/lib/telemetry";
import { appendRunTelemetry } from "../src/lib/telemetry-ledger";
import { buildReviewRecord, appendReviewRecord, writeBrainDigest } from "../src/lib/review-ledger";
import { clusterFindings, consensusBlock, classifyCluster, SaturationTracker, type FindingCluster, type MemberFindings } from "../src/lib/findings";
import { checkGroundTruth, renderFactsBlock, markUnverifiedFindings, type GroundTruthReport } from "../src/lib/ground-truth";
import { assignLenses, lensPrompt, lensCoverage } from "../src/lib/lenses";
import { fileResponseCache, loadRunResponses, saveRunResponses, runResponsesPath, type CachedResponse } from "../src/lib/response-cache";
import { summarizeSimilarity } from "../src/lib/similarity";
import { compareReviews, parseFindingRefsFromReview, renderComparisonMarkdown, type ReviewComparison, type ReviewFindingRef } from "../src/lib/review-compare";
import { runDebateRound, applyDebateToJudge, renderDebateMarkdown, type DebateResult } from "../src/lib/debate";

// --- The review prompt ---

const REVIEW_PROMPT = `You are reviewing an implementation plan for a software project. The plan is a detailed spec that will be executed by engineers.

**IMPORTANT — Verification rules:**
- The CODEBASE CONTEXT below may include a "PLAN-REFERENCED FILES" section with the actual contents of files the plan mentions. **Treat these as ground truth.**
- Before flagging anything as a "FATAL FLAW", verify the file or symbol you're concerned about appears in PLAN-REFERENCED FILES. If it does, read the actual code — do not guess from the filename.
- If a file is NOT shown in PLAN-REFERENCED FILES, your concern about it is "unverified" — mark it as a LANDMINE or GAP, never a FATAL FLAW.
- Never invent file paths, function names, or type signatures. If you don't see it in the provided context, say "needs verification" instead of asserting.

Produce a critical review covering:

**1. FATAL FLAWS** — Anything that will break the implementation outright, *verifiable against the provided file contents*. Be specific: what fails, when, why, and which line of which file.

**2. LANDMINES** — Things that work in demos but detonate in production. Edge cases, scale issues, race conditions, security gaps. May be unverified if grounded in patterns rather than specific code.

**3. GAPS** — Missing pieces. What's assumed but not specified? What's implied but not implemented?

**4. TURBOCHARGES** — High-ROI additions the plan is leaving on the table. What would make this meaningfully better for low effort?

**5. EXECUTION RISKS** — What will actually go wrong during implementation? Ordering issues, dependency problems, things that'll require rework.

Be specific, technical, and adversarial. Cite file paths and line numbers when possible (especially when verified against PLAN-REFERENCED FILES). Don't pad the review with generic advice. If a section has nothing worth saying, say so in one line and move on.`;

// --- Args parsing ---

interface Args {
  target: string;
  batch: boolean;
  force: boolean;
  dryRun: boolean;
  maxCost: number;
  maxCostPerPlan: number;
  minSuccessfulModels: number;
  enhance: boolean;
  // Second-pass / custom-review support:
  reviewPromptPath: string | null;    // override fan-out REVIEW_PROMPT
  synthesisPromptPath: string | null; // override Opus synthesis trailing instructions
  outputPath: string | null;          // explicit output path; bypasses getReviewPath()
  excludeModels: string[];            // repeatable: model IDs to drop from council
  roster: string | null;              // roster preset name ('default'|'frontier'|'cheap'|'auto')
  autoThresholdTokens: number;        // size cutoff (tokens) for --roster auto
  // --- Fusion mode (judge→synthesizer). Legacy is the default; fusion is opt-in. ---
  prismMode: "legacy" | "fusion";     // master switch (B14). Default legacy.
  fusionTwoStage: boolean;            // judge→synthesizer split (default ON in fusion)
  fusionRiskGate: boolean;            // structured risk scorer (default ON in fusion)
  fusionAgentic: boolean;             // repo-grep/web members on high-risk (default OFF)
  // --- Council upgrades ---
  structured: boolean;                // members return report_findings (default ON in fusion, OFF in legacy)
  groundTruth: boolean;               // verify referenced paths/symbols/tables before the council (default ON)
  lenses: boolean;                    // assign review lenses round-robin across families (--lenses)
  cache: boolean;                     // content-addressed response cache (default ON; --no-cache)
  resume: boolean;                    // reuse persisted council responses for this plan+prompt (--resume)
  synthesizeOnly: boolean;            // never run the council; require persisted responses (--synthesize-only)
  adaptive: boolean;                  // stop launching paid members once consensus saturates (--adaptive)
  tiered: boolean;                    // cheap council first; escalate to the selected roster on high-severity findings (--tiered)
  debate: boolean;                    // cross-examination round on judge contradictions (fusion; --debate)
}

// Merge-stage pricing for the circuit breaker (Opus 4.8 via OpenRouter, USD per 1M tokens).
// Keep next to OPENROUTER_SYNTHESIS_MODEL_ID when that changes.
const SYNTHESIS_PRICE_PER_M = { input: 5, output: 25 };
const ESTIMATED_MERGE_OUTPUT_TOKENS = 8000; // a rewritten master plan as tool-call JSON

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(`Model Prism CLI — Review plans with 10 free models + Opus synthesis

Usage:
  npx tsx scripts/review-plan.ts <plan-file-or-folder> [options]

Options:
  --batch                    Process all .md plans in folder
  --force                    Re-review even if review exists with matching hash
  --dry-run                  Print what would run, no API calls
  --max-cost N               Abort batch if cumulative cost > N dollars (default: 30)
  --max-cost-per-plan N      Per-plan circuit breaker (default: 6.00)
  --min-successful-models N  Require N successful responses before synthesis (default: 6)
  --no-enhance               Skip AI brief enhancement (use template only)
  --review-prompt <path>     Use a custom prompt for the 10-model fan-out instead of
                             the built-in plan-review prompt (also re-labels output
                             as a "Second-Pass Review" rather than "Plan Review")
  --synthesis-prompt <path>  Use a custom trailing instruction for the Opus synthesis
                             step instead of the built-in masterDocument framework
  --output-path <path>       Write the review to this exact path instead of the
                             auto-derived <dir>/reviews/<name>.review.md
  --exclude-model <id>       Drop a council model by ID (repeatable). Useful on
                             second-pass to drop the primary reviewer's model family
                             for maximum divergence (e.g. --exclude-model openai/gpt-5.5)
  --roster <name>            Select a council preset. Options:
                               default / frontier (the DEFAULT — 3 free anchors +
                                        7 frontier reasoning models: MiniMax M2.7,
                                        GPT-5.5, Gemini 3.5 Flash, Grok 4.3, Qwen 3.7
                                        Max, DeepSeek V4 Pro, Kimi K2.6. ~$1-2/run.
                                        Best results; runs on every plan)
                               cheap    (5 free + 5 cheap paid, ~$0.25/run, tuned for
                                        bulk / low-stakes throughput)
                               auto     (stakes-adaptive — picks cheap vs frontier PER
                                        plan by size: small plans get cheap, substantial
                                        ones get frontier. A 'criticality: low|high'
                                        frontmatter field overrides the size heuristic.)
  --auto-threshold-tokens N  Size cutoff for --roster auto (default: ${AUTO_THRESHOLD_TOKENS}).
                             Plans estimated at ≥ N tokens get the frontier council.
  --prism-mode <mode>        legacy (default) | fusion. legacy = single-Opus merge,
                             fires every run (A/B baseline + permanent fallback).
                             fusion = judge→synthesizer split + risk scoring.
  --no-two-stage             In fusion mode, skip the judge→synthesizer split and
                             use the legacy single-Opus merge (sub-flag, B14).
  --no-risk-gate             In fusion mode, skip structured risk scoring.
  --agentic                  In fusion mode, allow repo-grep/web council members on
                             HIGH-risk plans (default OFF; requires two-stage). B14
                             invalid combo (--agentic --no-two-stage) is rejected.
  --structured / --no-structured
                             Council members return discrete findings (severity, evidence,
                             stable ids) via a tool call instead of prose. Enables computed
                             consensus, adaptive stop, feedback and review diffs.
                             Default: ON in fusion mode, OFF in legacy.
  --no-ground-truth          Skip the zero-cost pre-check that verifies every path / symbol /
                             table the plan mentions against the repo (facts go to every model).
  --lenses                   Assign review lenses (security, data, performance, testing, product,
                             operations, correctness) round-robin across model families.
  --no-cache                 Do not reuse cached council responses (.model-prism/cache).
  --resume                   Reuse this plan's persisted council responses (same content+prompt)
                             and go straight to the merge stage.
  --synthesize-only          Like --resume but never runs the council; errors if nothing persisted.
  --adaptive                 Stop launching paid members once the last 3 responses added no new
                             finding clusters (needs --structured).
  --tiered                   Run the cheap council first; escalate to the selected roster only
                             when it finds critical/high issues or the plan is high-risk.
  --debate                   Fusion: re-ask the models on each contested point to defend,
                             concede, or refine before the synthesizer runs.
  --help                     Show this help
`);
    process.exit(0);
  }

  const getNum = (flag: string, def: number): number => {
    const idx = argv.indexOf(flag);
    if (idx === -1 || idx + 1 >= argv.length) return def;
    const parsed = parseFloat(argv[idx + 1]);
    return Number.isFinite(parsed) ? parsed : def;
  };

  const getStr = (flag: string): string | null => {
    const idx = argv.indexOf(flag);
    if (idx === -1 || idx + 1 >= argv.length) return null;
    return argv[idx + 1];
  };

  const getStrArray = (flag: string): string[] => {
    const values: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === flag && i + 1 < argv.length) {
        values.push(argv[i + 1]);
      }
    }
    return values;
  };

  return {
    target: argv[0],
    batch: argv.includes("--batch"),
    force: argv.includes("--force"),
    dryRun: argv.includes("--dry-run"),
    // Raised for fusion-with-context (2026-06-17 unification): the dual-lens judge +
    // synthesizer on a context-rich plan runs ~$1–2 (vs legacy's ~$0.13), so the old
    // 1.00 per-plan cap tripped on context-heavy plans and degraded them to legacy
    // fallback for a cost reason, not a quality one. 6.00 keeps a real runaway backstop
    // (~4× a large real run) while clearing normal context-heavy fusion reviews.
    maxCost: getNum("--max-cost", 30.0),
    maxCostPerPlan: getNum("--max-cost-per-plan", 6.0),
    minSuccessfulModels: Math.floor(getNum("--min-successful-models", 6)),
    enhance: !argv.includes("--no-enhance"),
    reviewPromptPath: getStr("--review-prompt"),
    synthesisPromptPath: getStr("--synthesis-prompt"),
    outputPath: getStr("--output-path"),
    excludeModels: getStrArray("--exclude-model"),
    roster: getStr("--roster"),
    autoThresholdTokens: Math.floor(getNum("--auto-threshold-tokens", AUTO_THRESHOLD_TOKENS)),
    prismMode: getStr("--prism-mode") === "fusion" ? "fusion" : "legacy",
    // Sub-flags default ON in fusion (opt-out via --no-*); agentic defaults OFF.
    fusionTwoStage: !argv.includes("--no-two-stage"),
    fusionRiskGate: !argv.includes("--no-risk-gate"),
    fusionAgentic: argv.includes("--agentic"),
    structured: argv.includes("--structured") ? true : argv.includes("--no-structured") ? false : getStr("--prism-mode") === "fusion",
    groundTruth: !argv.includes("--no-ground-truth"),
    lenses: argv.includes("--lenses"),
    cache: !argv.includes("--no-cache"),
    resume: argv.includes("--resume") || argv.includes("--synthesize-only"),
    synthesizeOnly: argv.includes("--synthesize-only"),
    adaptive: argv.includes("--adaptive"),
    tiered: argv.includes("--tiered"),
    debate: argv.includes("--debate"),
  };
}

// Persisted/cached council responses come back as plain records; rehydrate them
// into the ModelResponse shape the rest of the pipeline expects.
function cachedToModelResponse(c: CachedResponse): ModelResponse {
  return {
    model: c.model, modelName: c.modelName, status: "complete", response: c.response,
    timeMs: c.timeMs, inputTokens: c.inputTokens, outputTokens: c.outputTokens, cost: 0,
    finishReason: c.finishReason ?? null, findings: c.findings as ModelResponse["findings"], fromCache: true, lens: c.lens,
  };
}

function toMemberFindings(responses: ModelResponse[], roster: ModelInfo[]): MemberFindings[] {
  return responses
    .filter((r) => r.status === "complete" && r.findings && r.findings.length > 0)
    .map((r) => ({
      model: r.model, modelName: r.modelName,
      family: roster.find((m) => m.id === r.model)?.family ?? "unknown",
      findings: r.findings!,
    }));
}

function clustersToRefs(clusters: FindingCluster[]): ReviewFindingRef[] {
  return clusters.map((c) => ({ id: c.id, claim: c.claim, severity: c.severity, category: c.category, location: c.location, models: c.models }));
}

// --- Prompt file loader ---

function loadPromptFile(promptPath: string, label: string): string {
  const resolved = path.resolve(promptPath);
  if (!fs.existsSync(resolved)) {
    console.error(`Error: ${label} file not found: ${resolved}`);
    process.exit(1);
  }
  const content = fs.readFileSync(resolved, "utf-8").trim();
  if (!content) {
    console.error(`Error: ${label} file is empty: ${resolved}`);
    process.exit(1);
  }
  return content;
}

// --- Find plans to review ---

function findPlans(target: string, batch: boolean): string[] {
  const absTarget = path.resolve(target);
  if (!fs.existsSync(absTarget)) {
    console.error(`Error: path does not exist: ${absTarget}`);
    process.exit(1);
  }

  const stat = fs.statSync(absTarget);

  if (stat.isFile()) {
    return [absTarget];
  }

  if (stat.isDirectory()) {
    if (!batch) {
      console.error(`Error: ${target} is a directory. Use --batch to process all plans.`);
      process.exit(1);
    }
    const plans: string[] = [];
    const entries = fs.readdirSync(absTarget);
    for (const entry of entries) {
      if (entry.endsWith(".md") && !entry.startsWith("README")) {
        plans.push(path.join(absTarget, entry));
      }
    }
    return plans.sort();
  }

  return [];
}

// --- Hash for cache invalidation ---

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// --- Review file path + existing check ---

function getReviewPath(planPath: string): string {
  const dir = path.dirname(planPath);
  const name = path.basename(planPath, ".md");
  return path.join(dir, "reviews", `${name}.review.md`);
}

interface ExistingReview {
  contentHash?: string;
  reviewedAt?: string;
}

function readExistingReviewMeta(reviewPath: string): ExistingReview | null {
  if (!fs.existsSync(reviewPath)) return null;
  try {
    const content = fs.readFileSync(reviewPath, "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;
    const fm = fmMatch[1];
    const hashMatch = fm.match(/content-hash:\s*(\S+)/);
    const dateMatch = fm.match(/reviewed-at:\s*(\S+)/);
    return {
      contentHash: hashMatch?.[1],
      reviewedAt: dateMatch?.[1],
    };
  } catch {
    return null;
  }
}

// --- Write review file ---

interface ReviewData {
  planPath: string;
  planContent: string;
  contentHash: string;
  contextRepo: string;
  contextBrief: string;
  synthesis: SynthesisResult;
  modelResponses: ModelResponse[];
  usedModels: ModelInfo[];
  totalInputTokens: number;
  totalOutputTokens: number;
  durationSec: number;
  outputPathOverride: string | null;
  customReviewMode: boolean;
  // Fusion/risk metadata (optional — only set under --prism-mode fusion).
  prismMode?: "legacy" | "fusion";
  prismFallback?: string | null;
  riskScore?: RiskScore | null;
  fusion?: FusionArtifacts | null;
  // Council upgrades (all optional so legacy output stays byte-stable)
  clusters?: FindingCluster[];
  totalFamilies?: number;
  comparison?: ReviewComparison | null;
  debate?: DebateResult | null;
  groundTruth?: GroundTruthReport | null;
  cachedCount?: number;
  skippedCount?: number;
  tiered?: { escalated: boolean; reason: string } | null;
  lensCoverage?: Record<string, number> | null;
  totalCost?: number;
}

function writeReviewFile(data: ReviewData): string {
  const reviewPath = data.outputPathOverride
    ? path.resolve(data.outputPathOverride)
    : getReviewPath(data.planPath);
  const reviewDir = path.dirname(reviewPath);
  if (!fs.existsSync(reviewDir)) {
    fs.mkdirSync(reviewDir, { recursive: true });
  }

  const planName = path.basename(data.planPath, ".md");
  const successfulModels = data.modelResponses.filter((r) => r.status === "complete");
  const failedModels = data.modelResponses.filter((r) => r.status === "error");
  // Look up model family from the roster that was actually used for THIS run
  // (not a hardcoded constant, since --roster can switch which 10 models ran).
  const rosterLookup = data.usedModels;

  // In custom-review mode (--review-prompt), use neutral frontmatter + title so the
  // output doesn't falsely assert it reviewed a "plan" when the input was e.g. a
  // findings log or audit doc.
  const sourceKey = data.customReviewMode ? "reviewed-doc" : "plan";
  const title = data.customReviewMode ? "Second-Pass Review" : "Plan Review";

  // Fusion/risk frontmatter — only emitted in fusion mode so legacy review files
  // are byte-for-byte unchanged (preserves the A/B baseline).
  const fusionLines: string[] = [];
  if (data.prismMode === "fusion") {
    fusionLines.push(`prism-mode: fusion`);
    if (data.prismFallback) fusionLines.push(`prism-fallback: ${data.prismFallback}`);
    if (data.riskScore) {
      fusionLines.push(`risk-score: ${data.riskScore.score}`);
      fusionLines.push(`risk-tier: ${data.riskScore.tier}`);
    }
    if (data.fusion) {
      fusionLines.push(`judge-json: ${data.fusion.judgeJsonRel}`);
      if (data.fusion.pinnedSha) fusionLines.push(`pinned-sha: ${data.fusion.pinnedSha}`);
      fusionLines.push(`evidence-kept: ${data.fusion.evidenceKept}`);
      fusionLines.push(`evidence-dropped: ${data.fusion.evidenceDropped}`);
      fusionLines.push(`citations-dropped: ${data.fusion.citationsDropped}`);
    }
  }
  // Council-upgrade frontmatter: only when structured mode ran, so legacy files are unchanged.
  if (data.clusters) {
    fusionLines.push(`structured: true`);
    fusionLines.push(`finding-clusters: ${data.clusters.length}`);
    if (data.groundTruth) fusionLines.push(`ground-truth: ${data.groundTruth.found} found / ${data.groundTruth.missing} missing / ${data.groundTruth.ambiguous} ambiguous`);
    if (data.cachedCount) fusionLines.push(`cached-responses: ${data.cachedCount}`);
    if (data.skippedCount) fusionLines.push(`skipped-saturated: ${data.skippedCount}`);
    if (data.tiered) fusionLines.push(`tiered: ${data.tiered.escalated ? "escalated" : "cheap-only"}`);
    if (data.debate) fusionLines.push(`debate-topics: ${data.debate.exchanges.length}`);
    if (data.comparison) fusionLines.push(`since-last-review: ${data.comparison.resolved.length} resolved / ${data.comparison.new.length} new / ${data.comparison.persisting.length} persisting`);
    if (typeof data.totalCost === "number") fusionLines.push(`cost-usd: ${data.totalCost.toFixed(4)}`);
  }
  const fusionBlock = fusionLines.length ? fusionLines.join("\n") + "\n" : "";

  const frontmatter = `---
${sourceKey}: ${path.basename(data.planPath)}
reviewed-at: ${new Date().toISOString()}
content-hash: ${data.contentHash}
context-repo: ${data.contextRepo}
models-succeeded: ${successfulModels.length}
models-failed: ${failedModels.length}
synthesis-model: ${OPENROUTER_SYNTHESIS_MODEL_ID}
total-input-tokens: ${data.totalInputTokens}
total-output-tokens: ${data.totalOutputTokens}
duration-sec: ${data.durationSec}
${fusionBlock}---

`;

  const lines: string[] = [frontmatter];
  lines.push(`# ${title}: ${planName}`);
  lines.push("");
  lines.push(`Reviewed by ${successfulModels.length} models across ${new Set(successfulModels.map((r) => {
    const info = rosterLookup.find((m) => m.id === r.model);
    return info?.family ?? "unknown";
  })).size} architectures, synthesized with ${OPENROUTER_SYNTHESIS_MODEL_ID} (via OpenRouter).`);
  lines.push("");

  // ── Dual-lens sections (renderer owns the headings — L9). Render ONLY when the
  // dual-lens judge produced output: the SynthesisResult fields are `undefined` on
  // legacy AND on fusion→legacy fallback, so those files stay byte-stable (L7). The
  // logic is a pure, unit-tested helper (fusion.renderDualLensSections).
  lines.push(...renderDualLensSections({
    strategicBlindSpots: data.synthesis.strategicBlindSpots,
    lockedDecisions: data.synthesis.lockedDecisions,
    criticalityHigh: readCriticality(data.planContent) === "high",
  }));

  // ⚖️ DECISION REQUIRED — lead with where the council SPLIT. A council's value isn't the
  // consensus (any one model gives you that) — it's the points strong models disagree on and
  // what they collectively overlooked. That's the surface a human actually has to adjudicate,
  // so it goes first, before the master synthesis.
  const disagreements = data.synthesis.disagreements ?? [];
  const blindSpots = data.synthesis.blindSpots ?? [];
  lines.push("## ⚖️ Decision Required — where the council split");
  lines.push("");
  if (disagreements.length === 0 && blindSpots.length === 0) {
    lines.push("_The council reached broad consensus — no contested points or blind spots flagged. Scan the synthesis below anyway._");
    lines.push("");
  } else {
    lines.push("_The highest-signal part of the review: points strong models contest, and what they collectively missed. These need **your** call._");
    lines.push("");
  }
  if (disagreements.length > 0) {
    lines.push("### Contested points");
    lines.push("");
    for (const d of disagreements) {
      lines.push(`#### ${d.topic}`);
      for (const p of d.positions) {
        lines.push(`- **${p.models.join(", ")}**: ${p.position}`);
      }
      lines.push("");
    }
  }
  if (blindSpots.length > 0) {
    lines.push("### Blind spots — what the council under-explored");
    lines.push("");
    for (const b of blindSpots) {
      lines.push(`- ${b}`);
    }
    lines.push("");
  }

  // Computed council findings (structured mode). Deterministic, family-weighted; the
  // line format is parsed back by review-compare on the next run.
  if (data.clusters && data.clusters.length > 0) {
    const total = data.totalFamilies ?? 1;
    lines.push("## 🧮 Council Findings — computed consensus");
    lines.push("");
    lines.push(`_${data.clusters.length} finding cluster(s) from ${total} model families, clustered deterministically by claim similarity. Support counts are facts, not the synthesizer's impression._`);
    lines.push("");
    const shown = data.clusters.slice(0, 40);
    for (const c of shown) {
      const kind = classifyCluster(c, total);
      const unverified = c.findings.some((f) => f.unverified) ? " ⚠ unverified" : "";
      lines.push(`- **[${c.severity}] [${c.category}]** ${c.claim}${c.location ? ` _(${c.location})_` : ""} \`${c.id}\` — ${kind}, ${c.families.length}/${total} families (${c.models.join(", ")})${unverified}`);
    }
    if (data.clusters.length > shown.length) lines.push(`- _…${data.clusters.length - shown.length} lower-support clusters in the findings JSON._`);
    lines.push("");
  }

  if (data.comparison) {
    const cmp = renderComparisonMarkdown(data.comparison);
    if (cmp) { lines.push(cmp); lines.push(""); }
  }

  lines.push(...renderDebateMarkdown(data.debate ?? null));

  // Master document
  if (data.synthesis.masterDocument) {
    lines.push("## Master Synthesis");
    lines.push("");
    lines.push(data.synthesis.masterDocument);
    lines.push("");
  }

  // Unique insights — the "gold" a single model surfaced that the rest missed.
  if (data.synthesis.uniqueInsights?.length > 0) {
    lines.push("## Unique Insights");
    lines.push("");
    lines.push("Valuable points raised by only 1-2 models:");
    lines.push("");
    for (const i of data.synthesis.uniqueInsights) {
      lines.push(`- **[${i.significance}]** _(${i.model})_ ${i.insight}`);
    }
    lines.push("");
  }

  // Consensus
  if (data.synthesis.consensus?.length > 0) {
    lines.push("## Consensus");
    lines.push("");
    lines.push("Points most model architectures agree on:");
    lines.push("");
    for (const c of data.synthesis.consensus) {
      lines.push(`- **[${c.strength}]** ${c.point}`);
      lines.push(`  _Supported by: ${c.supportingModels.join(", ")}_`);
    }
    lines.push("");
  }

  // Theme matrix
  if (data.synthesis.themeMatrix && data.synthesis.themeMatrix.length > 0) {
    lines.push("## Theme Coverage");
    lines.push("");
    lines.push("How thoroughly each model covered the major themes (0=not mentioned, 3=deeply analyzed):");
    lines.push("");
    for (const t of data.synthesis.themeMatrix) {
      lines.push(`### ${t.theme}`);
      for (const [model, score] of Object.entries(t.scores)) {
        // Clamp to [0,3]: the synthesis model occasionally returns an out-of-range
        // score (e.g. 7), which made "░".repeat(3 - score) throw RangeError and
        // crash the whole render AFTER the API spend. Defensive clamp, never crash.
        const s = Math.max(0, Math.min(3, Math.round(Number(score) || 0)));
        const bar = "█".repeat(s) + "░".repeat(3 - s);
        lines.push(`- ${model}: \`${bar}\` ${s}/3`);
      }
      lines.push("");
    }
  }

  // Failed models (saturation skips are listed separately: they are a feature, not a failure)
  const skipped = failedModels.filter((f) => f.errorCode === "skipped");
  const reallyFailed = failedModels.filter((f) => f.errorCode !== "skipped");
  if (reallyFailed.length > 0) {
    lines.push("## Failed Models");
    lines.push("");
    for (const f of reallyFailed) {
      lines.push(`- **${f.modelName}**: ${f.error}`);
    }
    lines.push("");
  }
  if (skipped.length > 0) {
    lines.push(`_Not launched (consensus saturated): ${skipped.map((f) => f.modelName).join(", ")}_`);
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(`_Generated by Model Prism on ${new Date().toISOString()}_`);

  fs.writeFileSync(reviewPath, lines.join("\n"));
  return reviewPath;
}

// --- Fusion merge (judge → synthesizer) ------------------------------------
// Orchestrates the fusion path: pin SHA → judge → SHA-verify evidence → persist
// content-addressed judge JSON → synthesize from judge → drop unresolved citations
// → tighten. Throws (JudgeError or Error) on failure; the caller soft-falls-back.

interface FusionArtifacts {
  synthesis: SynthesisResult;
  judgeJsonRel: string;
  pinnedSha: string | null;
  evidenceKept: number;
  evidenceDropped: number;
  citationsDropped: number;
  phases: PhaseUsage[];           // per-phase usage for Component E telemetry
  debate: DebateResult | null;
}

// Persist the (SHA-verified) judge JSON to a content-addressed path so re-runs and
// A/B modes never collide (B9). Atomic (tmp + rename); also refreshes a
// latest-<mode>.judge.json pointer. The worker lock (Python hook) serializes plans.
function persistJudgeJson(
  planPath: string,
  judge: JudgeResult,
  meta: { pinnedSha: string | null; draftHash: string; dropped: unknown },
): string {
  const planDir = path.dirname(planPath);
  const slug = path.basename(planPath, ".md");
  const outDir = path.join(planDir, "reviews", slug);
  fs.mkdirSync(outDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const payload = JSON.stringify(
    { schemaVersion: "1", generatedAt: new Date().toISOString(), mode: "fusion", ...meta, judge },
    null, 2,
  );

  const writeAtomic = (dest: string) => {
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, dest);
  };

  const fileName = `${ts}-${meta.draftHash}-fusion.judge.json`;
  const fullPath = path.join(outDir, fileName);
  writeAtomic(fullPath);
  writeAtomic(path.join(outDir, "latest-fusion.judge.json"));

  return path.relative(planDir, fullPath).replace(/\\/g, "/");
}

async function runFusionMerge(opts: {
  openrouterKey: string;
  planPath: string;
  planContent: string;
  reviewPrompt: string;
  context: string;
  synthesisResponses: Array<{ model: string; modelName: string; family: string; response: string }>;
  repoRoot: string;
  synthesisPromptOverride: string | null;
  extras?: JudgeExtras;
  debate?: boolean;
}): Promise<FusionArtifacts> {
  // (B2/B3) Pin the SHA at judge-invocation time — citations resolve against THIS
  // commit, not the dirty working tree (line numbers drift while a plan is edited).
  const pinnedSha = pinHeadSha(opts.repoRoot);

  // (D1/T1) Extract founder Locked Decisions DETERMINISTICALLY before the judge call,
  // and run the zero-token pre-flight linter so a near-miss heading/frontmatter is
  // caught before any council spend. The judge only acknowledges these; the parser
  // owns the values written back onto the JudgeResult.
  const lockedDecisions = extractLockedDecisions(opts.planContent);
  const lint = lintLockedDecisions(opts.planContent);
  for (const w of lint.warnings) console.warn(`  [locked-decisions] ${w}`);
  if (lockedDecisions.length > 0) {
    console.log(`  [fusion] extracted ${lockedDecisions.length} locked decision(s) (parser, zero-token)`);
  }

  const phases: PhaseUsage[] = [];
  const onUsage = (u: PhaseUsage) => phases.push(u);

  const judge = await judgeViaOpenRouter({
    openrouterKey: opts.openrouterKey,
    draft: opts.planContent,
    responses: opts.synthesisResponses,
    reviewPrompt: opts.reviewPrompt,
    context: opts.context,
    lockedDecisions,
    extras: opts.extras,
    onUsage,
  });

  // Accuracy-aware integrity: drop repo citations that don't resolve/aren't supported
  // against the pinned SHA. model:/draft citations are transcript-authored, kept.
  const verification = verifyJudgeEvidence(judge, opts.repoRoot, pinnedSha);
  let filteredJudge: JudgeResult = { ...judge, evidence: verification.kept };
  if (verification.dropped.length > 0) {
    console.log(`  [fusion] dropped ${verification.dropped.length} unverifiable citation(s): ${verification.dropped.map((d) => d.reason).join(",")}`);
  }

  // Cross-examination: each side of a contested point defends, concedes, or refines
  // with evidence. Resolved topics move into consensus before the synthesizer runs.
  let debate: DebateResult | null = null;
  if (opts.debate && filteredJudge.contradictions.length > 0) {
    console.log(`  [debate] re-examining ${Math.min(filteredJudge.contradictions.length, 6)} contested point(s)...`);
    debate = await runDebateRound({
      openrouterKey: opts.openrouterKey,
      judge: filteredJudge,
      draft: opts.planContent,
      facts: opts.extras?.facts,
      resolveModel: (m) => m.replace(/^agentic:/, ""),
      onReply: (topic, model, reply, error) => console.log(`    ${reply ? `${reply.verdict.padEnd(7)}` : "✗      "} ${model} — ${topic.slice(0, 60)}${error ? ` [${error.slice(0, 60)}]` : ""}`),
    });
    phases.push({ phase: "critic", model: "debate", inputTokens: 0, outputTokens: 0, cost: debate.cost, attempts: 1 });
    filteredJudge = applyDebateToJudge(filteredJudge, debate);
    console.log(`  [debate] ${debate.exchanges.filter((e) => e.resolved).length}/${debate.exchanges.length} resolved ($${debate.cost.toFixed(3)})`);
  }

  const judgeJsonRel = persistJudgeJson(opts.planPath, filteredJudge, {
    pinnedSha, draftHash: hashContent(opts.planContent), dropped: verification.dropped,
  });

  const synthesis = await synthesizeFromJudge({
    openrouterKey: opts.openrouterKey,
    judge: filteredJudge,
    draft: opts.planContent,
    customInstructions: opts.synthesisPromptOverride,
    onUsage,
  });

  // Drop synthesizer citations that don't map to a surviving evidence id, then
  // mechanically tighten (Phase 2). Unresolved citations are dropped, not laundered.
  const validIds = new Set(filteredJudge.evidence.map((e) => e.id));
  const { text, dropped: citationsDropped } = dropUnresolvedCitations(synthesis.masterDocument ?? "", validIds);
  synthesis.masterDocument = tightenProse(text);

  return {
    synthesis,
    judgeJsonRel,
    pinnedSha,
    evidenceKept: verification.kept.length,
    evidenceDropped: verification.dropped.length,
    citationsDropped: citationsDropped.length,
    phases,
    debate,
  };
}

// --- Process a single plan ---

async function reviewPlan(
  planPath: string,
  context: LocalContext,
  args: Args,
  openrouterKey: string,
  reviewPromptOverride: string | null,
  synthesisPromptOverride: string | null,
  activeCouncilModels: ModelInfo[],
  resolvedRosterName: string
): Promise<{ skipped: boolean; skipReason?: "already-reviewed" | "dry-run"; reviewPath?: string; error?: string; cost?: number }> {
  const planContent = fs.readFileSync(planPath, "utf-8");
  const contentHash = hashContent(planContent);
  // In --output-path mode the cache-hash check reads the explicit output;
  // otherwise it reads the conventional <dir>/reviews/<name>.review.md.
  const reviewPath = args.outputPath
    ? path.resolve(args.outputPath)
    : getReviewPath(planPath);

  // Check existing
  if (!args.force) {
    const existing = readExistingReviewMeta(reviewPath);
    if (existing?.contentHash === contentHash) {
      return { skipped: true, skipReason: "already-reviewed", reviewPath };
    }
  }

  if (args.dryRun) {
    return { skipped: true, skipReason: "dry-run" };
  }

  // Layer 1a: Pre-fetch files explicitly referenced by path in the plan
  const referencedPaths = detectPlanReferencedFiles(planContent, context.repoRoot);
  const referencedFiles = loadReferencedFiles(context.repoRoot, referencedPaths);
  const referencedCount = Object.keys(referencedFiles).length;
  if (referencedCount > 0) {
    console.log(`  Pre-fetched ${referencedCount} plan-referenced file(s) (explicit paths)`);
  }

  // Layer 1b: Semantic grep — find files defining functions/types/tables mentioned in the plan
  const existingPaths = new Set([...Object.keys(context.keyFiles), ...referencedPaths]);
  const semanticPaths = detectSemanticReferences(planContent, context.repoRoot, existingPaths);
  const semanticFiles = loadReferencedFiles(context.repoRoot, semanticPaths);
  const semanticCount = Object.keys(semanticFiles).length;
  if (semanticCount > 0) {
    console.log(`  Semantic grep found ${semanticCount} additional file(s) defining plan-mentioned identifiers`);
  }

  // Merge all pre-fetched files
  const allPreFetched = { ...referencedFiles, ...semanticFiles };
  const totalPreFetched = Object.keys(allPreFetched).length;

  // B5 sequence step (1): emit the STRUCTURED risk score BEFORE the council launches,
  // so the Phase-4 agentic gate (step 3) can read it. Re: council invocation this is
  // shadow/log-only; re: agentic-member selection it is LIVE. Legacy mode skips it.
  let riskScore: RiskScore | null = null;
  if (args.prismMode === "fusion" && args.fusionRiskGate) {
    riskScore = computeRiskScore(planContent, totalPreFetched);
    console.log(`  [risk] ${summarizeRisk(riskScore)}  (shadow re: council; live re: agentic gate)`);
  }

  // Build the council context: base brief + pre-fetched files with explicit instruction
  const baseContext = buildLocalContextString(context);
  const referencedSection = totalPreFetched > 0
    ? `\n\nPLAN-REFERENCED FILES (verified to exist on disk — use these as ground truth, not assumptions):\n\n` +
      Object.entries(allPreFetched)
        .map(([p, c]) => `### ${p}\n\`\`\`${p.split(".").pop() || ""}\n${c}\n\`\`\``)
        .join("\n\n")
    : "";

  const contextString = baseContext + referencedSection;
  // Use custom review prompt if provided, otherwise built-in plan-review prompt.
  const effectiveReviewPrompt = reviewPromptOverride ?? REVIEW_PROMPT;

  const startTime = Date.now();

  // ── Ground truth (zero LLM cost): verify every path/symbol/table the plan names ──
  let groundTruth: GroundTruthReport | null = null;
  let factsBlock = "";
  if (args.groundTruth) {
    groundTruth = checkGroundTruth(planContent, context.repoRoot, { planPath: path.relative(context.repoRoot, planPath).replace(/\\/g, "/") });
    factsBlock = renderFactsBlock(groundTruth);
    if (groundTruth.refs.length > 0) {
      console.log(`  [ground-truth] ${groundTruth.found} found / ${groundTruth.missing} missing / ${groundTruth.ambiguous} ambiguous (${groundTruth.durationMs}ms)`);
      for (const r of groundTruth.refs.filter((x) => x.status === "missing").slice(0, 8)) console.log(`    ✗ ${r.kind} ${r.name} — not in repo`);
    }
  }
  // Facts precede the context for every council member, the judge, and the synthesizer.
  const councilContext = factsBlock ? `${factsBlock}\n\n${contextString}` : contextString;

  // ── Council: persisted (resume) → cache → structured / lenses / adaptive / tiered ──
  const planSlug = path.basename(planPath, ".md");
  const persistedPath = runResponsesPath(path.dirname(reviewPath), planSlug, contentHash);
  const promptHash = hashContent(effectiveReviewPrompt);
  const structured = args.structured;
  const cache = args.cache ? fileResponseCache() : undefined;
  const tracker = new SaturationTracker();
  let responses: ModelResponse[];
  let tieredInfo: { escalated: boolean; reason: string } | null = null;
  let lensCov: Record<string, number> | null = null;

  const runCouncilStage = async (models: ModelInfo[], label: string): Promise<ModelResponse[]> => {
    const freeCount = models.filter((m) => m.tier === "free").length;
    const paidCount = models.length - freeCount;
    const lensMap = args.lenses ? assignLenses(models) : null;
    if (lensMap) {
      lensCov = { ...(lensCov ?? {}), ...lensCoverage(lensMap) };
      console.log(`  [lenses] ${[...new Set([...lensMap.values()].map((l) => l.name))].join(", ")}`);
    }
    console.log(`  Fanning out to ${models.length} ${label} models (${freeCount} free + ${paidCount} paid)${structured ? ", structured findings" : ""}${cache ? ", cache on" : ""}...`);
    let completedCount = 0;
    return fanOut({
      models,
      content: planContent,
      prompt: effectiveReviewPrompt,
      promptFor: lensMap ? (m) => { const l = lensMap.get(m.id); return l ? lensPrompt(effectiveReviewPrompt, l) : effectiveReviewPrompt; } : undefined,
      apiKey: openrouterKey,
      runId: null,
      maxTokens: structured ? 6000 : 4096,
      isAborted: () => false,
      context: councilContext,
      structured,
      cache,
      // Adaptive sizing: once the last responses added no new clusters, stop launching
      // paid members (free ones still run — they cost nothing but time).
      shouldLaunch: args.adaptive && structured
        ? (m) => m.tier === "free" || !tracker.isSaturated()
        : undefined,
      // Waves of 2 so saturation is observable before the whole paid tier is committed.
      paidConcurrency: args.adaptive && structured ? 2 : undefined,
      onUpdate: (modelId, resp) => {
        if (resp.status === "complete" || resp.status === "error") {
          completedCount++;
          const info = models.find((m) => m.id === modelId);
          if (resp.status === "complete") {
            if (lensMap) resp.lens = lensMap.get(modelId)?.id;
            if (resp.findings?.length) {
              if (groundTruth) resp.findings = markUnverifiedFindings(resp.findings, groundTruth);
              const added = tracker.add({ model: modelId, modelName: resp.modelName, family: info?.family ?? "unknown", findings: resp.findings });
              process.stdout.write(`    ✓ ${info?.name ?? modelId} (${completedCount}/${models.length}) ${resp.findings.length} findings, +${added} new cluster(s)${resp.fromCache ? " [cache]" : ""}\n`);
              return;
            }
          }
          const symbol = resp.status === "complete" ? "✓" : resp.errorCode === "skipped" ? "⊘" : "✗";
          const suffix = resp.status === "error" && resp.error
            ? `  [${resp.error.slice(0, 80)}]`
            : resp.finishReason === "length"
              ? "  [warning: review cut off by max_tokens]"
              : resp.fromCache ? "  [cache]" : "";
          process.stdout.write(`    ${symbol} ${info?.name ?? modelId} (${completedCount}/${models.length})${suffix}\n`);
        }
      },
    });
  };

  const persisted = args.resume ? loadRunResponses(persistedPath) : null;
  if (persisted && persisted.promptHash === promptHash && persisted.responses.length > 0) {
    responses = persisted.responses.map(cachedToModelResponse);
    for (const r of responses) if (r.findings?.length) tracker.add({ model: r.model, modelName: r.modelName, family: activeCouncilModels.find((m) => m.id === r.model)?.family ?? "unknown", findings: r.findings });
    console.log(`  Reusing ${responses.length} persisted council response(s) from ${path.relative(process.cwd(), persistedPath)} (saved ${persisted.savedAt})`);
  } else if (args.synthesizeOnly) {
    return { skipped: false, error: `--synthesize-only: no persisted council responses for this plan+prompt at ${path.relative(process.cwd(), persistedPath)}`, cost: 0 };
  } else if (args.tiered) {
    // Cheap council first; escalate to the selected roster only when the cheap tier
    // found something serious (or the plan is high-risk). Most plans stop at tier one.
    const excluded = new Set(args.excludeModels);
    const cheapModels = ROSTERS.cheap.filter((m) => !excluded.has(m.id));
    const stage1 = await runCouncilStage(cheapModels, "cheap-tier");
    const stage1Clusters = clusterFindings(toMemberFindings(stage1, cheapModels));
    const serious = stage1Clusters.filter((c) => (c.severity === "critical" || c.severity === "high") && c.families.length >= 2);
    const escalate = serious.length > 0 || riskScore?.tier === "high";
    const reason = serious.length > 0 ? `${serious.length} critical/high cluster(s) with ≥2 families` : riskScore?.tier === "high" ? "high-risk plan" : "no critical/high consensus";
    tieredInfo = { escalated: escalate, reason };
    if (escalate) {
      const cheapIds = new Set(cheapModels.map((m) => m.id));
      const escalation = activeCouncilModels.filter((m) => !cheapIds.has(m.id));
      console.log(`  [tiered] escalating to ${escalation.length} frontier model(s): ${reason}`);
      const stage2 = escalation.length ? await runCouncilStage(escalation, "escalation") : [];
      responses = [...stage1, ...stage2];
    } else {
      console.log(`  [tiered] staying on the cheap tier: ${reason}`);
      responses = stage1;
    }
  } else {
    responses = await runCouncilStage(activeCouncilModels, "council");
  }

  // Persist the paid council so a failed merge, quorum miss, or cap trip never
  // throws it away (--resume / --synthesize-only rebuild from this file).
  const completeResponses = responses.filter((r) => r.status === "complete" && r.response);
  if (!persisted && completeResponses.length > 0) {
    try {
      saveRunResponses(persistedPath, {
        version: 1, plan: path.basename(planPath), contentHash, promptHash, roster: resolvedRosterName, savedAt: new Date().toISOString(),
        responses: completeResponses.map((r) => ({
          model: r.model, modelName: r.modelName, family: activeCouncilModels.find((m) => m.id === r.model)?.family,
          response: r.response!, findings: r.findings, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cost: r.cost,
          timeMs: r.timeMs, finishReason: r.finishReason ?? null, lens: r.lens, cachedAt: new Date().toISOString(),
        })),
      });
    } catch (e) {
      console.error(`  (could not persist council responses: ${e instanceof Error ? e.message : e})`);
    }
  }

  // Computed consensus + similarity (deterministic, zero cost).
  const rosterForFamilies = [...activeCouncilModels, ...ROSTERS.cheap];
  const memberFindings = toMemberFindings(responses, rosterForFamilies);
  const clusters = structured ? clusterFindings(memberFindings) : null;
  const totalFamilies = new Set(completeResponses.map((r) => rosterForFamilies.find((m) => m.id === r.model)?.family ?? "unknown")).size;
  const computedConsensus = clusters && clusters.length ? consensusBlock(clusters, totalFamilies) : "";
  if (clusters) {
    const kinds = { consensus: 0, contested: 0, unique: 0 };
    for (const c of clusters) kinds[classifyCluster(c, totalFamilies)]++;
    console.log(`  [findings] ${clusters.length} cluster(s) from ${memberFindings.length} members / ${totalFamilies} families: ${kinds.consensus} consensus, ${kinds.contested} contested, ${kinds.unique} unique`);
  }
  const similarity = completeResponses.length >= 2
    ? summarizeSimilarity(completeResponses.map((r) => ({ model: r.model, text: r.response! })))
    : null;
  if (similarity) {
    console.log(`  [similarity] mean ${similarity.meanSimilarity.toFixed(2)}${similarity.redundant.length ? `; redundant: ${similarity.redundant.map((p) => `${p.a}~${p.b} (${p.score.toFixed(2)})`).join(", ")}` : ""}${similarity.mostDistinct ? `; most distinct: ${similarity.mostDistinct}` : ""}`);
  }
  const cachedCount = responses.filter((r) => r.fromCache).length;
  const skippedCount = responses.filter((r) => r.errorCode === "skipped").length;
  const judgeExtras: JudgeExtras = { computedConsensus: computedConsensus || undefined, facts: factsBlock || undefined };
  // Legacy merge has no `extras` channel: the facts + consensus ride along in its context.
  const mergeContext = [factsBlock, computedConsensus, contextString].filter(Boolean).join("\n\n");

  const fatal = responses.find((r) => r.errorCode === "auth" || r.errorCode === "payment");
  if (fatal && !responses.some((r) => r.status === "complete")) {
    return { skipped: false, error: `OpenRouter rejected the council calls (${fatal.errorCode}): ${fatal.error}`, cost: 0 };
  }

  const successful = responses.filter((r) => r.status === "complete" && r.response);
  if (successful.length < args.minSuccessfulModels) {
    return {
      skipped: false,
      error: `Only ${successful.length}/${activeCouncilModels.length} models succeeded — need ≥${args.minSuccessfulModels} for reliable synthesis (configure via --min-successful-models)`,
      cost: responses.reduce((sum, r) => sum + (r.cost ?? 0), 0),
    };
  }

  // Circuit breaker: what the merge stage is about to cost, plus what the council
  // already cost. The old estimate priced the synthesizer at Opus 4.6 rates
  // ($15/$75 per M) while the model is Opus 4.8 ($5/$25 per M) — a 3× over-estimate
  // that tripped the 1.00 cap on ordinary plans and forced the cap up to 6.00.
  const councilCost = responses.reduce((sum, r) => sum + (r.cost ?? 0), 0);
  const totalResponseChars = successful.reduce((sum, r) => sum + (r.response?.length ?? 0), 0);
  const estimatedMergeInputTokens = Math.ceil((totalResponseChars + planContent.length + (contextString?.length ?? 0)) / 4);
  const mergeCalls = args.prismMode === "fusion" && args.fusionTwoStage ? 2 : 1; // judge + synthesizer
  const estimatedMergeCost = mergeCalls * (
    (estimatedMergeInputTokens / 1_000_000) * SYNTHESIS_PRICE_PER_M.input +
    (ESTIMATED_MERGE_OUTPUT_TOKENS / 1_000_000) * SYNTHESIS_PRICE_PER_M.output
  );
  const projectedPlanCost = councilCost + estimatedMergeCost;
  console.log(`  Council spend so far: $${councilCost.toFixed(3)}; projected merge (${mergeCalls} call${mergeCalls > 1 ? "s" : ""}): ~$${estimatedMergeCost.toFixed(3)}`);

  if (projectedPlanCost > args.maxCostPerPlan) {
    return {
      skipped: false,
      error: `Projected plan cost ($${projectedPlanCost.toFixed(3)} = council $${councilCost.toFixed(3)} + merge ~$${estimatedMergeCost.toFixed(3)}) exceeds per-plan cap ($${args.maxCostPerPlan.toFixed(2)}). Raise --max-cost-per-plan or reduce plan/context size.`,
      cost: councilCost,
    };
  }

  const synthesisResponses = successful.map((r) => {
    const info = activeCouncilModels.find((m) => m.id === r.model);
    return {
      model: r.model,
      modelName: r.modelName,
      family: info?.family ?? "unknown",
      response: r.response!,
    };
  });

  // ── Phase 4: agentic members (gated) ────────────────────────────────────────
  // On HIGH-risk plans only, when --agentic is set, give 1–2 members repo-grep so a
  // reviewer can verify ground-truth claims. Their findings join the council BEFORE
  // the judge. Each is hard-capped (B12); a member that abstains/fails is dropped.
  if (args.prismMode === "fusion" && args.fusionTwoStage && shouldRunAgentic(riskScore, args.fusionAgentic)) {
    const agenticModels = activeCouncilModels.filter((m) => m.tier !== "free").slice(0, 2);
    console.log(`  [agentic] HIGH risk + --agentic → running ${agenticModels.length} repo-aware member(s)`);
    for (const m of agenticModels) {
      try {
        const finding = await runAgenticMember({
          openrouterKey, modelId: m.id, planContent, repoRoot: context.repoRoot,
        });
        if (finding) {
          synthesisResponses.push({ model: `agentic:${m.id}`, modelName: `${m.name} (repo-aware)`, family: "agentic", response: finding });
          console.log(`    ✓ ${m.name} (repo-aware) contributed a ground-truth review`);
        } else {
          console.log(`    ⊘ ${m.name} (repo-aware) abstained`);
        }
      } catch (e) {
        console.log(`    ✗ ${m.name} (repo-aware) failed: ${(e as Error).message.slice(0, 80)}`);
      }
    }
  }

  // ── Merge stage: legacy single-Opus OR fusion judge→synthesizer ─────────────
  // Fusion runs ONLY under --prism-mode fusion with two-stage enabled. ANY fusion
  // failure soft-falls-back to the legacy merge (tagged prism-fallback so it's
  // visible) — it never blocks the plan from landing (Rollback: degraded-mode).
  let synthesis: SynthesisResult;
  let prismFallback: string | null = null;
  let fusionInfo: FusionArtifacts | null = null;
  const useFusion = args.prismMode === "fusion" && args.fusionTwoStage;

  if (useFusion) {
    try {
      fusionInfo = await runFusionMerge({
        openrouterKey,
        planPath,
        planContent,
        reviewPrompt: effectiveReviewPrompt,
        context: contextString,
        synthesisResponses,
        repoRoot: context.repoRoot,
        synthesisPromptOverride,
        extras: judgeExtras,
        debate: args.debate,
      });
      synthesis = fusionInfo.synthesis;
      console.log(`  [fusion] judge JSON → ${fusionInfo.judgeJsonRel} (evidence kept=${fusionInfo.evidenceKept} dropped=${fusionInfo.evidenceDropped}; citations dropped=${fusionInfo.citationsDropped}; sha=${fusionInfo.pinnedSha?.slice(0, 8) ?? "none"})`);
    } catch (e) {
      const detail = e instanceof JudgeError ? `${e.kind}: ${e.message}` : (e as Error).message;
      // SOFT FALLBACK (context-gate T2 posture): run the legacy merge, tag it
      // visibly so chronic fusion breakage isn't silent, never block the plan.
      prismFallback = "legacy";
      console.error(`  [fusion] ALERT judge/synthesizer failed (${detail}) — falling back to legacy single-Opus merge (prism-fallback: legacy)`);
      synthesis = await synthesizeViaOpenRouter({
        openrouterKey, content: planContent, analysisPrompt: effectiveReviewPrompt,
        responses: synthesisResponses, context: mergeContext, customSynthesisInstructions: synthesisPromptOverride,
      });
    }
  } else {
    console.log(`  Synthesizing with ${OPENROUTER_SYNTHESIS_MODEL_ID} (via OpenRouter)... (estimated cost: ~$${estimatedMergeCost.toFixed(3)})`);
    synthesis = await synthesizeViaOpenRouter({
      openrouterKey, content: planContent, analysisPrompt: effectiveReviewPrompt,
      responses: synthesisResponses, context: mergeContext, customSynthesisInstructions: synthesisPromptOverride,
    });
  }

  const durationSec = Math.round((Date.now() - startTime) / 1000);
  const mergeCost = fusionInfo?.phases.reduce((sum, p) => sum + (p.cost ?? 0), 0) ?? estimatedMergeCost;
  const totalPlanCost = councilCost + mergeCost;
  console.log(`  Plan cost: $${totalPlanCost.toFixed(3)} (council $${councilCost.toFixed(3)} + merge ${fusionInfo ? "$" : "~$"}${mergeCost.toFixed(3)})`);
  const totalInputTokens = responses.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0);
  const totalOutputTokens = responses.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0);

  // "Since last review": the existing review file (if any) is parsed BEFORE it is overwritten.
  let comparison: ReviewComparison | null = null;
  if (clusters && fs.existsSync(reviewPath)) {
    try {
      // Only the computed-findings section carries cluster ids; the synthesizer's own
      // consensus/insight bullets would otherwise show up as spuriously "resolved".
      const prevText = fs.readFileSync(reviewPath, "utf-8");
      const sectionStart = prevText.indexOf("## 🧮 Council Findings");
      const sectionEnd = sectionStart === -1 ? -1 : prevText.indexOf("\n## ", sectionStart + 1);
      const prevSection = sectionStart === -1 ? "" : prevText.slice(sectionStart, sectionEnd === -1 ? undefined : sectionEnd);
      const prevRefs = parseFindingRefsFromReview(prevSection);
      if (prevRefs.length > 0) {
        comparison = compareReviews(prevRefs, clustersToRefs(clusters));
        console.log(`  [compare] ${comparison.resolved.length} resolved, ${comparison.new.length} new, ${comparison.persisting.length} persisting since last review`);
      }
    } catch (e) {
      console.error(`  (could not compare with previous review: ${e instanceof Error ? e.message : e})`);
    }
  }

  const outputPath = writeReviewFile({
    planPath,
    planContent,
    contentHash,
    contextRepo: context.repoName,
    contextBrief: context.brief,
    synthesis,
    modelResponses: responses,
    usedModels: activeCouncilModels,
    totalInputTokens,
    totalOutputTokens,
    durationSec,
    outputPathOverride: args.outputPath,
    customReviewMode: reviewPromptOverride !== null,
    prismMode: args.prismMode,
    prismFallback,
    riskScore,
    fusion: fusionInfo,
    clusters: clusters ?? undefined,
    totalFamilies,
    comparison,
    debate: fusionInfo?.debate ?? null,
    groundTruth,
    cachedCount,
    skippedCount,
    tiered: tieredInfo,
    lensCoverage: lensCov,
    totalCost: totalPlanCost,
  });

  // Findings export (structured mode): what post-pr-review and other tools consume.
  if (clusters) {
    const findingsPath = outputPath.replace(/\.md$/, "") + ".findings.json";
    try {
      fs.writeFileSync(findingsPath, JSON.stringify({
        plan: path.basename(planPath), contentHash, reviewedAt: new Date().toISOString(), totalFamilies,
        clusters: clusters.map((c) => ({
          id: c.id, claim: c.claim, severity: c.severity, category: c.category, location: c.location,
          families: c.families, models: c.models,
          recommendation: c.findings.find((f) => f.recommendation)?.recommendation,
          evidence: c.findings.find((f) => f.evidence)?.evidence,
          unverified: c.findings.some((f) => f.unverified) || undefined,
        })),
        members: memberFindings.map((m) => ({ model: m.model, family: m.family, findings: m.findings })),
        groundTruth: groundTruth ? { found: groundTruth.found, missing: groundTruth.missing, ambiguous: groundTruth.ambiguous, missingRefs: groundTruth.refs.filter((r) => r.status === "missing").map((r) => `${r.kind}:${r.name}`) } : null,
        comparison: comparison ? { resolved: comparison.resolved.map((r) => r.id), new: comparison.new.map((r) => r.id), persisting: comparison.persisting.map((p) => p.current.id) } : null,
        similarity: similarity ? { meanSimilarity: similarity.meanSimilarity, redundant: similarity.redundant } : null,
      }, null, 2));
      console.log(`  Findings JSON → ${path.relative(process.cwd(), findingsPath)}`);
    } catch (e) {
      console.error(`  (could not write findings JSON: ${e instanceof Error ? e.message : e})`);
    }
  }

  // Fusion run telemetry (Component E) — fallback-rate + cost-by-roster as a
  // CI-enforceable query (Phase-5 gates). Best-effort: never fail a completed review.
  if (useFusion) {
    try {
      appendFusionTelemetry(buildFusionTelemetry({
        ts: new Date().toISOString(),
        plan: path.basename(planPath),
        contextRepo: context.repoName,
        roster: resolvedRosterName,
        fellBackToLegacy: prismFallback === "legacy",
        phases: fusionInfo?.phases ?? [],
        evidenceKept: fusionInfo?.evidenceKept ?? 0,
        evidenceDropped: fusionInfo?.evidenceDropped ?? 0,
        citationsDropped: fusionInfo?.citationsDropped ?? 0,
        lockedDecisions: synthesis.lockedDecisions ?? [],
        strategicBlindSpots: synthesis.strategicBlindSpots ?? [],
      }));
    } catch (e) {
      console.error(`  (fusion telemetry not recorded: ${e instanceof Error ? e.message : e})`);
    }
  }

  // Record per-model telemetry for the `model-value` report. Best-effort: a telemetry
  // write must never fail a completed review.
  try {
    appendRunTelemetry(buildRunTelemetry({
      ts: new Date().toISOString(),
      plan: path.basename(planPath),
      contentHash,
      contextRepo: context.repoName,
      roster: resolvedRosterName,
      synthesisModel: OPENROUTER_SYNTHESIS_MODEL_ID,
      durationSec,
      synthesis,
      responses,
      usedModels: activeCouncilModels,
      similarity: similarity ? { pairs: similarity.pairs, meanSimilarity: similarity.meanSimilarity } : undefined,
    }));
  } catch (e) {
    console.error(`  (telemetry not recorded: ${e instanceof Error ? e.message : e})`);
  }

  // Capture review FINDINGS for the `review-digest` report, and (opt-in, wherever a Brain
  // vault resolves) mirror a wikilinked digest into the vault for cross-review analysis.
  // Best-effort: must never fail a completed review.
  try {
    const record = buildReviewRecord({
      ts: new Date().toISOString(),
      plan: path.basename(planPath),
      contextRepo: context.repoName,
      roster: resolvedRosterName,
      synthesisModel: OPENROUTER_SYNTHESIS_MODEL_ID,
      durationSec,
      synthesis,
      responses,
    });
    appendReviewRecord(record);
    const brainPath = writeBrainDigest(record);
    if (brainPath) console.log(`  Review digest → Brain: ${brainPath}`);
  } catch (e) {
    console.error(`  (review findings not recorded: ${e instanceof Error ? e.message : e})`);
  }

  return { skipped: false, reviewPath: outputPath, cost: totalPlanCost };
}

// Resolve a roster preset name + exclusions into the active council, or an error string.
// `strictExclude` is true for an explicit --roster (a typo'd --exclude-model is an error);
// false under --roster auto, where the same exclude flag is applied across cheap/default,
// which legitimately have different members — so a non-matching exclude is just a no-op.
function buildCouncil(
  rosterName: string,
  excludeSet: Set<string>,
  minSuccessful: number,
  strictExclude: boolean
): { models: ModelInfo[]; error?: string } {
  const roster = ROSTERS[rosterName];
  if (!roster) {
    return { models: [], error: `--roster value '${rosterName}' is not valid. Choose from: ${Object.keys(ROSTERS).join(", ")}, auto` };
  }
  const models = roster.filter((m) => !excludeSet.has(m.id));
  if (strictExclude && excludeSet.size > 0) {
    const missing = [...excludeSet].filter((id) => !roster.some((m) => m.id === id));
    if (missing.length > 0) {
      return { models, error: `--exclude-model value(s) not in '${rosterName}' roster: ${missing.join(", ")}\nValid IDs: ${roster.map((m) => m.id).join(", ")}` };
    }
  }
  if (models.length < minSuccessful) {
    return { models, error: `only ${models.length} models remain after --exclude-model, but --min-successful-models=${minSuccessful}. Raise the flag or exclude fewer models.` };
  }
  return { models };
}

// --- Main ---

async function main(): Promise<number> {
  const args = parseArgs();

  // B14 compatibility matrix: agentic evidence flows through the judge JSON that only
  // exists in two-stage mode, so --agentic --no-two-stage is invalid.
  if (args.fusionAgentic && !args.fusionTwoStage) {
    console.error("Error: --agentic requires the judge→synthesizer split (do not pass --no-two-stage with --agentic).");
    process.exit(1);
  }
  if (args.prismMode === "fusion") {
    console.log(`Prism mode: fusion (two-stage=${args.fusionTwoStage}, risk-gate=${args.fusionRiskGate}, agentic=${args.fusionAgentic})`);
  }

  const openrouterKey = process.env.OPENROUTER_API_KEY || "";

  if (!args.dryRun) {
    if (!openrouterKey) {
      console.error("Error: OPENROUTER_API_KEY environment variable is required");
      process.exit(1);
    }
    // The ENTIRE pipeline — council fan-out, brief enhancement, AND synthesis —
    // now bills to OPENROUTER_API_KEY. The Anthropic API is never called directly,
    // so ANTHROPIC_API_KEY is no longer required for any step. (Enhancement uses
    // anthropic/claude-sonnet-4-6 *via OpenRouter*; synthesis uses Opus via OpenRouter.)
  }

  // Load custom prompt files if provided.
  const reviewPromptOverride = args.reviewPromptPath
    ? loadPromptFile(args.reviewPromptPath, "review-prompt")
    : null;
  const synthesisPromptOverride = args.synthesisPromptPath
    ? loadPromptFile(args.synthesisPromptPath, "synthesis-prompt")
    : null;

  // Select roster. `default`/`frontier` = quality-optimized (runs on every plan);
  // `cheap` = cost-optimized; `auto` = stakes-adaptive (resolved PER plan in the loop).
  const requestedRoster = args.roster ?? "default";
  const isAutoRoster = requestedRoster === "auto";
  const excludeSet = new Set(args.excludeModels);
  if (excludeSet.size > 0) {
    console.log(`Excluding ${excludeSet.size} model(s) from council: ${[...excludeSet].join(", ")}`);
  }

  // For a fixed roster, resolve + validate once up front. For `auto`, defer to the loop
  // (each plan is sized independently).
  let staticCouncil: ModelInfo[] | null = null;
  if (isAutoRoster) {
    console.log(`Auto-roster: picking cheap vs frontier per plan (threshold ~${args.autoThresholdTokens} tokens; 'criticality:' frontmatter overrides).`);
  } else {
    const built = buildCouncil(requestedRoster, excludeSet, args.minSuccessfulModels, true);
    if (built.error) {
      console.error(`Error: ${built.error}`);
      process.exit(1);
    }
    staticCouncil = built.models;
    if (requestedRoster !== "default") {
      console.log(`Using '${requestedRoster}' roster (${staticCouncil.length} models)`);
    }
  }

  // --output-path only makes sense for single-file input.
  if (args.outputPath && args.batch) {
    console.error("Error: --output-path is incompatible with --batch (ambiguous destination).");
    process.exit(1);
  }

  const plans = findPlans(args.target, args.batch);
  console.log(`\nFound ${plans.length} plan${plans.length !== 1 ? "s" : ""} to review\n`);

  if (plans.length === 0) {
    console.log("Nothing to do.");
    return 0;
  }

  // Build context once (all plans presumably share the same repo)
  const firstPlan = plans[0];
  const repoRoot = findRepoRoot(firstPlan);
  console.log(`Building local context from ${repoRoot}...`);

  const context = await buildLocalContext(repoRoot, {
    enhance: args.enhance && !args.dryRun,
    openrouterKey,
  });

  console.log(`Context: ${context.tree.filter((f) => f.type === "file").length} files, ${Object.keys(context.keyFiles).length} key files`);
  if (args.enhance && !args.dryRun) {
    console.log(`Brief was AI-enhanced with Claude Sonnet\n`);
  } else {
    console.log(`Brief is template-only\n`);
  }

  // Process each plan
  let reviewed = 0;
  let skipped = 0;
  let failed = 0;
  let cumulativeCost = 0;

  for (const planPath of plans) {
    const relPath = path.relative(process.cwd(), planPath);
    console.log(`\n▸ ${relPath}`);

    // Resolve the council for THIS plan: fixed roster, or stakes-adaptive under `auto`.
    let councilForPlan = staticCouncil;
    let resolvedRoster = requestedRoster;
    if (isAutoRoster) {
      const pick = resolveAutoRoster(fs.readFileSync(planPath, "utf-8"), args.autoThresholdTokens);
      const built = buildCouncil(pick.roster, excludeSet, args.minSuccessfulModels, false);
      if (built.error) {
        console.log(`  ✗ Failed: ${built.error}`);
        failed++;
        continue;
      }
      councilForPlan = built.models;
      resolvedRoster = pick.roster;
      console.log(`  Auto-roster: ${pick.roster} (${pick.reason})`);
    }

    // Batch-level cap (--max-cost). Previously parsed but never read.
    if (cumulativeCost >= args.maxCost) {
      console.log(`  ✗ Skipped: cumulative spend $${cumulativeCost.toFixed(2)} has reached --max-cost $${args.maxCost.toFixed(2)}`);
      failed++;
      continue;
    }

    try {
      const result = await reviewPlan(
        planPath,
        context,
        args,
        openrouterKey,
        reviewPromptOverride,
        synthesisPromptOverride,
        councilForPlan!,
        resolvedRoster,
      );
      cumulativeCost += result.cost ?? 0;
      if (result.error) {
        console.log(`  ✗ Failed: ${result.error}`);
        failed++;
      } else if (result.skipped) {
        const reason = result.skipReason === "already-reviewed"
          ? "already reviewed (matching hash)"
          : "dry-run — would review";
        console.log(`  ⊘ ${reason}`);
        skipped++;
      } else {
        console.log(`  ✓ Review saved → ${path.relative(process.cwd(), result.reviewPath!)}`);
        reviewed++;
      }
    } catch (err) {
      console.log(`  ✗ Error: ${(err as Error).message}`);
      failed++;
    }
  }

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Done: ${reviewed} reviewed, ${skipped} skipped, ${failed} failed — total spend $${cumulativeCost.toFixed(3)}`);

  return failed > 0 ? 1 : 0;
}

main().then((exitCode) => {
  process.exit(exitCode);
}).catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
