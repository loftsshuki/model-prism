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
- Tracks accepted, dismissed, and fixed findings across reviews, with exact file/line citations where supplied evidence permits
- Reports human-confirmed findings, explicit false positives, cost per useful finding, and separate model-assessed diagnostics
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
- Runs durable background reviews that continue when a tab closes, with a database-enforced spending ledger and explicit stop/resume
- Offers an opt-in adaptive council: three initial reviewers, escalation for unresolved concerns, and a full council for high-risk work
- Checks model freshness daily on Vercel, independently of GitHub Actions

Live app: [model-prism.vercel.app](https://model-prism.vercel.app).

Clerk accounts keep private history independent of your OpenRouter key. Sign in, then use **Settings → Check previous key history → Import into this account** to move reviews saved with your old key. Imports preserve decisions and revoke access through the old capability. Legacy unowned records require selected, operator-verified recovery; they are never assigned to the first person who signs in. See [account setup and recovery](docs/ACCOUNTS.md).

## Quick start

```bash
cd C:/Dev/Tools/model-prism
npm ci
npm run dev
```

Open:

```text
http://localhost:3000
```

## Required keys

Connect your key in the app or Settings. OpenRouter keys are session-only unless you choose Remember on this device (unencrypted localStorage).

Background reviews temporarily encrypt the key on the server with AES-256-GCM, bound to the review owner and execution. The key is omitted from workflow inputs, outputs, and saved results. It is cleared when a run ends; expired keys are unusable after 24 hours and are removed by the daily cleanup. Browser-only review remains available.

- OpenRouter API key: used for council, synthesis, judge, and brief enhancement. A second provider key is unnecessary.
- GitHub PAT: optional, used for private-repo Context Packs
- Admin token: optional, only needed when `MODEL_PRISM_ADMIN_TOKEN` is set on the server

## Environment variables

Server-side storage uses Neon/Postgres:

```env
DATABASE_URL=postgres://...
MODEL_PRISM_ENCRYPTION_KEY=<64 hexadecimal characters from a cryptographic random generator>
CRON_SECRET=<a separate random secret>
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
npm run verify        # Lint, unit tests, production dependency audit, build
npm run verify:database # Real database concurrency/ownership checks; removes synthetic records
npm run verify:workflow # Local mobile browser -> durable workflow -> database; mock provider, no model spend
npm run lint          # ESLint
npm test              # Bun unit tests via Windows-safe wrapper
npm run review        # CLI plan review
npm run check-roster  # Check every model role against OpenRouter
npm run refresh-models # Refresh prices/capabilities for reviewed IDs
npm run test:browser  # Browser regressions (after npm run build)
npm run evaluate      # Describe opt-in evaluation fixtures
npm run model-value   # Model value/telemetry analysis
```

Use npm and `package-lock.json` to install dependencies. Bun is only the test runner. The old Bun lockfile was removed because the installed Bun version ignores the scoped dependency overrides needed for patched Workflow dependencies. A clean Linux `npm ci` is verified alongside Windows development.

Vercel runs `npm run verify` before deployment. Its daily authenticated cron checks availability, price/capability drift, and newer-model candidates; results appear on **Models**. It never silently changes the curated model IDs. The existing GitHub CI and freshness workflow remain available when GitHub account billing permits them to run.

The evaluation suite has 20 scoped cases: 16 pinned excerpts from this repository's actual before/after fixes and four controls. Run a bounded individual evaluation or compare fixed/adaptive councils:

```bash
npm run evaluate -- --live --models google/gemini-3.5-flash-lite --limit 2 --max-cost 0.05 --out evaluation.json
npm run evaluate -- --live --mode compare --roster balanced --max-cost 2 --out council-comparison.json
```

Reports include precision, recall, false positives, invalid/incomplete outputs, latency, and cost per supported finding. An explicit spending limit is required. This scoped regression suite does not establish general model quality; confirmed feedback from real project reviews remains essential. No adaptive council replaces the fixed default without a completed benchmark.

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

- Private history, findings, telemetry, and hook jobs require a verified account session or an unclaimed legacy capability. `MODEL_PRISM_ADMIN_TOKEN` can add a deployment-wide access restriction.
- Browser-stored keys are convenient for local/internal use, but they are not ideal for multi-user public deployments.
- Context Packs intentionally block common credential files and secret-looking contents.
- The legacy server-side routes remain for compatibility but should be removed once confirmed unused.

## Freshness, resumption, and spending

The reviewed catalog snapshot was refreshed on 2026-09-19. Browser runs, background jobs, and the CLI verify live availability before paid execution. Daily Vercel and GitHub checks cover all council, synthesis/judge, enhancement, and fallback IDs; price and capability changes are reported separately from advisory successor candidates. They do not replace a working model automatically. Vercel's independent check continues if GitHub Actions is unavailable.

Completed answers persist in private cloud checkpoints, with local checkpoints for browser execution. Reopen the app and choose Restore, or Resume from History. Changing content, instructions, context, reasoning, or project creates a new run. Increasing the output budget retries incomplete answers; completed answers are retained. Background reviews continue after closing the tab. Browser-only reviews require reopening the app to resume interrupted work.

Signed-in checkpoints belong to a stable Clerk account; changing provider keys does not change access to that history. Signed-out compatibility access uses the capability derived from the OpenRouter key until it is imported in Settings. Treat that capability like a password. Background execution temporarily stores a separately encrypted provider key as described above. Unowned legacy records remain hidden until an operator verifies ownership and recovers selected records. Signing out clears provider keys and cached review/source data from this device.

External hook workers must send `x-model-prism-owner` on jobs, telemetry, and run requests. Its value is lowercase hexadecimal SHA-256 of the UTF-8 string `model-prism-cloud-v1:` followed by the OpenRouter key (with no whitespace or newline). This matches the browser's private history identity without putting the provider key in persistence headers. If configured, also send `x-model-prism-token` containing the deployment's admin token. Keep both capabilities secret.

Spending records prefer provider-reported `usage.cost`. Where absent, the app labels estimates; interrupted requests with unknown charges retain a conservative request reservation. Every retry has its own entry, including failed synthesis or judge attempts. Concurrent requests reserve their ceilings before dispatch. Stop cancels queued work, request streams, and retry waits; providers may continue billing an already accepted request briefly. Background budgets apply cumulatively to the saved review, including resumes, and database locks coordinate multiple devices. Browser-only executions use a local ledger; avoid running the same browser checkpoint simultaneously on multiple devices.

The CLI stores an adjacent .state.json checkpoint, resumes matching inputs, and preserves partial results when synthesis fails. --force explicitly starts a fresh council. --max-cost limits the batch including shared context enhancement; --max-cost-per-plan limits each plan. Enhancement is cached by source content and model to avoid charging again for an unchanged brief.

## Model evaluation

Run `npm run evaluate` for a free dry run of the 20-case repository regression dataset. To compare fixed and adaptive councils, use `npm run evaluate -- --live --mode compare --max-cost 0.50 --out evaluation.json`. Live evaluation costs OpenRouter credits and requires `OPENROUTER_API_KEY`; the shared limit can stop before every case runs. Reports include precision/recall against case-specific ground truth, exact outputs, completion status, latency, and the full spending ledger. These fixtures detect scoped regressions; use representative project reviews before changing the curated roster. No general quality ranking is inferred from model price, release date, or agreement.
