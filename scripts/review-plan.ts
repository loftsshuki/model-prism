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
 *   OPENROUTER_API_KEY   Required
 *   ANTHROPIC_API_KEY    Required for synthesis + brief enhancement
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { fanOut } from "../src/lib/fan-out";
import { synthesizeDirect, SYNTHESIS_MODEL_IDS } from "../src/lib/synthesis";
import {
  buildLocalContext, buildLocalContextString, findRepoRoot, LocalContext,
  detectPlanReferencedFiles, loadReferencedFiles, detectSemanticReferences,
} from "../src/lib/local-context";
import { ModelInfo, ModelResponse, SynthesisResult } from "../src/lib/types";
// Council rosters live in their own module so the freshness checker
// (scripts/check-roster-freshness.ts) reads the exact rosters that run here.
import { ROSTERS, resolveAutoRoster, AUTO_THRESHOLD_TOKENS } from "../src/lib/rosters";
import { buildRunTelemetry } from "../src/lib/telemetry";
import { appendRunTelemetry } from "../src/lib/telemetry-ledger";
import { buildReviewRecord, appendReviewRecord, writeBrainDigest } from "../src/lib/review-ledger";

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
}

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
  --max-cost N               Abort batch if cumulative cost > N dollars (default: 5)
  --max-cost-per-plan N      Per-plan circuit breaker (default: 1.00)
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
    maxCost: getNum("--max-cost", 5.0),
    maxCostPerPlan: getNum("--max-cost-per-plan", 1.0),
    minSuccessfulModels: Math.floor(getNum("--min-successful-models", 6)),
    enhance: !argv.includes("--no-enhance"),
    reviewPromptPath: getStr("--review-prompt"),
    synthesisPromptPath: getStr("--synthesis-prompt"),
    outputPath: getStr("--output-path"),
    excludeModels: getStrArray("--exclude-model"),
    roster: getStr("--roster"),
    autoThresholdTokens: Math.floor(getNum("--auto-threshold-tokens", AUTO_THRESHOLD_TOKENS)),
  };
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

  const frontmatter = `---
${sourceKey}: ${path.basename(data.planPath)}
reviewed-at: ${new Date().toISOString()}
content-hash: ${data.contentHash}
context-repo: ${data.contextRepo}
models-succeeded: ${successfulModels.length}
models-failed: ${failedModels.length}
synthesis-model: ${SYNTHESIS_MODEL_IDS.opus}
total-input-tokens: ${data.totalInputTokens}
total-output-tokens: ${data.totalOutputTokens}
duration-sec: ${data.durationSec}
---

`;

  const lines: string[] = [frontmatter];
  lines.push(`# ${title}: ${planName}`);
  lines.push("");
  lines.push(`Reviewed by ${successfulModels.length} models across ${new Set(successfulModels.map((r) => {
    const info = rosterLookup.find((m) => m.id === r.model);
    return info?.family ?? "unknown";
  })).size} architectures, synthesized with Claude Opus.`);
  lines.push("");

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
        const bar = "█".repeat(score) + "░".repeat(3 - score);
        lines.push(`- ${model}: \`${bar}\` ${score}/3`);
      }
      lines.push("");
    }
  }

  // Failed models
  if (failedModels.length > 0) {
    lines.push("## Failed Models");
    lines.push("");
    for (const f of failedModels) {
      lines.push(`- **${f.modelName}**: ${f.error}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(`_Generated by Model Prism on ${new Date().toISOString()}_`);

  fs.writeFileSync(reviewPath, lines.join("\n"));
  return reviewPath;
}

// --- Process a single plan ---

async function reviewPlan(
  planPath: string,
  context: LocalContext,
  args: Args,
  openrouterKey: string,
  anthropicKey: string,
  reviewPromptOverride: string | null,
  synthesisPromptOverride: string | null,
  activeCouncilModels: ModelInfo[]
): Promise<{ skipped: boolean; skipReason?: "already-reviewed" | "dry-run"; reviewPath?: string; error?: string }> {
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

  // Build the council context: base brief + pre-fetched files with explicit instruction
  const baseContext = buildLocalContextString(context);
  const referencedSection = totalPreFetched > 0
    ? `\n\nPLAN-REFERENCED FILES (verified to exist on disk — use these as ground truth, not assumptions):\n\n` +
      Object.entries(allPreFetched)
        .map(([p, c]) => `### ${p}\n\`\`\`${p.split(".").pop() || ""}\n${c}\n\`\`\``)
        .join("\n\n")
    : "";

  const contextString = baseContext + referencedSection;
  const planName = path.basename(planPath);

  // Use custom review prompt if provided, otherwise built-in plan-review prompt.
  const effectiveReviewPrompt = reviewPromptOverride ?? REVIEW_PROMPT;

  const freeCount = activeCouncilModels.filter((m) => m.tier === "free").length;
  const paidCount = activeCouncilModels.length - freeCount;
  console.log(`  Fanning out to ${activeCouncilModels.length} council models (${freeCount} free + ${paidCount} paid)...`);
  const startTime = Date.now();

  let completedCount = 0;
  const responses = await fanOut({
    models: activeCouncilModels,
    content: planContent,
    prompt: effectiveReviewPrompt,
    apiKey: openrouterKey,
    runId: null,
    maxTokens: 4096,
    isAborted: () => false,
    context: contextString,
    onUpdate: (modelId, resp) => {
      if (resp.status === "complete" || resp.status === "error") {
        completedCount++;
        const info = activeCouncilModels.find((m) => m.id === modelId);
        const symbol = resp.status === "complete" ? "✓" : "✗";
        const suffix = resp.status === "error" && resp.error
          ? `  [${resp.error.slice(0, 80)}]`
          : "";
        process.stdout.write(`    ${symbol} ${info?.name ?? modelId} (${completedCount}/${activeCouncilModels.length})${suffix}\n`);
      }
    },
  });

  const successful = responses.filter((r) => r.status === "complete" && r.response);
  if (successful.length < args.minSuccessfulModels) {
    return {
      skipped: false,
      error: `Only ${successful.length}/${activeCouncilModels.length} models succeeded — need ≥${args.minSuccessfulModels} for reliable synthesis (configure via --min-successful-models)`,
    };
  }

  // Estimate synthesis cost as a circuit breaker
  const totalResponseChars = successful.reduce((sum, r) => sum + (r.response?.length ?? 0), 0);
  const estimatedSynthesisInputTokens = Math.ceil((totalResponseChars + planContent.length + (contextString?.length ?? 0)) / 4);
  const estimatedSynthesisOutputTokens = 4000; // typical Opus synthesis output
  // Opus 4.6: $15/1M input, $75/1M output
  const estimatedSynthesisCost =
    (estimatedSynthesisInputTokens / 1_000_000) * 15 +
    (estimatedSynthesisOutputTokens / 1_000_000) * 75;

  if (estimatedSynthesisCost > args.maxCostPerPlan) {
    return {
      skipped: false,
      error: `Projected Opus synthesis cost ($${estimatedSynthesisCost.toFixed(3)}) exceeds per-plan cap ($${args.maxCostPerPlan.toFixed(2)}). Raise --max-cost-per-plan or reduce plan/context size.`,
    };
  }

  console.log(`  Synthesizing with Claude Opus... (estimated cost: $${estimatedSynthesisCost.toFixed(3)})`);
  const synthesisResponses = successful.map((r) => {
    const info = activeCouncilModels.find((m) => m.id === r.model);
    return {
      model: r.model,
      modelName: r.modelName,
      family: info?.family ?? "unknown",
      response: r.response!,
    };
  });

  const synthesis = await synthesizeDirect(
    anthropicKey,
    "opus",
    planContent,
    effectiveReviewPrompt,
    synthesisResponses,
    contextString,
    synthesisPromptOverride
  );

  const durationSec = Math.round((Date.now() - startTime) / 1000);
  const totalInputTokens = responses.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0);
  const totalOutputTokens = responses.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0);

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
  });

  // Record per-model telemetry for the `model-value` report. Best-effort: a telemetry
  // write must never fail a completed review.
  try {
    appendRunTelemetry(buildRunTelemetry({
      ts: new Date().toISOString(),
      plan: path.basename(planPath),
      contentHash,
      contextRepo: context.repoName,
      roster: args.roster ?? "default",
      synthesisModel: SYNTHESIS_MODEL_IDS.opus,
      durationSec,
      synthesis,
      responses,
      usedModels: activeCouncilModels,
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
      roster: args.roster ?? "default",
      synthesisModel: SYNTHESIS_MODEL_IDS.opus,
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

  return { skipped: false, reviewPath: outputPath };
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

  const openrouterKey = process.env.OPENROUTER_API_KEY || "";
  const anthropicKey = process.env.ANTHROPIC_API_KEY || "";

  if (!args.dryRun) {
    if (!openrouterKey) {
      console.error("Error: OPENROUTER_API_KEY environment variable is required");
      process.exit(1);
    }
    if (!anthropicKey) {
      console.error("Error: ANTHROPIC_API_KEY environment variable is required");
      process.exit(1);
    }
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
    anthropicKey,
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

  for (const planPath of plans) {
    const relPath = path.relative(process.cwd(), planPath);
    console.log(`\n▸ ${relPath}`);

    // Resolve the council for THIS plan: fixed roster, or stakes-adaptive under `auto`.
    let councilForPlan = staticCouncil;
    if (isAutoRoster) {
      const pick = resolveAutoRoster(fs.readFileSync(planPath, "utf-8"), args.autoThresholdTokens);
      const built = buildCouncil(pick.roster, excludeSet, args.minSuccessfulModels, false);
      if (built.error) {
        console.log(`  ✗ Failed: ${built.error}`);
        failed++;
        continue;
      }
      councilForPlan = built.models;
      console.log(`  Auto-roster: ${pick.roster} (${pick.reason})`);
    }

    try {
      const result = await reviewPlan(
        planPath,
        context,
        args,
        openrouterKey,
        anthropicKey,
        reviewPromptOverride,
        synthesisPromptOverride,
        councilForPlan!,
      );
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
  console.log(`Done: ${reviewed} reviewed, ${skipped} skipped, ${failed} failed`);

  return failed > 0 ? 1 : 0;
}

main().then((exitCode) => {
  process.exit(exitCode);
}).catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
