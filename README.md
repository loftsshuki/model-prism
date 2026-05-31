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
- Loads GitHub PR diffs into the code-review flow
- Adds plan approval status/frontmatter and a hook dashboard
- Warns before runs exceed a configured cost budget
- Falls back from flaky free models to reliable paid equivalents
- Synthesizes results with Claude Sonnet or Opus
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

For local browser use, keys are saved in browser localStorage from the Settings page:

- OpenRouter API key: used for council fan-out
- Anthropic API key: used for synthesis and context-pack brief enhancement
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

Legacy compatibility routes:

- `POST /api/invoke-model` — older server-side OpenRouter invocation path
- `POST /api/synthesize` — older server-side synthesis path

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
