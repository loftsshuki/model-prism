// ═══════════════════════════════════════════════════════════════════════════
// Diff two reviews of the same plan.
//
// Findings carry stable ids (findingId over the normalized claim), so a second
// review can be compared with the first deterministically: which findings
// went away (resolved), which are still there (persisting), which appeared
// (new). Ids only survive an unchanged claim, though, and a model re-words
// the same point freely between runs, so unmatched ids get a second chance
// through claimSimilarity before being declared resolved/new.
//
// Browser-safe: no node: imports (the web app renders the same diff).
// ═══════════════════════════════════════════════════════════════════════════

import { claimSimilarity, findingId } from "./findings";

export interface ReviewFindingRef {
  id: string;
  claim: string;
  severity: string;
  category?: string;
  location?: string;
  models?: string[];
}

export interface ReviewComparison {
  resolved: ReviewFindingRef[];
  new: ReviewFindingRef[];
  persisting: Array<{ previous: ReviewFindingRef; current: ReviewFindingRef; matchedBy: "id" | "similarity" }>;
  summary: string;
}

const DEFAULT_SIMILARITY_THRESHOLD = 0.6;

const SEV_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
const sevRank = (s: string) => SEV_RANK[s.toLowerCase()] ?? 2;

/** Fill a missing id from the claim and drop exact duplicate ids (first wins). */
function normalizeRefs(refs: ReviewFindingRef[]): ReviewFindingRef[] {
  const seen = new Set<string>();
  const out: ReviewFindingRef[] = [];
  for (const r of refs) {
    const claim = (r.claim ?? "").trim();
    if (!claim) continue;
    const id = r.id?.trim() || findingId(claim);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...r, id, claim, severity: (r.severity || "medium").toLowerCase() });
  }
  return out;
}

export function compareReviews(
  previous: ReviewFindingRef[],
  current: ReviewFindingRef[],
  opts: { similarityThreshold?: number } = {},
): ReviewComparison {
  const threshold = opts.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const prev = normalizeRefs(previous);
  const cur = normalizeRefs(current);

  const persisting: ReviewComparison["persisting"] = [];
  const matchedPrev = new Set<string>();
  const matchedCur = new Set<string>();

  // Pass 1: exact id.
  const prevById = new Map(prev.map((p) => [p.id, p] as const));
  for (const c of cur) {
    const p = prevById.get(c.id);
    if (!p) continue;
    persisting.push({ previous: p, current: c, matchedBy: "id" });
    matchedPrev.add(p.id);
    matchedCur.add(c.id);
  }

  // Pass 2: best-first greedy matching on claim similarity among the leftovers.
  // Best-first (rather than first-come) keeps a re-worded claim from being
  // stolen by a weaker neighbour that happened to be listed earlier.
  const candidates: Array<{ p: ReviewFindingRef; c: ReviewFindingRef; score: number }> = [];
  for (const c of cur) {
    if (matchedCur.has(c.id)) continue;
    for (const p of prev) {
      if (matchedPrev.has(p.id)) continue;
      const score = claimSimilarity(p.claim, c.claim);
      if (score >= threshold) candidates.push({ p, c, score });
    }
  }
  candidates.sort((x, y) => y.score - x.score || x.p.id.localeCompare(y.p.id) || x.c.id.localeCompare(y.c.id));
  for (const { p, c } of candidates) {
    if (matchedPrev.has(p.id) || matchedCur.has(c.id)) continue;
    persisting.push({ previous: p, current: c, matchedBy: "similarity" });
    matchedPrev.add(p.id);
    matchedCur.add(c.id);
  }

  // Present persisting findings in the current review's order, whichever pass matched them.
  const curIndex = new Map(cur.map((c, i) => [c.id, i] as const));
  persisting.sort((a, b) => (curIndex.get(a.current.id) ?? 0) - (curIndex.get(b.current.id) ?? 0));

  const resolved = prev.filter((p) => !matchedPrev.has(p.id));
  const fresh = cur.filter((c) => !matchedCur.has(c.id));

  const bySimilarity = persisting.filter((p) => p.matchedBy === "similarity").length;
  const summary = prev.length === 0 && cur.length === 0
    ? "No findings in either review."
    : `${resolved.length} resolved, ${persisting.length} still open${bySimilarity ? ` (${bySimilarity} matched by similarity)` : ""}, ${fresh.length} new.`;

  return { resolved, new: fresh, persisting, summary };
}

// ── Rendering ───────────────────────────────────────────────────────────────

function refLine(r: ReviewFindingRef, suffix = ""): string {
  const tags = `[${r.severity}]${r.category ? ` [${r.category}]` : ""}`;
  return `- **${tags}** ${r.claim}${r.location ? ` _(${r.location})_` : ""} \`${r.id}\`${suffix}`;
}

