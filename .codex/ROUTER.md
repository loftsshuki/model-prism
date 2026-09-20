# Codex router

Read before broad exploration; open only what the task needs.

- App/routes/UI → locate the affected Next.js route/component first
- Evaluation/review workflow → search `review`, `evaluate`, and workflow call sites before broad reads
- Model catalog/refresh → `scripts/refresh-model-catalog.ts` and related model data
- Account/background persistence → `scripts/verify-account-store.ts`, `scripts/verify-background-store.ts`, and their imported stores
- Workflow verification → `scripts/verify-workflow.mjs`
- Commands/dependencies → `package.json`
- Browser tests → Playwright config/tests only when the affected flow requires them
- Usage/tooling → `.codex/RTK.md` and `.codex/USAGE.md`

Avoid `npm run verify` for a narrow change unless its full gate is actually required.
