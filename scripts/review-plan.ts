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
import { synthesizeDirect } from "../src/lib/synthesis";
import {
  buildLocalContext, buildLocalContextString, findRepoRoot, LocalContext,
  detectPlanReferencedFiles, loadReferencedFiles,
} from "../src/lib/local-context";
import { ModelInfo, ModelResponse, SynthesisResult } from "../src/lib/types";

// --- The 10-model council ---

// 10-model council: 5 proven-reliable free + 5 cheap paid for guaranteed coverage.
// Free tier has account-wide daily quotas — 5 free is the practical ceiling we can
// count on. The 5 paid slots (all sub-cent) ensure we always hit 10/10 responses.
// Total cost per plan: ~$0.05 for the 5 paid calls + ~$0.10 for Opus synthesis.
const COUNCIL_MODELS: ModelInfo[] = [
  // --- 5 reliable free models (proven 5/5 on 2026-04-10 under quota pressure) ---
  { id: "openai/gpt-oss-120b:free", name: "GPT-OSS 120B", family: "gpt-oss", tier: "free", contextLength: 131072, inputCostPer1k: 0, outputCostPer1k: 0 },
  { id: "openai/gpt-oss-20b:free", name: "GPT-OSS 20B", family: "gpt-oss-small", tier: "free", contextLength: 131072, inputCostPer1k: 0, outputCostPer1k: 0 },
  { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "Nemotron 3 Super 120B", family: "nemotron", tier: "free", contextLength: 262144, inputCostPer1k: 0, outputCostPer1k: 0 },
  { id: "nvidia/nemotron-nano-12b-v2-vl:free", name: "Nemotron Nano 12B", family: "nemotron-small", tier: "free", contextLength: 128000, inputCostPer1k: 0, outputCostPer1k: 0 },
  { id: "z-ai/glm-4.5-air:free", name: "GLM 4.5 Air", family: "glm", tier: "free", contextLength: 131072, inputCostPer1k: 0, outputCostPer1k: 0 },
  // --- 5 cheap paid models (guaranteed responses, maximum family diversity) ---
  { id: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5", family: "claude", tier: "fast", contextLength: 200000, inputCostPer1k: 0.001, outputCostPer1k: 0.005 },
  { id: "openai/gpt-4o-mini", name: "GPT-4o Mini", family: "gpt-4o", tier: "fast", contextLength: 128000, inputCostPer1k: 0.00015, outputCostPer1k: 0.0006 },
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", family: "gemini", tier: "fast", contextLength: 1048576, inputCostPer1k: 0.0003, outputCostPer1k: 0.0025 },
  { id: "deepseek/deepseek-chat", name: "DeepSeek V3", family: "deepseek", tier: "fast", contextLength: 65536, inputCostPer1k: 0.00027, outputCostPer1k: 0.0011 },
  { id: "mistralai/mistral-large-2411", name: "Mistral Large", family: "mistral", tier: "fast", contextLength: 131072, inputCostPer1k: 0.002, outputCostPer1k: 0.006 },
];

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

  return {
    target: argv[0],
    batch: argv.includes("--batch"),
    force: argv.includes("--force"),
    dryRun: argv.includes("--dry-run"),
    maxCost: getNum("--max-cost", 5.0),
    maxCostPerPlan: getNum("--max-cost-per-plan", 1.0),
    minSuccessfulModels: Math.floor(getNum("--min-successful-models", 6)),
    enhance: !argv.includes("--no-enhance"),
  };
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
  totalInputTokens: number;
  totalOutputTokens: number;
  durationSec: number;
}

