// Prompt-size budgeting.
//
// The synthesis stages used to hard-truncate the ORIGINAL document to 4,000 chars
// (legacy synth), 8,000 (fusion judge) and 6,000 (fusion synthesizer) — silently.
// For a 40 KB architecture plan the judge adjudicated claims about a document it
// saw 20% of. Opus-class models have ≥200k-token windows, so the draft is the
// last thing that should be cut; when a cap is genuinely needed it is now large,
// shared, and leaves a visible marker instead of a bare "...".

/** ~50k tokens. Generous for any single plan; keeps a runaway paste from blowing a window. */
export const PROMPT_DOC_CHAR_LIMIT = 200_000;

/** Rough token estimate (≈4 chars/token). */
export function estimatePromptTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Clip `text` to `maxChars`, appending an explicit marker with the amount removed.
 * Returns the text unchanged when it fits. Optional `label` names what was cut.
 */
export function clipForPrompt(text: string, maxChars: number = PROMPT_DOC_CHAR_LIMIT, label = "document"): string {
  if (text.length <= maxChars) return text;
  const removed = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[... ${label} truncated: ${removed.toLocaleString()} characters omitted to fit the prompt budget ...]`;
}
