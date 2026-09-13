# Model Prism

Model Prism is a multi-model review and synthesis tool. Give it one prompt or plan, fan it out to a council of models through OpenRouter, then synthesize the best findings into a structured master document through the same OpenRouter account.

It is used both as:

- a web app for interactive multi-model analysis
- a CLI for plan reviews, including the LuxuryApartments plan-review-cycle hook

## What it does

- Runs one input against multiple OpenRouter models
- Supports curated `balanced`, `frontier`, `cheap`, and `auto` council rosters
- Provides project profiles for repeatable defaults
- Provides run presets for common review modes
- Measures traceable evidence coverage and extracts copyable action checklists (no invented accuracy score)
- Supports a second-pass critique of the synthesis
- Records database-backed telemetry for a model leaderboard, failure diagnostics, and roster recommendations
- Provides context-pack templates and local file/folder context
- Loads GitHub PR diffs into the code-review flow and exports GitHub-ready review markdown
- Adds database-backed plan approval status/frontmatter and a live hook dashboard
- Reserves request costs before dispatch and enforces per-run/per-plan and batch spending limits
- Optionally replaces unavailable free models with paid equivalents within the budget
- Synthesizes results with Claude Sonnet 5, Opus 5, or Fable 5.1
- Stores run history in Neon/Postgres when configured
- Supports GitHub Context Packs for read-only codebase context
- Exports prior runs as Markdown
- Provides CLI plan review with cost/quorum safeguards

## Quick start

```bash
cd C:/Dev/Tools/model-prism
npm install
npm run dev
```

Open:

```text
http://localhost:3000
```

## Required keys

Connect your key in the app or Settings. OpenRouter keys are session-only unless you choose Remember on this device (unencrypted localStorage).

- OpenRouter API key: used for council, synthesis, judge, and brief enhancement. A second provider key is unnecessary.
- GitHub PAT: optional, used for private-repo Context Packs
- Admin token: optional, only needed when `MODEL_PRISM_ADMIN_TOKEN` is set on the server

## Environment variables

Server-side storage uses Neon/Postgres:

```env
DATABASE_URL=postgres://...
```

Optional API protection for history/save routes:

```env
MODEL_PRISM_ADMIN_TOKEN=choose-a-long-random-token
```

When `MODEL_PRISM_ADMIN_TOKEN` is set, users must enter the same value in Settings so requests include `x-model-prism-token`.

## Scripts

```bash
npm run dev           # Next dev server
npm run build         # Production build
npm run lint          # ESLint
npm test              # Bun unit tests via Windows-safe wrapper
npm run review        # CLI plan review
npm run check-roster  # Check every model role against OpenRouter
npm run refresh-models # Refresh prices/capabilities for reviewed IDs
npm run test:browser  # Browser regressions (after npm run build)
npm run evaluate      # Describe opt-in evaluation fixtures
npm run model-value   # Model value/telemetry analysis
```

If Bun resolution fails, set:

```bash
BUN_BIN=C:/Users/shuki/.bun/bin/bun.exe npm test
```

## CLI plan review

```bash
npm run review -- docs/plans/my-plan.md
```

Useful options:

```bash
npm run review -- docs/plans -- --batch
npm run review -- docs/plans/my-plan.md -- --dry-run
npm run review -- docs/plans/my-plan.md -- --roster cheap
npm run review -- docs/plans/my-plan.md -- --roster auto
npm run review -- docs/plans/my-plan.md -- --max-cost-per-plan 1.00
```

The CLI writes review files next to plans under `reviews/` by default.

## Council rosters

Rosters live in:

```text
src/lib/model-catalog.ts
```

Current presets:

- `balanced` / `default` — five complementary reviewers: GPT-5.6 Sol, Gemini 3.8 Flash, DeepSeek V4.1 Flash, MiniMax M3, GLM 5.3 Flash
- `frontier` — GPT-6 Astra, Gemini 3.8 Flash, Grok 4.6, Qwen3.8 Max, Kimi K3
- `cheap` — lower-cost bulk review council
- `auto` — chooses cheap/frontier based on plan size and `criticality:` frontmatter