function writeReviewFile(data: ReviewData): string {
  const reviewPath = getReviewPath(data.planPath);
  const reviewDir = path.dirname(reviewPath);
  if (!fs.existsSync(reviewDir)) {
    fs.mkdirSync(reviewDir, { recursive: true });
  }

  const planName = path.basename(data.planPath, ".md");
  const successfulModels = data.modelResponses.filter((r) => r.status === "complete");
  const failedModels = data.modelResponses.filter((r) => r.status === "error");

  const frontmatter = `---
plan: ${path.basename(data.planPath)}
reviewed-at: ${new Date().toISOString()}
content-hash: ${data.contentHash}
context-repo: ${data.contextRepo}
models-succeeded: ${successfulModels.length}
models-failed: ${failedModels.length}
synthesis-model: claude-opus-4-6
total-input-tokens: ${data.totalInputTokens}
total-output-tokens: ${data.totalOutputTokens}
duration-sec: ${data.durationSec}
---

`;

  const lines: string[] = [frontmatter];
  lines.push(`# Plan Review: ${planName}`);
  lines.push("");
  lines.push(`Reviewed by ${successfulModels.length} models across ${new Set(successfulModels.map((r) => {
    const info = COUNCIL_MODELS.find((m) => m.id === r.model);
    return info?.family ?? "unknown";
  })).size} architectures, synthesized with Claude Opus.`);
  lines.push("");

  // Master document
  if (data.synthesis.masterDocument) {
    lines.push("## Master Synthesis");
    lines.push("");
    lines.push(data.synthesis.masterDocument);
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

  // Unique insights
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

  // Disagreements
  if (data.synthesis.disagreements?.length > 0) {
    lines.push("## Disagreements");
    lines.push("");
    for (const d of data.synthesis.disagreements) {
      lines.push(`### ${d.topic}`);
      lines.push("");
      for (const p of d.positions) {
        lines.push(`- **${p.models.join(", ")}**: ${p.position}`);
      }
      lines.push("");
    }
  }

  // Blind spots
  if (data.synthesis.blindSpots?.length > 0) {
    lines.push("## Blind Spots");
    lines.push("");
    lines.push("Aspects of the plan that most models ignored:");
    lines.push("");
    for (const b of data.synthesis.blindSpots) {
      lines.push(`- ${b}`);
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
  anthropicKey: string
): Promise<{ skipped: boolean; skipReason?: "already-reviewed" | "dry-run"; reviewPath?: string; error?: string }> {
  const planContent = fs.readFileSync(planPath, "utf-8");
  const contentHash = hashContent(planContent);
  const reviewPath = getReviewPath(planPath);

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

  // Pre-fetch files referenced in the plan — gives council models verified
  // contents to reason from instead of guessing based on filenames
  const referencedPaths = detectPlanReferencedFiles(planContent, context.repoRoot);
  const referencedFiles = loadReferencedFiles(context.repoRoot, referencedPaths);
  const referencedCount = Object.keys(referencedFiles).length;
  if (referencedCount > 0) {
    console.log(`  Pre-fetched ${referencedCount} plan-referenced file(s) for verification context`);
  }

  // Build the council context: base brief + pre-fetched files with explicit instruction
  const baseContext = buildLocalContextString(context);
  const referencedSection = referencedCount > 0
    ? `\n\nPLAN-REFERENCED FILES (verified to exist on disk — use these as ground truth, not assumptions):\n\n` +
      Object.entries(referencedFiles)
        .map(([p, c]) => `### ${p}\n\`\`\`${p.split(".").pop() || ""}\n${c}\n\`\`\``)
        .join("\n\n")
    : "";

  const contextString = baseContext + referencedSection;
  const planName = path.basename(planPath);

  console.log(`  Fanning out to ${COUNCIL_MODELS.length} council models (5 free + 5 paid)...`);
  const startTime = Date.now();

  let completedCount = 0;
  const responses = await fanOut({
    models: COUNCIL_MODELS,
    content: planContent,
    prompt: REVIEW_PROMPT,
    apiKey: openrouterKey,
    runId: null,
    maxTokens: 4096,
    isAborted: () => false,
    context: contextString,
    onUpdate: (modelId, resp) => {
      if (resp.status === "complete" || resp.status === "error") {
        completedCount++;
        const info = COUNCIL_MODELS.find((m) => m.id === modelId);
        const symbol = resp.status === "complete" ? "✓" : "✗";
        const suffix = resp.status === "error" && resp.error
          ? `  [${resp.error.slice(0, 80)}]`
          : "";
        process.stdout.write(`    ${symbol} ${info?.name ?? modelId} (${completedCount}/${COUNCIL_MODELS.length})${suffix}\n`);
      }
    },
  });

  const successful = responses.filter((r) => r.status === "complete" && r.response);
  if (successful.length < args.minSuccessfulModels) {
    return {
      skipped: false,
      error: `Only ${successful.length}/${COUNCIL_MODELS.length} models succeeded — need ≥${args.minSuccessfulModels} for reliable synthesis (configure via --min-successful-models)`,
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
    const info = COUNCIL_MODELS.find((m) => m.id === r.model);
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
    REVIEW_PROMPT,
    synthesisResponses,
    contextString
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
    totalInputTokens,
    totalOutputTokens,
    durationSec,
  });

  return { skipped: false, reviewPath: outputPath };
}

// --- Main ---

async function main() {
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

  const plans = findPlans(args.target, args.batch);
  console.log(`\nFound ${plans.length} plan${plans.length !== 1 ? "s" : ""} to review\n`);

  if (plans.length === 0) {
    console.log("Nothing to do.");
    return;
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

    try {
      const result = await reviewPlan(planPath, context, args, openrouterKey, anthropicKey);
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
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