const bySeverity = (a: ReviewFindingRef, b: ReviewFindingRef) => sevRank(b.severity) - sevRank(a.severity);

/** "## Since last review" block for the rendered review; empty string when there is nothing to say. */
export function renderComparisonMarkdown(c: ReviewComparison): string {
  if (c.resolved.length === 0 && c.new.length === 0 && c.persisting.length === 0) return "";
  const lines: string[] = [
    "## Since last review",
    "",
    `**${c.resolved.length} resolved · ${c.persisting.length} still open · ${c.new.length} new**`,
  ];
  if (c.resolved.length) {
    lines.push("", "### Resolved");
    for (const r of [...c.resolved].sort(bySeverity)) lines.push(refLine(r));
  }
  if (c.persisting.length) {
    lines.push("", "### Still open");
    for (const p of c.persisting) {
      const notes: string[] = [];
      if (p.previous.severity !== p.current.severity) notes.push(`was [${p.previous.severity}]`);
      if (p.matchedBy === "similarity") notes.push(`matched by similarity to \`${p.previous.id}\``);
      lines.push(refLine(p.current, notes.length ? ` _(${notes.join("; ")})_` : ""));
    }
  }
  if (c.new.length) {
    lines.push("", "### New");
    for (const r of [...c.new].sort(bySeverity)) lines.push(refLine(r));
  }
  return lines.join("\n");
}

// ── Parsing a rendered review back into refs ────────────────────────────────

// The line shape renderFindingsMarkdown emits:
//   - **[severity] [category]** claim _(location)_ `f_xxxxxxxxxxxx`
// The category bracket and the location are optional, and the tail after the
// bold tags is matched loosely because judges and humans append notes.
const FINDING_LINE = /^\s*[-*]\s+\*\*\[([^\]]+)\](?:\s*\[([^\]]+)\])?\*\*\s*(.*)$/;
const FINDING_ID = /`(f_[0-9a-f]{12})`/;
const LOCATION = /\s*_\(([^)]*)\)_/;
const FENCE = /```([^\n]*)\n([\s\S]*?)```/g;

function refFromJson(item: unknown): ReviewFindingRef | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  if (typeof o.claim !== "string" || !o.claim.trim()) return null;
  const claim = o.claim.trim();
  return {
    id: typeof o.id === "string" && o.id.trim() ? o.id.trim() : findingId(claim),
    claim,
    severity: typeof o.severity === "string" && o.severity ? o.severity.toLowerCase() : "medium",
    category: typeof o.category === "string" ? o.category : undefined,
    location: typeof o.location === "string" ? o.location : undefined,
    models: Array.isArray(o.models) ? o.models.filter((m): m is string => typeof m === "string") : undefined,
  };
}

/**
 * Recover finding refs from a rendered review file. Bulleted finding lines are
 * the primary source; a fenced ```json block whose info string mentions
 * `findings` (either an array or `{ findings: [...] }`) is merged in as well.
 * Duplicate ids keep the first occurrence.
 */
export function parseFindingRefsFromReview(markdown: string): ReviewFindingRef[] {
  const out: ReviewFindingRef[] = [];
  const seen = new Set<string>();
  const push = (r: ReviewFindingRef | null) => {
    if (!r || seen.has(r.id)) return;
    seen.add(r.id);
    out.push(r);
  };

  // Strip fenced blocks before line-scanning so a JSON block or a quoted
  // sample review does not get parsed twice.
  const fences: Array<{ info: string; body: string }> = [];
  const prose = markdown.replace(FENCE, (_m, info: string, body: string) => {
    fences.push({ info: info.trim(), body });
    return "";
  });

  for (const line of prose.split(/\r?\n/)) {
    const m = FINDING_LINE.exec(line);
    if (!m) continue;
    const [, severity, category, rest] = m;
    const idMatch = FINDING_ID.exec(rest);
    let claimPart = idMatch ? rest.slice(0, idMatch.index) : rest;
    let location: string | undefined;
    const loc = LOCATION.exec(claimPart);
    if (loc) {
      location = loc[1].trim() || undefined;
      claimPart = claimPart.slice(0, loc.index) + claimPart.slice(loc.index + loc[0].length);
    }
    const claim = claimPart.replace(/\s+/g, " ").trim();
    if (!claim) continue;
    push({
      id: idMatch ? idMatch[1] : findingId(claim),
      claim,
      severity: severity.trim().toLowerCase(),
      category: category?.trim() || undefined,
      location,
    });
  }

  for (const f of fences) {
    if (!/\bfindings\b/i.test(f.info)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(f.body);
    } catch {
      continue;
    }
    const items = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { findings?: unknown }).findings)
        ? (parsed as { findings: unknown[] }).findings
        : [];
    for (const item of items) push(refFromJson(item));
  }

  return out;
}