Run freshness checks with:

```bash
npm run check-roster
```

## Context Packs

Context Packs let models review prompts with selected GitHub repo files as read-only context.

Safety behavior:

- blocks obvious secret files like `.env`, private keys, npmrc, credentials files
- filters junk directories such as `node_modules`, `.git`, `.next`, `dist`
- scans fetched file contents for secret-like patterns
- caches file contents in IndexedDB, not localStorage

## API routes

Active routes:

- `GET /api/models` — fetch/filter OpenRouter model catalog
- `GET /api/runs` — list saved runs
- `PUT /api/runs/:id` — idempotent private checkpoint with frozen input, response states, and usage ledger
- `POST /api/runs` — legacy saved-run creation
- `GET /api/runs/:id` — load saved run
- `POST /api/save-response` — save model response
- `POST /api/synthesize/save` — save direct-browser synthesis result

Legacy compatibility routes:

- `POST /api/invoke-model` — older server-side OpenRouter invocation path
- `POST /api/synthesize` — older server-side synthesis path

The main app currently calls OpenRouter directly from the browser to avoid Vercel function duration limits.

## Plan-review-cycle integration

Repos can opt into automatic plan review with `.modelprismrc`:

```json
{
  "planReview": true
}
```

The global hook watches plan writes and calls the Model Prism CLI. See:

```text
docs/OPERATIONS.md
```

## Security notes

- Do not deploy publicly without setting `MODEL_PRISM_ADMIN_TOKEN` if run history is sensitive.
- Browser-stored keys are convenient for local/internal use, but they are not ideal for multi-user public deployments.
- Context Packs intentionally block common credential files and secret-looking contents.
- The legacy server-side routes remain for compatibility but should be removed once confirmed unused.

## Freshness, resumption, and spending

The reviewed catalog snapshot was refreshed on 2026-09-13. Browser runs and the CLI verify live availability before paid execution. The daily GitHub check covers all council, synthesis/judge, enhancement, and fallback IDs; price and capability changes are reported separately from advisory successor candidates. It does not replace a working model automatically. GitHub may disable schedules on inactive public repositories; CI and run preflight provide additional checks.

Completed answers persist in IndexedDB and in private cloud checkpoints. Reopen the app and choose Restore, or Resume from History. Changing content, instructions, context, or reasoning creates a new run. Increasing the output budget retries incomplete answers; completed answers are retained. Closing the tab interrupts browser execution; resumption requires reopening it. These are checkpoints, not background workers.

New cloud checkpoints are scoped to a capability derived from the OpenRouter key; the provider key is not sent to the persistence server. Connecting the same key on another device restores access. Treat this capability like a password. Existing legacy records retain their prior access rules; set MODEL_PRISM_ADMIN_TOKEN to restrict those routes. Rotating a provider key changes the derived cloud identity, so export reviews before changing keys if you need to retain portable access.

Spending records prefer provider-reported usage.cost. Where absent, the app labels estimates; interrupted requests with unknown charges retain a conservative request reservation. Every retry has its own entry, including failed synthesis or judge attempts. Concurrent requests reserve their ceilings before dispatch. Stop cancels queued work, request streams, and retry waits; providers may continue billing an already accepted request briefly. Budgets apply to one active execution; avoid resuming the same checkpoint simultaneously on multiple devices.

The CLI stores an adjacent .state.json checkpoint, resumes matching inputs, and preserves partial results when synthesis fails. --force explicitly starts a fresh council. --max-cost limits the batch including shared context enhancement; --max-cost-per-plan limits each plan. Enhancement is cached by source content and model to avoid charging again for an unchanged brief.

## Model evaluation

Run npm run evaluate -- --live --max-cost 0.50 --out evaluation.json to compare the balanced council on three small code fixtures. This costs OpenRouter credits and requires OPENROUTER_API_KEY. Results include exact outputs, completion status, latency, and the full spending ledger. These fixtures detect obvious regressions; use representative project reviews before changing the curated roster. No general quality ranking is inferred from model price, release date, or agreement.
