#!/usr/bin/env tsx
// Record a thumbs up/down on a finding from a review file, so the model-value
// leaderboard can weight models by human judgement.
//
//   npm run feedback -- --review docs/plans/reviews/x.review.md --finding f_ab12cd34ef56 --vote up [--note "..."]
//   npm run feedback -- --review <file> --list          # show the findings (ids, claims, models) in a review
//
// The models credited for a finding are read from the review's findings section
// (structured mode) so the vote lands on the right leaderboard rows.
import * as fs from "fs";
import * as path from "path";
import { appendFeedback, FEEDBACK_LEDGER_PATH } from "../src/lib/feedback-ledger";
import { parseFindingRefsFromReview } from "../src/lib/review-compare";

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function main(): number {
  const reviewPath = arg("--review");
  if (!reviewPath) {
    console.error("Usage: npm run feedback -- --review <review.md> (--list | --finding <f_id> --vote up|down [--note text])");
    return 2;
  }
  const abs = path.resolve(reviewPath);
  if (!fs.existsSync(abs)) { console.error(`Review not found: ${abs}`); return 2; }
  const markdown = fs.readFileSync(abs, "utf-8");
  const refs = parseFindingRefsFromReview(markdown);

  if (process.argv.includes("--list")) {
    if (refs.length === 0) { console.log("No finding ids in this review (run the CLI with --structured to get them)."); return 0; }
    for (const r of refs) console.log(`${r.id}  [${r.severity}]  ${r.claim.slice(0, 100)}${r.models?.length ? `  (${r.models.join(", ")})` : ""}`);
    return 0;
  }

  const findingId = arg("--finding");
  const voteRaw = arg("--vote");
  if (!findingId || !/^f_[0-9a-f]{12}$/.test(findingId) || !voteRaw || !["up", "down"].includes(voteRaw)) {
    console.error("Need --finding f_<12 hex> and --vote up|down");
    return 2;
  }
  const ref = refs.find((r) => r.id === findingId);
  appendFeedback({
    ts: new Date().toISOString(),
    plan: path.basename(abs),
    finding_id: findingId,
    claim: ref?.claim,
    models: ref?.models ?? [],
    vote: voteRaw === "up" ? 1 : -1,
    section: "finding",
    note: arg("--note") ?? undefined,
  });
  console.log(`Recorded ${voteRaw} for ${findingId}${ref ? ` (${ref.models?.join(", ") || "no models credited"})` : " (finding not found in review; vote stored without model credit)"} → ${path.relative(process.cwd(), FEEDBACK_LEDGER_PATH)}`);
  return 0;
}

process.exit(main());
