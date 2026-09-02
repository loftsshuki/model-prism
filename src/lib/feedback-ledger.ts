// CLI-side feedback ledger (JSONL, cwd-relative like the other ledgers). The web
// app stores votes in Postgres; the CLI stores them here so `model-value` can
// weight the leaderboard offline. Both feed the same summarizeFeedback().
import * as fs from "fs";
import * as path from "path";
import type { FeedbackLedgerRecord } from "./feedback";

export const FEEDBACK_LEDGER_PATH = path.join(process.cwd(), ".model-prism", "feedback.jsonl");

export function appendFeedback(record: FeedbackLedgerRecord, pathOverride?: string): void {
  const p = pathOverride ?? FEEDBACK_LEDGER_PATH;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(record) + "\n");
}

export function loadFeedbackLedger(pathOverride?: string): FeedbackLedgerRecord[] {
  const p = pathOverride ?? FEEDBACK_LEDGER_PATH;
  if (!fs.existsSync(p)) return [];
  const out: FeedbackLedgerRecord[] = [];
  for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
  }
  return out;
}
