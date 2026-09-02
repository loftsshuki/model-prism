# Model Prism

Model Prism is a multi-model review and synthesis tool. Give it one prompt or plan, fan it out to a council of models through OpenRouter, then synthesize the best findings into a structured master document with Anthropic Claude.

It is used both as:

- a web app for interactive multi-model analysis
- a CLI for plan reviews, including the LuxuryApartments plan-review-cycle hook

## What it does

- Runs one input against multiple OpenRouter models
- Supports curated `frontier`, `cheap`, and `auto` council rosters
- Provides project profiles for repeatable defaults
- Provides run presets for common review modes
- Scores synthesis quality and extracts copyable action checklists
- Supports a second-pass critique of the synthesis
- Records database-backed telemetry for a model leaderboard, failure diagnostics, and roster recommendations
- Provides context-pack templates and local file/folder context
- Loads GitHub PR diffs into the code-review flow and exports GitHub-ready review markdown
- Adds database-backed plan approval status/frontmatter and a live hook dashboard
- Warns before runs exceed a configured cost budget
- Falls back from flaky free models to reliable paid equivalents
- Synthesizes results with Claude Sonnet or Opus
- Stores run history in Neon/Postgres when configured
- Supports GitHub Context Packs for read-only codebase context
- Exports prior runs as Markdown
- Provides CLI plan review with cost/quorum safeguards

## Quick start

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:3000
```

## Required keys

For local browser use, keys are saved in browser localStorage from the Settings page:

- OpenRouter API key: used for council fan-out and context-pack brief enhancement
- Anthropic API key: used for synthesis in the web app (the CLI synthesizes through OpenRouter instead)
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
npm run check-roster  # Check OpenRouter roster freshness
npm run model-value   # Model value/telemetry analysis
```

