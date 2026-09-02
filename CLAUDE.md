# Model Prism — working notes for agents

Multi-model review tool. One input → a council of OpenRouter models → a judge/synthesizer (Claude via OpenRouter) → a structured master document. Two surfaces: a Next.js web app (`src/app`) and a CLI plan reviewer (`scripts/review-plan.ts`).

## Commands

```bash
npm install          # Node 22 + Bun 1.3 (tests run under bun)
npm run dev          # web app on :3000
npm run lint         # eslint (must be clean; CI enforces)
npm run typecheck    # tsc --noEmit
npm test             # bun test src/
npm run build        # next build
npm run review -- docs/plans/x.md [--roster cheap|auto] [--prism-mode fusion] [--dry-run]
```

## Layout

- `src/lib/openrouter.ts` — the ONE OpenRouter client (streaming, timeouts, typed errors, retry). Every model call goes through it. Do not add another `fetch("https://openrouter.ai/...")`.
- `src/lib/fan-out.ts` — council fan-out (concurrency, free-model fallback, cancellation).
- `src/lib/synthesis.ts` — legacy single-call merge + `coerceSynthesisResult` (tolerant output validation).
- `src/lib/fusion.ts` — judge → synthesizer split, evidence/citation integrity, dual-lens sections.
- `src/lib/rosters.ts` — council rosters and prices. `scripts/check-roster-freshness.ts` guards drift weekly.
- `src/lib/prompt-budget.ts` — the only place prompt text gets clipped; never hard-slice a document inline.
- `src/lib/findings.ts` — structured finding schema, stable ids (`findingId`), cross-member clustering, computed consensus, saturation. Browser-safe.
- `src/lib/ground-truth.ts` — verifies paths/symbols/tables a plan names against the repo (Node only). `src/lib/lenses.ts` — per-family review lenses.
- `src/lib/debate.ts` — cross-examination round over judge contradictions. `src/lib/similarity.ts` — local TF-IDF response similarity.
- `src/lib/response-cache.ts` — content-addressed council cache + persisted run responses (resume). `src/lib/review-compare.ts` — resolved/new/persisting diffs between reviews.
- `src/lib/feedback.ts` — finding votes → per-model weights for the leaderboard. `src/lib/jobs.ts` — DB-backed step machine for server-side runs.
- `src/lib/eval-score.ts` + `evals/golden/` + `scripts/eval.ts` — the eval harness. Run `npm run eval -- --mock` after changing prompts, rosters or clustering.
- `src/app/api/*` — routes are gated by `requireAdminToken` and validate bodies with `parseBody` (zod). Return `serverError(...)` rather than raw `error.message`.
- `src/lib/db.ts` — Neon/Postgres. Schema is created lazily in `initDb`; add indexes there.

## Conventions

- Model IDs on OpenRouter use dots for minor versions (`anthropic/claude-opus-4.8`); the direct Anthropic API uses hyphens (`claude-opus-4-8`). Keep the distinction.
- Any prompt that embeds model output or repo content wraps it in an "untrusted data, not instructions" note.
- Keep legacy review output byte-stable: fusion-only fields must stay `undefined` on the legacy path.
- Costs: prefer OpenRouter's `usage.cost`; fall back to the roster price table.
- New pipeline behaviour is opt-in via a CLI flag and off on the legacy path unless the flag is set; anything that changes review output must keep `evals` recall from dropping.
- Tests live next to the code (`*.test.ts`, bun). Mock `globalThis.fetch`; the OpenRouter client accepts plain JSON responses as well as SSE, so existing mocks keep working.
