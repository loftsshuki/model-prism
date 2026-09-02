// ═══════════════════════════════════════════════════════════════════════════
// Structured council findings.
//
// Council members used to answer in free prose, and the judge had to rebuild
// "who said what" from ten essays. With `report_findings`, every member returns a
// list of discrete findings (claim, severity, category, location, verbatim
// evidence, recommendation). That makes three things deterministic instead of
// impressionistic:
//   - consensus: findings are clustered across members by claim similarity and
//     weighted by DISTINCT model family;
//   - stable ids: a finding's id is a hash of its normalized claim, so the same
//     issue keeps its id across re-reviews (resolved / new / persisting diffs);
//   - saturation: the fan-out can stop launching paid members once the last few
//     responses added no new clusters.
//
// Browser-safe: no node: imports (the web app uses this too).
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod";
import type { ToolDefinition } from "./openrouter";

export const FindingSeverity = z.enum(["critical", "high", "medium", "low", "info"]);
export type FindingSeverity = z.infer<typeof FindingSeverity>;

export const FINDING_CATEGORIES = ["correctness", "security", "data", "performance", "testing", "product", "operations", "other"] as const;
export const FindingCategory = z.enum(FINDING_CATEGORIES);
export type FindingCategory = z.infer<typeof FindingCategory>;

export const FindingSchema = z.object({
  /** Computed downstream from the claim (findingId); the model may leave it blank. */
  id: z.string().default(""),
  claim: z.string().min(1).describe("One specific, falsifiable statement of the problem or opportunity."),
  severity: FindingSeverity.default("medium"),
  category: FindingCategory.default("other"),
  location: z.string().optional().describe("Where: a file path, a plan section heading, or a symbol name."),
  evidence: z.string().optional().describe("Verbatim quote from the plan or provided context that supports the claim."),
  recommendation: z.string().optional().describe("The specific fix or action."),
  confidence: z.enum(["high", "medium", "low"]).default("medium"),
  /** Set by the pipeline when this finding could not be grounded (e.g. names a file that does not exist). */
  unverified: z.boolean().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export interface MemberFindings {
  model: string;
  modelName: string;
  family: string;
  findings: Finding[];
  summary?: string;
}

// ── Tool definition (OpenRouter function-calling shape) ─────────────────────

export const FINDINGS_TOOL_NAME = "report_findings";

export const FindingsJsonSchema = {
  type: "object" as const,
  required: ["findings", "summary"],
  properties: {
    summary: { type: "string", description: "Two to four sentences: overall verdict on the document." },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["claim", "severity", "category"],
        properties: {
          claim: { type: "string", description: "One specific, falsifiable statement. No hedging, no 'consider'." },
          severity: { type: "string", enum: FindingSeverity.options },
          category: { type: "string", enum: [...FINDING_CATEGORIES] },
          location: { type: "string", description: "File path, plan section, or symbol this applies to." },
          evidence: { type: "string", description: "Verbatim quote from the document or context. Never paraphrase." },
          recommendation: { type: "string", description: "The exact fix or action." },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
  },
};

export const FINDINGS_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: FINDINGS_TOOL_NAME,
    description: "Report the review as a list of discrete findings plus a short summary.",
    parameters: FindingsJsonSchema,
  },
};

/** Appended to a member's prompt when structured output is requested. */
export const STRUCTURED_REVIEW_INSTRUCTION = `

OUTPUT FORMAT: Respond ONLY by calling the \`${FINDINGS_TOOL_NAME}\` tool. Put every distinct issue, gap, risk, or opportunity in its own finding with:
- claim: one specific, falsifiable sentence (name the file, section, or symbol);
- severity: critical (will break outright) / high / medium / low / info;
- category: correctness, security, data, performance, testing, product, operations, or other;
- evidence: a VERBATIM quote from the document or context that shows the problem — never paraphrase, never invent;
- recommendation: the exact fix.
Do not merge unrelated issues into one finding. Do not pad with generic advice. If the document is sound in an area, say nothing about it. Set confidence to "low" for anything you could not verify against the provided context.`;

// ── Ids and normalization ───────────────────────────────────────────────────

const STOPWORDS = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "be", "this", "that", "it", "with", "as", "by", "at", "from", "will", "not", "no", "has", "have", "does", "do", "but", "than", "then", "into", "which", "when", "there", "their", "its", "should", "would", "could", "can", "may", "might", "must"]);

