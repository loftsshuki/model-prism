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

// repo:<path>@<sha>:<startLine>-<endLine>
const REPO_SOURCE_RE = /^repo:(.+)@([0-9a-fA-F]{7,40}):(\d+)-(\d+)$/;

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

// Resolve a `repo:<path>@<sha>:<start>-<end>` citation against the pinned SHA via
// `git show <sha>:<path>`, returning the cited line range's text (or null if the
// path/sha/range can't be resolved). Line ranges are 1-based, inclusive.
export function resolveRepoCitation(repoRoot: string, source: string): string | null {
  const m = source.match(REPO_SOURCE_RE);
  if (!m) return null;
  const [, filePath, sha, startStr, endStr] = m;
  const start = parseInt(startStr, 10);
  const end = parseInt(endStr, 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) return null;
  // Reject path traversal / absolute paths — only in-repo relative paths.
  if (filePath.includes("..") || filePath.startsWith("/") || /^[a-zA-Z]:/.test(filePath)) return null;
  try {
    const blob = execFileSync("git", ["-C", repoRoot, "show", `${sha}:${filePath}`], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const lines = blob.split("\n");
    if (start > lines.length) return null;
    return lines.slice(start - 1, Math.min(end, lines.length)).join("\n");
  } catch {
    return null;
  }
}

export interface EvidenceVerification {
  pinnedSha: string | null;
  kept: EvidenceItem[];
  dropped: Array<{ id: string; source: string; reason: "unresolvable" | "unsupported" }>;
}

// Verify the judge's evidence against the repo. Only `repo:` citations are SHA-
// checked; `model:`/`draft` citations are authored from the (already-paid) council
// transcript and kept as-is — their authority is the transcript, not the repo.
export function verifyJudgeEvidence(judge: JudgeResult, repoRoot: string, pinnedSha: string | null): EvidenceVerification {
  const kept: EvidenceItem[] = [];
  const dropped: EvidenceVerification["dropped"] = [];

  for (const e of judge.evidence) {
    if (!e.source.startsWith("repo:")) {
      kept.push(e);
      continue;
    }
    const resolved = resolveRepoCitation(repoRoot, e.source);
    if (resolved === null) {
      dropped.push({ id: e.id, source: e.source, reason: "unresolvable" });
      continue;
    }
    if (!quoteSupported(e.quote, resolved)) {
      dropped.push({ id: e.id, source: e.source, reason: "unsupported" });
      continue;
    }
    kept.push(e);
  }

  return { pinnedSha, kept, dropped };
}
