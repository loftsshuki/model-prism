# Model Prism Operations Guide

## Local development

```bash
npm run dev
```

Open `http://localhost:3000`.

## Build and test

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

`npm test` uses `scripts/run-bun-tests.mjs` to find a Bun executable. If needed, set `BUN_BIN=/path/to/bun`.

## Required services

### OpenRouter

Used for model council fan-out. Store the key from the Settings page.

### Anthropic

Used by the web app for synthesis. Store the key from the Settings page. Brief enhancement and the CLI pipeline bill to OpenRouter instead.

### Neon/Postgres

Used for run history. Configure:

```env
DATABASE_URL=postgres://...
```

## Optional API protection

If the app is deployed where other people can access it, set:

```env
MODEL_PRISM_ADMIN_TOKEN=long-random-token
```

Then enter the same token in the web Settings page. Protected routes require the `x-model-prism-token` header.

Protected routes:

- `GET /api/runs`
- `POST /api/runs`
- `GET /api/runs/:id`
- `POST /api/save-response`
- `POST /api/synthesize`
- `POST /api/synthesize/save`
- `GET/POST /api/telemetry`
- `GET/POST /api/plan-status`
- `GET/POST /api/hook-jobs`

If `MODEL_PRISM_ADMIN_TOKEN` is not set, routes remain open for local/internal use.

## CLI plan review

Single plan:

```bash
npm run review -- path/to/repo/docs/plans/2026-01-01-example.md
```

Dry run:

```bash
npm run review -- path/to/repo/docs/plans/2026-01-01-example.md -- --dry-run
```

Batch folder:

```bash
npm run review -- path/to/repo/docs/plans -- --batch
```

Council upgrades (see README "Council upgrades" for the full table): `--structured`, `--lenses`, `--debate`, `--adaptive`, `--tiered`, `--resume`, `--synthesize-only`, `--no-cache`, `--no-ground-truth`. Persisted council responses live under `<plan dir>/reviews/<plan>/<hash>.responses.json`; the response cache under `.model-prism/cache`.

Recommended safety flags for automated hooks:

```bash
npm run review -- <plan.md> -- --roster default --max-cost-per-plan 6.00 --min-successful-models 6
```

## Rosters

Roster source of truth:

```text
src/lib/rosters.ts
```

Freshness checker:

```bash
npm run check-roster
```

Use the GitHub Actions roster freshness workflow to catch:

- dead model IDs
- price drift
- newer same-family models

## LuxuryApartments plan-review-cycle

`LuxuryApartments` opts in with:

```text
<consumer-repo>/.modelprismrc
```

When an agent writes a matching plan, the global hook runs Model Prism and writes the reviewed output back to the plan workflow.

Operational caution:

- Keep the live model-prism checkout the hook points at on the intended branch.
- After merging roster/hook changes, ensure the checkout used by hooks has been updated.
- `TRACKING.md` should mention any required post-merge checkout reconciliation.

## Legacy routes

The app currently uses direct browser calls for long-running model requests:

- OpenRouter fan-out via `src/lib/fan-out.ts`
- Anthropic synthesis via `src/lib/synthesis.ts`

Legacy server-side routes still exist for compatibility:

- `POST /api/invoke-model`
- `POST /api/synthesize`

Do not delete them until production usage is confirmed to be zero.

## Web telemetry and hook jobs

Web telemetry is stored in Postgres in `run_telemetry` and powers `/models` plus `/hooks`.

Hook workers can update dashboard state with:

```http
POST /api/hook-jobs
x-model-prism-token: <token if configured>
content-type: application/json

{
  "id": "stable-job-id",
  "planFile": "docs/plans/my-plan.md",
  "status": "pending | running | completed | failed",
  "runId": "optional-run-id",
  "cost": 0.42,
  "models": ["model-a", "model-b"],
  "error": "optional failure text",
  "logs": "optional log excerpt"
}
```

CLI plan reviews still keep an offline JSONL ledger via `src/lib/telemetry-ledger.ts` for `npm run model-value`.

## Routine maintenance

Weekly or before important plan reviews:

```bash
npm run check-roster
npm test
npm run build
```

Before public deployment:

1. Set `DATABASE_URL`.
2. Set `MODEL_PRISM_ADMIN_TOKEN`.
3. Verify Settings can save the admin token.
4. Confirm History still loads.
5. Confirm new runs save responses, synthesis, telemetry, and plan status.
6. Confirm `/models` and `/hooks` load.
7. Confirm no sensitive keys are committed.
8. Confirm GitHub Actions CI passes.