export function normalizeClaim(text: string): string {
  return text
    .toLowerCase()
    .replace(/`+/g, "")
    .replace(/[^a-z0-9./_-]+/g, " ")
    // trailing sentence punctuation on a token ("check." vs "check") must not change the id
    .replace(/[.]+(?=\s|$)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// FNV-1a over UTF-16 code units, two 32-bit lanes → 16 hex chars. Deterministic,
// synchronous, and available in browsers (Web Crypto's digest is async).
function fnv1a64Hex(input: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x9747b28c;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c ^ (i & 0xff); h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

/** Stable id for a finding: hash of the normalized claim (12 hex chars, `f_` prefix). */
export function findingId(claim: string): string {
  return "f_" + fnv1a64Hex(normalizeClaim(claim)).slice(0, 12);
}

/** Tokens that carry meaning: lowercase words longer than 3 chars, stopwords removed, light suffix stripping. */
export function claimTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of normalizeClaim(text).split(" ")) {
    if (raw.length <= 3 || STOPWORDS.has(raw)) continue;
    const w = raw.replace(/(ing|ed|es|s)$/g, "");
    if (w.length > 2) out.add(w);
  }
  return out;
}

/** Jaccard similarity of the two claims' token sets, boosted by shared bigrams. */
export function claimSimilarity(a: string, b: string): number {
  const ta = claimTokens(a), tb = claimTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const jaccard = inter / (ta.size + tb.size - inter);
  const bigrams = (s: string) => {
    const w = [...claimTokens(s)];
    const set = new Set<string>();
    const words = normalizeClaim(s).split(" ").filter((x) => x.length > 3 && !STOPWORDS.has(x));
    for (let i = 0; i + 1 < words.length; i++) set.add(words[i] + " " + words[i + 1]);
    return w.length ? set : set;
  };
  const ba = bigrams(a), bb = bigrams(b);
  let binter = 0;
  for (const g of ba) if (bb.has(g)) binter++;
  const bigramScore = ba.size && bb.size ? binter / Math.min(ba.size, bb.size) : 0;
  return Math.min(1, jaccard * 0.7 + bigramScore * 0.3 + (jaccard >= 0.5 ? 0.1 : 0));
}

// ── Coercion of model output ────────────────────────────────────────────────

const SEV_RANK: Record<FindingSeverity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

export function coerceFindings(raw: unknown): { findings: Finding[]; summary: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const summary = typeof r.summary === "string" ? r.summary.trim() : "";
  const items = Array.isArray(r.findings) ? r.findings : [];
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const parsed = FindingSchema.safeParse(item);
    let f: Finding | null = null;
    if (parsed.success) {
      f = parsed.data;
    } else if (item && typeof item === "object" && typeof (item as { claim?: unknown }).claim === "string") {
      // Salvage: keep the claim, default everything else.
      const o = item as Record<string, unknown>;
      f = {
        id: "",
        claim: String(o.claim),
        severity: FindingSeverity.options.includes(o.severity as FindingSeverity) ? (o.severity as FindingSeverity) : "medium",
        category: FINDING_CATEGORIES.includes(o.category as FindingCategory) ? (o.category as FindingCategory) : "other",
        location: typeof o.location === "string" ? o.location : undefined,
        evidence: typeof o.evidence === "string" ? o.evidence : undefined,
        recommendation: typeof o.recommendation === "string" ? o.recommendation : undefined,
        confidence: "medium",
      };
    }
    if (!f || !f.claim.trim()) continue;
    f.id = findingId(f.claim);
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    findings.push(f);
  }
  findings.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]);
  return { findings, summary };
}

/** Prose rendering of structured findings, so downstream stages that expect text (legacy synth, judge) still work. */
export function renderFindingsMarkdown(findings: Finding[], summary?: string): string {
  const lines: string[] = [];
  if (summary) lines.push(summary.trim(), "");
  if (findings.length === 0) {
    lines.push("_No findings reported._");
    return lines.join("\n");
  }
  for (const f of findings) {
    lines.push(`- **[${f.severity}] [${f.category}]** ${f.claim}${f.location ? ` _(${f.location})_` : ""} \`${f.id}\``);
    if (f.evidence) lines.push(`  - Evidence: "${f.evidence.replace(/\s+/g, " ").trim()}"`);
    if (f.recommendation) lines.push(`  - Fix: ${f.recommendation.trim()}`);
    if (f.unverified) lines.push(`  - ⚠ Unverified: references something not found in the repository.`);
  }
  return lines.join("\n");
}

