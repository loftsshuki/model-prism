# Model Prism — Codex operating rules

## Portfolio Context Fabric bootstrap

Before portfolio-wide work, request bounded task context with HOSS `hoss_get_context` (or its API/CLI equivalent) for `model-prism`; inspect current `master` and open PRs. Model Prism owns its review engine and MCP service. Reuse HOSS orchestration and Decision Fabric, and Brain reviewed knowledge; do not create duplicate generic portfolio systems. After implementation, submit a Context Fabric receipt and corrections/feedback through the HOSS interfaces. A receipt is an agent attestation, not canonical knowledge or deployment proof.

Next.js model-evaluation and review app. Keep work scoped and evidence-driven.

## Usage discipline
- Start from the smallest plausible file/symbol/path. Search before broad reads.
- Do not reread files already summarized unless later changes require it.
- Keep the main model for architecture, ambiguous reasoning, integration decisions, and final review.
- Do not spawn subagents for simple work. Use `explorer` for bounded read-only discovery, `worker` for a small already-understood patch, and `reviewer` for changed-file review.
- Keep at most two subagents active; prefer one.
- Successful tool output should be one-line/compact. Preserve only actionable diagnostics on failure.
- Run the narrowest relevant check first. Do not run `npm run verify` or browser tests unless the changed surface warrants it or the user asks.
- Final responses should normally contain only changed files, verification, and blockers.
- For long/interrupted work, maintain a tiny `.codex/TASK_STATE.md` with Done / Current / Next / Blocked only.

## Commands
- `npm run lint`
- `npm test`
- `npm run build`
- `npm run test:browser`
- `npm run verify`

## Framework
This repo uses Next.js 16.3.x. Check the installed package/version and current project docs before applying non-obvious framework patterns from memory.

## Context router

Before broad repository exploration, read `.codex/ROUTER.md` and open only the referenced files needed for the task. If RTK is already installed, follow `.codex/RTK.md` for terminal-heavy work.
