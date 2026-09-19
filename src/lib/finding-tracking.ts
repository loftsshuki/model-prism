import type { SourceDocument } from "./review-policy";
import type { SynthesisResult } from "./types";

export type ReviewFinding = NonNullable<SynthesisResult["findings"]>[number];
export type FindingState = "open" | "accepted" | "dismissed" | "fixed";
export type DismissalReason = "false_positive" | "not_actionable" | "duplicate" | "other";
export interface EvidenceLocation {
  sourceId: string; path: string; startLine: number; endLine: number; url?: string;
}
export interface TrackedFinding {
  fingerprint: string; finding: ReviewFinding; state: FindingState; dismissalReason?: DismissalReason;
  note: string; locations: EvidenceLocation[]; change: "new" | "recurring" | "not_reported"; updatedAt: string;
}

export function evidenceLocations(finding: ReviewFinding, sources: SourceDocument[]): EvidenceLocation[] {
  const locations: EvidenceLocation[] = [];
  for (const evidence of finding.evidence) {
    if (evidence.source.startsWith("model:") || evidence.quote.trim().length < 12) continue;
    const candidates = sources.filter(source => source.id === evidence.source || evidence.source === "context" || evidence.source === "content");
    let ambiguous = false;
    const matches = candidates.flatMap(source => {
      const offset = source.text.indexOf(evidence.quote);
      if (offset < 0) return [];
      if (source.text.indexOf(evidence.quote, offset + 1) >= 0) { ambiguous = true; return []; }
      const start = source.text.slice(0, offset).split("\n").length;
      const end = start + evidence.quote.split("\n").length - 1;
      const startLine = source.lineNumbers?.[start - 1] ?? start;
      const endLine = source.lineNumbers?.[end - 1] ?? end;
      if (source.lineNumbers && source.lineNumbers.slice(start - 1, end).some((line, index) => line !== startLine + index)) return [];
      const safeRepo = source.repo && /^[\w.-]+\/[\w.-]+$/.test(source.repo) && source.repo.split("/").every(part => part !== "." && part !== "..");
      const safeCommit = source.commit && /^[a-f0-9]{40}$/i.test(source.commit);
      const safePath = !/^(?:\/|[A-Za-z]:)/.test(source.path) && !source.path.includes("\\") && !source.path.split("/").some(part => part === "." || part === "..");
      const url = safeRepo && safeCommit && safePath ? `https://github.com/${source.repo}/blob/${source.commit}/${source.path.split("/").map(encodeURIComponent).join("/")}#L${startLine}-L${endLine}` : undefined;
      return [{ sourceId: source.id, path: source.path, startLine, endLine, url }];
    });
    // Ambiguous quotes never get an invented file/line citation.
    if (!ambiguous && matches.length === 1 && !locations.some(item => item.path === matches[0].path && item.startLine === matches[0].startLine)) locations.push(matches[0]);
  }
  return locations;
}

export function findingIdentity(finding: ReviewFinding, locations: EvidenceLocation[]) {
  const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  // Code-point order keeps identities identical across server/browser locales.
  const paths = [...new Set(locations.map(location => location.path))].sort((a, b) => {
    if (a === b) return 0;
    return a < b ? -1 : 1;
  });
  return JSON.stringify([normalize(finding.title), paths, paths.length ? "" : normalize(finding.evidence[0]?.quote ?? finding.recommendation)]);
}

export function compareFindings(current: TrackedFinding[], baseline: TrackedFinding[]): TrackedFinding[] {
  const before = new Set(baseline.map(item => item.fingerprint));
  const after = new Set(current.map(item => item.fingerprint));
  return [
    ...current.map(item => ({ ...item, change: before.has(item.fingerprint) ? "recurring" as const : "new" as const })),
    ...baseline.filter(item => !after.has(item.fingerprint)).map(item => ({ ...item, change: "not_reported" as const })),
  ];
}

/** Turn changed head-side hunks into source documents with the original line numbers. */
export function diffSourceDocuments(diff: string, repo: string, commit: string): SourceDocument[] {
  const documents: SourceDocument[] = [];
  let source: SourceDocument | undefined;
  let lineNumber = 0;
  let lines: string[] = [];
  const flush = () => { if (source && lines.length) documents.push({ ...source, text: lines.join("\n") }); lines = []; };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) { flush(); source = undefined; lineNumber = 0; }
    if (line.startsWith("+++ b/")) {
      const path = line.slice(6).trim();
      source = { id: `file:${path}`, path, text: "", repo, commit, lineNumbers: [] };
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { lineNumber = Number(hunk[1]); continue; }
    if (source && lineNumber > 0 && (line.startsWith("+") || line.startsWith(" "))) {
      lines.push(line.slice(1)); source.lineNumbers!.push(lineNumber++);
    }
  }
  flush();
  return documents;
}