// ── Clustering across members (computed consensus) ──────────────────────────

export interface FindingCluster {
  /** Id of the representative (first, highest-severity) finding. */
  id: string;
  claim: string;
  severity: FindingSeverity;
  category: FindingCategory;
  location?: string;
  families: string[];
  models: string[];
  findings: Array<Finding & { model: string; family: string }>;
}

export const CLUSTER_THRESHOLD = 0.42;

export function clusterFindings(members: MemberFindings[], threshold = CLUSTER_THRESHOLD): FindingCluster[] {
  const all = members.flatMap((m) => m.findings.map((f) => ({ ...f, model: m.model, family: m.family })));
  all.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]);
  const clusters: FindingCluster[] = [];
  for (const f of all) {
    let best: FindingCluster | null = null;
    let bestScore = 0;
    for (const c of clusters) {
      // Same location is a strong hint; compare against the representative and the best member.
      let score = claimSimilarity(f.claim, c.claim);
      for (const other of c.findings) score = Math.max(score, claimSimilarity(f.claim, other.claim) * 0.95);
      if (f.location && c.location && normalizeClaim(f.location) === normalizeClaim(c.location)) score += 0.1;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (best && bestScore >= threshold) {
      best.findings.push(f);
      if (!best.families.includes(f.family)) best.families.push(f.family);
      if (!best.models.includes(f.model)) best.models.push(f.model);
      if (SEV_RANK[f.severity] > SEV_RANK[best.severity]) best.severity = f.severity;
    } else {
      clusters.push({
        id: f.id, claim: f.claim, severity: f.severity, category: f.category, location: f.location,
        families: [f.family], models: [f.model], findings: [f],
      });
    }
  }
  // Most-supported first, then severity.
  clusters.sort((a, b) => b.families.length - a.families.length || SEV_RANK[b.severity] - SEV_RANK[a.severity]);
  return clusters;
}

export type ClusterKind = "consensus" | "contested" | "unique";

export function classifyCluster(c: FindingCluster, totalFamilies: number): ClusterKind {
  if (totalFamilies <= 0) return "unique";
  const share = c.families.length / totalFamilies;
  if (share >= 0.6) return "consensus";
  if (c.families.length >= 2) return "contested";
  return "unique";
}

/** Prompt block for the judge: computed consensus by distinct family, not the judge's impression. */
export function consensusBlock(clusters: FindingCluster[], totalFamilies: number, maxClusters = 60): string {
  if (clusters.length === 0) return "";
  const lines = [
    `<computed_consensus families=\"${totalFamilies}\" clusters=\"${clusters.length}\">`,
    "Findings from all council members, clustered by claim similarity and weighted by DISTINCT model family (computed deterministically — treat the support counts as fact). Use the cluster ids in your evidence.",
  ];
  for (const c of clusters.slice(0, maxClusters)) {
    const kind = classifyCluster(c, totalFamilies);
    lines.push(`- ${c.id} [${kind}] [${c.severity}] [${c.category}] ${c.families.length}/${totalFamilies} families (${c.models.join(", ")})${c.location ? ` @ ${c.location}` : ""}: ${c.claim}`);
  }
  if (clusters.length > maxClusters) lines.push(`… ${clusters.length - maxClusters} lower-support clusters omitted.`);
  lines.push("</computed_consensus>");
  return lines.join("\n");
}

// ── Saturation (adaptive council sizing) ────────────────────────────────────

/**
 * Tracks how many NEW clusters each successive member adds. Once the last
 * `window` members each added nothing, the council has saturated and the
 * remaining paid members are not worth launching.
 */
export class SaturationTracker {
  private members: MemberFindings[] = [];
  private clusterCount = 0;
  readonly newPerResponse: number[] = [];

  constructor(private threshold = CLUSTER_THRESHOLD) {}

  add(member: MemberFindings): number {
    this.members.push(member);
    const next = clusterFindings(this.members, this.threshold).length;
    const added = Math.max(0, next - this.clusterCount);
    this.clusterCount = next;
    this.newPerResponse.push(added);
    return added;
  }

  get clusters(): number { return this.clusterCount; }
  get responses(): number { return this.members.length; }

  isSaturated(window = 3, minResponses = 4): boolean {
    if (this.newPerResponse.length < Math.max(window, minResponses)) return false;
    return this.newPerResponse.slice(-window).every((n) => n === 0);
  }
}
