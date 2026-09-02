// Human feedback on findings.
//
// The model-value leaderboard scores models by how many "unique insights" the
// synthesizer attributed to them — a proxy graded by another model, which is
// circular. A thumbs up/down per finding is the first non-model signal. Votes are
// keyed by the stable finding id and carry the models that raised the finding, so
// they can be rolled up per model and used to weight the leaderboard.

export interface FeedbackVote {
  finding_id: string;
  models: string[];
  vote: number; // +1 | -1
  section?: string | null;
}

export interface ModelFeedbackScore {
  model: string;
  up: number;
  down: number;
  /** Laplace-smoothed approval in [0,1]; 0.5 when there are no votes. */
  approval: number;
  votes: number;
}

export function summarizeFeedback(votes: FeedbackVote[]): Record<string, ModelFeedbackScore> {
  const out: Record<string, ModelFeedbackScore> = {};
  for (const v of votes) {
    for (const model of v.models ?? []) {
      const row = (out[model] ??= { model, up: 0, down: 0, approval: 0.5, votes: 0 });
      if (v.vote > 0) row.up++; else row.down++;
      row.votes++;
    }
  }
  for (const row of Object.values(out)) {
    row.approval = (row.up + 1) / (row.votes + 2);
  }
  return out;
}

/**
 * Multiplier applied to a model's value score: 1.0 with no votes, up to 1.5 for a
 * consistently up-voted model, down to 0.5 for a consistently down-voted one. The
 * effect grows with vote count so a single click cannot swing the ranking.
 */
export function feedbackWeight(score: ModelFeedbackScore | undefined): number {
  if (!score || score.votes === 0) return 1;
  const confidence = Math.min(1, score.votes / 10);
  return 1 + (score.approval - 0.5) * confidence;
}

/** JSONL line shape written by the CLI (`npm run feedback`) and read by model-value. */
export interface FeedbackLedgerRecord extends FeedbackVote {
  ts: string;
  plan?: string;
  claim?: string;
  note?: string;
}
