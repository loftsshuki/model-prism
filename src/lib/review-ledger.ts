import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { ModelResponse, SynthesisResult } from "./types";

// Review-findings ledger. Telemetry (model-telemetry.jsonl) captures per-MODEL numbers;
// this captures the per-REVIEW *findings* — the disagreements, blind spots, and sharpest
// insights that otherwise evaporate into one scattered <plan>/reviews/*.review.md file.
// Append-only JSONL so `review-digest` can surface patterns across every review, and
// (opt-in) a wikilinked digest is mirrored into the Brain vault so findings are searchable
// alongside everything else.
//
// Co-located with the telemetry ledger under the gitignored `.model-prism/` (cwd-relative),
// matching src/lib/telemetry-ledger.ts — so model-value and review-digest read from one
// place. This is the local CLI/offline store; the web app aggregates via the database.
export const REVIEW_LEDGER_PATH =
  process.env.MODEL_PRISM_REVIEW_LEDGER || path.join(process.cwd(), ".model-prism", "review-ledger.jsonl");

export interface ReviewRecord {
  ts: string;
  plan: string;
  contextRepo: string;
  roster: string;
  synthesisModel: string;
  durationSec: number;
  cost: number;
  modelsSucceeded: number;
  modelsFailed: number;
  disagreements: Array<{ topic: string; positions: Array<{ models: string[]; position: string }> }>;
  blindSpots: string[];
  topInsights: Array<{ model: string; insight: string; significance: string }>;
  consensusCount: number;
}

const SIG_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

export interface BuildReviewArgs {
  ts: string;
  plan: string;
  contextRepo: string;
  roster: string;
  synthesisModel: string;
  durationSec: number;
  synthesis: SynthesisResult;
  responses: ModelResponse[];
}

export function buildReviewRecord(a: BuildReviewArgs): ReviewRecord {
  const topInsights = [...(a.synthesis.uniqueInsights ?? [])]
    .sort((x, y) => (SIG_RANK[y.significance] ?? 0) - (SIG_RANK[x.significance] ?? 0))
    .slice(0, 5);
  return {
    ts: a.ts,
    plan: a.plan,
    contextRepo: a.contextRepo,
    roster: a.roster,
    synthesisModel: a.synthesisModel,
    durationSec: a.durationSec,
    cost: a.responses.reduce((s, r) => s + (r.cost ?? 0), 0),
    modelsSucceeded: a.responses.filter((r) => r.status === "complete").length,
    modelsFailed: a.responses.filter((r) => r.status === "error").length,
    disagreements: a.synthesis.disagreements ?? [],
    blindSpots: a.synthesis.blindSpots ?? [],
    topInsights,
    consensusCount: (a.synthesis.consensus ?? []).length,
  };
}

export function appendReviewRecord(record: ReviewRecord, pathOverride?: string): void {
  const file = pathOverride || REVIEW_LEDGER_PATH;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf-8");
}

export function loadReviewLedger(pathOverride?: string): ReviewRecord[] {
  const file = pathOverride || REVIEW_LEDGER_PATH;
  if (!fs.existsSync(file)) return [];
  const out: ReviewRecord[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as ReviewRecord);
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

// --- Brain vault mirror (opt-in, best-effort) ---

// Resolve the Brain vault root the same way ~/.claude/resolve_brain_root.py does:
// BRAIN_ROOT env → ~/.claude/brain-config.json `brain_root` → null.
export function resolveBrainRoot(): string | null {
  const env = process.env.MODEL_PRISM_BRAIN_ROOT || process.env.BRAIN_ROOT;
  if (env && fs.existsSync(env)) return env;
  try {
    const cfg = path.join(os.homedir(), ".claude", "brain-config.json");
    if (fs.existsSync(cfg)) {
      const root = (JSON.parse(fs.readFileSync(cfg, "utf-8")) as { brain_root?: string }).brain_root;
      if (root && fs.existsSync(root)) return root;
    }
  } catch {
    /* fall through */
  }
  return null;
}

// Brain digest writes ON by default wherever a Brain vault resolves; disable with
// MODEL_PRISM_BRAIN_DIGEST=0 (so CI / non-Brain machines are a clean no-op anyway).
export function brainDigestEnabled(): boolean {
  const v = (process.env.MODEL_PRISM_BRAIN_DIGEST || "").toLowerCase();
  return v !== "0" && v !== "false" && v !== "off";
}

function slugify(s: string): string {
  return s.replace(/\.md$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "review";
}

function shortHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36).slice(0, 6);
}

export function renderBrainDigest(r: ReviewRecord): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push("type: council-review");
  lines.push(`plan: ${r.plan}`);
  lines.push(`repo: ${r.contextRepo}`);
  lines.push(`reviewed-at: ${r.ts}`);
  lines.push(`roster: ${r.roster}`);
  lines.push(`models: ${r.modelsSucceeded}`);
  lines.push(`cost-usd: ${r.cost.toFixed(4)}`);
  lines.push("---");
  lines.push("");
  lines.push(`# Council Review — ${r.plan}`);
  lines.push("");
  lines.push(`[[Model Prism]] reviewed **${r.plan}** (${r.contextRepo}) with ${r.modelsSucceeded} models on the \`${r.roster}\` roster. This is the auto-captured digest of a [[council review]] — the full prose lives in the repo's \`reviews/\` folder.`);
  lines.push("");
  lines.push("## Decisions needed — where the council split");
  if (r.disagreements.length === 0) {
    lines.push("_Broad consensus — no contested points flagged._");
  } else {
    for (const d of r.disagreements) {
      lines.push(`- **${d.topic}**`);
      for (const p of d.positions) lines.push(`  - ${p.models.join(", ")}: ${p.position}`);
    }
  }
  lines.push("");
  lines.push("## Blind spots flagged");
  if (r.blindSpots.length === 0) lines.push("_None flagged._");
  else for (const b of r.blindSpots) lines.push(`- ${b}`);
  lines.push("");
  lines.push("## Sharpest unique insights");
  if (r.topInsights.length === 0) lines.push("_None surfaced._");
  else for (const i of r.topInsights) lines.push(`- _(${i.model}, ${i.significance})_ ${i.insight}`);
  lines.push("");
  return lines.join("\n") + "\n";
}

// Write the digest into <brain>/council-reviews/YYYY/MM/. Best-effort: returns the path
// written, or null if Brain isn't resolvable / disabled / the write failed.
export function writeBrainDigest(r: ReviewRecord, brainRootOverride?: string): string | null {
  if (!brainDigestEnabled()) return null;
  const root = brainRootOverride || resolveBrainRoot();
  if (!root) return null;
  try {
    const yyyy = r.ts.slice(0, 4);
    const mm = r.ts.slice(5, 7);
    const dd = r.ts.slice(8, 10);
    const dir = path.join(root, "council-reviews", yyyy, mm);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${dd}-${slugify(r.plan)}-${shortHash(r.ts + r.plan)}.md`);
    fs.writeFileSync(file, renderBrainDigest(r), "utf-8");
    return file;
  } catch {
    return null;
  }
}
