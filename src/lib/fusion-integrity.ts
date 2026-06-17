// ═══════════════════════════════════════════════════════════════════════════
// Model Prism — fusion citation integrity (B2 / B3)
//
// Accuracy-aware, SHA-pinned verification of judge evidence. Citations must
// resolve against a commit SHA pinned at JUDGE-INVOCATION time, using line ranges —
// because line numbers drift while a plan is being edited, resolving against the
// dirty working tree (or a bare HEAD that moved) produces false negatives.
//
// Verifies SEMANTIC support, not mere existence: a quote must actually appear in
// the resolved source (fusion.quoteSupported), so existence-only checks can't pass
// fabricated authority. Unresolved or unsupported citations are DROPPED, not
// laundered into apparent authority.
//
// The repo-grep/SHA work is here (needs git); the pure matching lives in fusion.ts.
// ═══════════════════════════════════════════════════════════════════════════

import { execFileSync } from "node:child_process";
import { quoteSupported, type JudgeResult, type EvidenceItem } from "./fusion";

// Two accepted source grammars:
//   repo:<path>@<sha>:<startLine>-<endLine>  — LINE-PINNED (strongest evidence)
//   repo:<path>                              — BARE / FILE-LEVEL (resolved at pinnedSha)
const REPO_PINNED_RE = /^repo:(.+)@([0-9a-fA-F]{7,40}):(\d+)-(\d+)$/;
const REPO_BARE_RE = /^repo:(.+)$/;

// L4 guards: never load a huge/binary/generated file into memory to substring-match
// (event-loop block / OOM on a single-threaded CLI run).
const MAX_FILE_BYTES = 200 * 1024;   // ~200 KB
const MAX_FILE_LINES = 2500;

// Skip vendored / generated / minified / binary-ish paths for BARE (full-file)
// resolution — a 20k-line bundle is exactly what blows the cap, and a generic quote
// matches incidentally inside it.
function isExcludedBarePath(p: string): boolean {
  return (
    /(^|\/)node_modules\//.test(p) ||
    /(^|\/)(dist|build|out|coverage|vendor|generated)\//.test(p) ||
    /\.next\//.test(p) ||
    /\.min\./.test(p) ||
    /\.(png|jpe?g|gif|webp|svg|ico|pdf|zip|gz|woff2?|ttf|eot|map|lock|wasm)$/i.test(p)
  );
}

// Reject path traversal / absolute paths — only in-repo relative paths.
function isRejectedPath(filePath: string): boolean {
  return filePath.includes("..") || filePath.startsWith("/") || /^[a-zA-Z]:/.test(filePath);
}

// `git show <sha>:<path>`. Returns null on ANY failure (missing SHA — uncommitted
// work / detached HEAD / remote-only SHA — bad path, timeout). NEVER throws (L5):
// a citation that can't resolve is dropped, the whole review is never failed.
function gitShow(repoRoot: string, sha: string, filePath: string): string | null {
  try {
    return execFileSync("git", ["-C", repoRoot, "show", `${sha}:${filePath}`], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

// Pin the repo HEAD at judge-invocation time. Returns null if not a git repo, in
// which case the integrity check degrades to "keep but cannot verify" (never blocks).
export function pinHeadSha(repoRoot: string): string | null {
  try {
    const sha = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export type CitationPrecision = "line-pinned" | "file-level";
export interface ResolvedCitation {
  text: string;
  precision: CitationPrecision;
}

// Resolve a repo citation against a pinned SHA. Returns the resolved text + whether it
// is line-pinned (a precise range) or file-level (a whole bare file). Null when it
// can't be resolved within the guards. `pinnedSha` is REQUIRED to resolve the bare
// form (which carries no SHA of its own); the line-pinned form carries its own SHA.
export function resolveRepoCitation(
  repoRoot: string,
  source: string,
  pinnedSha?: string | null,
): ResolvedCitation | null {
  // ── Line-pinned form ──
  const m = source.match(REPO_PINNED_RE);
  if (m) {
    const [, filePath, sha, startStr, endStr] = m;
    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) return null;
    if (isRejectedPath(filePath)) return null;
    const blob = gitShow(repoRoot, sha, filePath);
    if (blob === null) return null;
    const lines = blob.split("\n");
    if (start > lines.length) return null;
    return { text: lines.slice(start - 1, Math.min(end, lines.length)).join("\n"), precision: "line-pinned" };
  }

  // ── Bare / file-level form ── (repo:<path> with no @sha:range)
  const bare = source.match(REPO_BARE_RE);
  if (bare) {
    const filePath = bare[1];
    // A leftover '@' means a malformed pinned form (e.g. missing :range), not a real
    // bare path — refuse rather than resolve the wrong file.
    if (filePath.includes("@")) return null;
    if (isRejectedPath(filePath)) return null;
    if (isExcludedBarePath(filePath)) return null;
    if (!pinnedSha) return null; // bare form needs the pinned SHA to resolve at all
    const blob = gitShow(repoRoot, pinnedSha, filePath);
    if (blob === null) return null;
    // L4: oversize → drop (do not match-scan a huge file).
    if (blob.length > MAX_FILE_BYTES) return null;
    if (blob.split("\n").length > MAX_FILE_LINES) return null;
    return { text: blob, precision: "file-level" };
  }

  return null;
}

// Count non-overlapping occurrences of a normalized quote in normalized source.
export function countOccurrences(quote: string, sourceText: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const q = norm(quote);
  const src = norm(sourceText);
  if (!q) return 0;
  let count = 0;
  let idx = src.indexOf(q);
  while (idx !== -1) {
    count++;
    idx = src.indexOf(q, idx + q.length);
  }
  return count;
}

export interface EvidenceVerification {
  pinnedSha: string | null;
  kept: EvidenceItem[];
  dropped: Array<{ id: string; source: string; reason: "unresolvable" | "unsupported" | "ambiguous" }>;
}

// Verify the judge's evidence against the repo. Only `repo:` citations are SHA-
// checked; `model:`/`draft` citations are authored from the (already-paid) council
// transcript and kept as-is — their authority is the transcript, not the repo.
//
// Kept repo citations are TAGGED with `precision` (line-pinned vs file-level) so
// downstream can weight a precise range above a whole-file match. A bare file-level
// quote that matches MORE THAN ONCE is ambiguous — it can't reliably support the
// claimed occurrence, so it is dropped (would otherwise back the wrong line).
export function verifyJudgeEvidence(judge: JudgeResult, repoRoot: string, pinnedSha: string | null): EvidenceVerification {
  const kept: EvidenceItem[] = [];
  const dropped: EvidenceVerification["dropped"] = [];

  for (const e of judge.evidence) {
    if (!e.source.startsWith("repo:")) {
      kept.push(e);
      continue;
    }
    const resolved = resolveRepoCitation(repoRoot, e.source, pinnedSha);
    if (resolved === null) {
      dropped.push({ id: e.id, source: e.source, reason: "unresolvable" });
      continue;
    }
    if (!quoteSupported(e.quote, resolved.text)) {
      dropped.push({ id: e.id, source: e.source, reason: "unsupported" });
      continue;
    }
    if (resolved.precision === "file-level" && countOccurrences(e.quote, resolved.text) > 1) {
      dropped.push({ id: e.id, source: e.source, reason: "ambiguous" });
      continue;
    }
    kept.push({ ...e, precision: resolved.precision });
  }

  return { pinnedSha, kept, dropped };
}