Also available: `npm run typecheck`. If Bun resolution fails, set `BUN_BIN=/path/to/bun`.

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
npm run review -- docs/plans/my-plan.md -- --max-cost-per-plan 2.00
npm run review -- docs/plans/my-plan.md -- --prism-mode fusion
```

The per-plan cap covers council spend plus the projected merge cost (one call for legacy, two for fusion). `--max-cost` caps a whole batch.

The CLI writes review files next to plans under `reviews/` by default.

## Council upgrades

The council does more than fan out prose now. Each of these is a flag on `npm run review` (or a Settings toggle in the web app), and each is measured rather than assumed:

| Capability | Flag | What it does |
|---|---|---|
| Structured findings | `--structured` (default in fusion) | Every member returns discrete findings via a tool call: claim, severity, category, verbatim evidence, fix, stable id. |
| Computed consensus | automatic with structured | Findings are clustered across members by claim similarity and weighted by distinct model family. The judge is given the counts as facts. |
| Ground truth | on by default, `--no-ground-truth` | Zero-cost pre-check: every path, symbol, table and env var the plan names is verified against the repo. Missing ones are flagged to every model and mark findings as unverified. |
| Lenses | `--lenses` | Security, data and migrations, performance, testing, product, operations, correctness assigned round-robin across families. |
| Cross-examination | `--debate` (fusion) | Models on each side of a contested point defend, concede or refine with evidence before the synthesizer runs. |
| Adaptive stop | `--adaptive` | Stops launching paid members once the last three responses added no new finding clusters. |
| Tiered review | `--tiered` | Runs the cheap council first and escalates to the selected roster only on critical or high findings with multi-family support, or a high-risk plan. |
| Response cache | on by default, `--no-cache` | Content-addressed cache in `.model-prism/cache`: an unchanged (model, prompt, plan, context) tuple is never paid for twice. |
| Resume | `--resume`, `--synthesize-only` | Council responses are persisted next to the review; a failed merge, quorum miss or cap trip can be retried without re-running the council. |
| Since last review | automatic with structured | Findings keep stable ids, so a re-review reports resolved, new and persisting items. |
| Findings export | automatic with structured | `<review>.findings.json` beside the review, consumed by `npm run post-pr-review` to post inline GitHub PR comments. |
| Similarity | automatic | Pairwise response similarity per run; `npm run model-value` lists model pairs that are redundant across runs. |
| Feedback | `npm run feedback`, thumbs in the web app | Votes per finding, keyed by stable id, weight the model-value leaderboard. |
| Eval harness | `npm run eval` | Golden plans with seeded flaws; recall, precision, cost and latency per roster and mode. `--mock` runs offline. |
| Server-side runs | `POST /api/jobs` | Durable review jobs advance one step per invocation on a cron worker; runs survive closed tabs and redeploys. |

Recommended everyday invocation:

```bash
npm run review -- docs/plans/x.md -- --prism-mode fusion --lenses --debate --adaptive
```

## Council rosters

Rosters live in:

```text
src/lib/rosters.ts
```

Current presets:

- `frontier` / `default` — quality-first council
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
- `POST /api/runs` — create saved run
- `GET /api/runs/:id` — load saved run
- `POST /api/save-response` — save model response
- `POST /api/synthesize/save` — save direct-browser synthesis result
- `GET/POST /api/telemetry` — model-value leaderboard and run telemetry
- `GET/POST /api/plan-status` — plan approval status per run
- `GET/POST /api/hook-jobs` — plan-review hook job dashboard

Legacy compatibility routes (both require the admin token when one is set):

- `POST /api/invoke-model` — older server-side OpenRouter invocation path
- `POST /api/synthesize` — older server-side synthesis path

All POST routes validate their bodies and return `400` with the offending field; server failures return a generic `500`.

The main app currently calls OpenRouter/Anthropic directly from the browser to avoid Vercel function duration limits.

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

## Server-side runs

A run can also be executed entirely on the server so it survives closed tabs, function timeouts and redeploys. A job row in `review_jobs` holds the input and a JSON `step` (`pending`/`done`/`failed` model ids and the current `phase`); every worker invocation claims one job, advances it **one step**, writes the progress back, and re-schedules itself.

Env vars:

- `OPENROUTER_API_KEY` — server key the worker bills council, judge and synthesis calls to (the browser never sends a key for server-side runs; a missing key fails the job with a clear error).
- `CRON_SECRET` — accepted by the worker as `Authorization: Bearer <secret>` (what Vercel cron sends) or `x-cron-secret`; also used for the worker's self-kick.
- `MODEL_PRISM_ADMIN_TOKEN` — gates `POST/GET /api/jobs`, `GET /api/jobs/:id`, `POST /api/jobs/:id/cancel`, and is accepted by the worker as an alternative to the cron secret.
- `MODEL_PRISM_BASE_URL` — optional; the origin the self-kick calls on non-Vercel hosts (on Vercel `VERCEL_URL` is used; request headers are deliberately not trusted).

How a job advances (`src/lib/jobs.ts`):

1. `POST /api/jobs` `{ content, prompt, models | roster, mode?, context? }` creates the `runs` row and a `queued` job, then fires a non-blocking kick at the worker.
2. `POST|GET /api/jobs/work` claims the oldest unleased active job (`locked_until` lease of 5 minutes, single atomic `UPDATE … SKIP LOCKED`) and runs one phase within a 240 s budget:
   - **council** — invokes pending models in batches (2 paid, or 1 free), saves each response to `responses`, keeps going until the budget tail; leftover models stay `pending` for the next invocation. When none remain the phase becomes `judge` (fusion) or `synth` (legacy).
   - **judge** (fusion) — feeds the saved responses to the judge and stashes its output in `step.judge`.
   - **synth** — legacy or fusion synthesis, saved to `syntheses`; the job is `completed` and `/runs/:runId` shows it like any other run.
3. A thrown step is recorded (`attempts++`, `error`) and retried by the next invocation; after 3 failures the job is `failed`. Cancel via `POST /api/jobs/:id/cancel` (checked between council batches).
4. If the job is not finished, the worker kicks itself again; the Vercel cron (`* * * * *`, `vercel.json`) is the fallback that resumes anything a timeout or redeploy interrupted.

Trigger the worker manually:

```bash
curl -X POST "$BASE_URL/api/jobs/work" -H "Authorization: Bearer $CRON_SECRET"
# or with the admin token
curl -X POST "$BASE_URL/api/jobs/work" -H "x-model-prism-token: $MODEL_PRISM_ADMIN_TOKEN"
```

The hooks dashboard (`/hooks`) lists server-side runs with their phase, progress, cost and a Cancel button.
