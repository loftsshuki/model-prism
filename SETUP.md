# Setup

## Prerequisites

- Node 22 (or 20+) and npm
- Bun 1.3+ (unit tests run under `bun test`)
- An OpenRouter API key
- Optional: a Neon/Postgres database for run history and telemetry

## Install

```bash
npm install
cp .env.example .env.local   # fill in DATABASE_URL / MODEL_PRISM_ADMIN_TOKEN as needed
npm run dev
```

Open http://localhost:3000 and add your keys on the Settings page (they stay in the browser's localStorage).

## Database

Run history, syntheses, telemetry and plan statuses live in Postgres via `@neondatabase/serverless`:

```env
DATABASE_URL=postgres://...
```

Tables and indexes are created on first use (`src/lib/db.ts`, `initDb`). Without `DATABASE_URL` the app still runs; saves fail silently and History stays empty.

## Protecting a public deployment

Set `MODEL_PRISM_ADMIN_TOKEN` on the server and enter the same value in Settings. Every history/save/telemetry route then requires the `x-model-prism-token` header. If the variable is unset the routes are open, which is fine locally and logged as a warning in production.

## CLI plan review

```bash
export OPENROUTER_API_KEY=sk-or-v1-...
npm run review -- docs/plans/my-plan.md -- --dry-run
```

See `docs/OPERATIONS.md` for flags, rosters and the plan-review hook.

## Checks

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

`npm test` locates Bun through `scripts/run-bun-tests.mjs`; override with `BUN_BIN=/path/to/bun` if it cannot find it.
