# Plan Review Cycle Hook — Auto-Synthesize Every Plan

**Date:** 2026-04-10
**Status:** Built, awaiting self-review via Model Prism
**Scope:** Global (~/.claude/hooks/ + settings.json)

---

## Problem

LuxuryApartments agents (and agents in any repo using Claude Code) write implementation plans to `docs/plans/YYYY-MM-DD-*.md`. These plans are single-author artifacts — one agent's take, with one agent's blind spots. Execution agents then follow these plans verbatim, inheriting whatever gaps the original agent had.

We just built Model Prism and its new review-plan CLI that fans a plan out to 10 diverse free models and synthesizes with Claude Opus. The CLI produces objectively better plans: consensus points, unique insights from minority models, blind spots, disagreements.

The missing piece: **getting every plan through the cycle automatically**, so every plan that reaches an executor is the synthesized version, not the draft.

## Solution

A PostToolUse hook at `~/.claude/hooks/plan-review-cycle.py`, registered globally in `~/.claude/settings.json`, that fires whenever an agent writes a file matching `docs/plans/YYYY-MM-DD-*.md`.

### Flow

1. Agent writes plan to `docs/plans/2026-04-10-my-feature.md`
2. PostToolUse hook fires
3. Hook gates on:
   - File matches `YYYY-MM-DD-*.md` pattern
   - File is under `docs/plans/` (not `drafts/` or `reviews/`)
   - File does NOT already have `reviewed-at:` in frontmatter (loop prevention)
   - Draft hash differs from existing draft (skip no-op rewrites)
4. Hook copies original to `docs/plans/drafts/<name>.draft.md`
5. Hook runs `npx tsx scripts/review-plan.ts <plan-path> --force` from the Model Prism repo
6. Model Prism fans out to 10 free models:
   - GPT-OSS 120B (OpenAI)
   - Llama 3.3 70B (Meta)
   - Qwen3 Next 80B (Alibaba — general)
   - Qwen3 Coder (Alibaba — code-tuned)
   - Gemma 4 31B (Google)
   - Nemotron 3 Super 120B (NVIDIA)
   - GLM 4.5 Air (Zhipu)
   - Hermes 3 405B (Nous)
   - MiniMax M2.5 (MiniMax)
   - Dolphin Mistral 24B (Mistral via Venice)
7. Each model receives the plan + a local context brief auto-generated from the repo's filesystem (package.json, schema files, layouts, key files) — no GitHub API call needed because it's running locally
8. Synthesis with Claude Opus produces a structured review: master document, consensus, unique insights, disagreements, blind spots, theme matrix
9. Hook extracts the `## Master Synthesis` section from the generated review file (`docs/plans/reviews/<name>.review.md`)
10. Hook replaces the original plan's content with the synthesis, adding frontmatter that points to the preserved draft and full review

### Loop prevention

The hook MUST NOT recursively trigger itself. Three layers of defense:

1. **Frontmatter marker**: After a successful cycle, the plan file gets `reviewed-at: <ISO timestamp>` in its frontmatter. The hook checks for this and exits immediately if present.
2. **Path exclusion**: Files inside `drafts/` or `reviews/` subfolders are ignored even if they match the plan filename pattern.
3. **Content hash**: If a draft file already exists for this plan path with a matching content hash, the hook skips — meaning "the agent re-saved without changes."

### Cost and duration

- Free models: $0 (obviously)
- Opus synthesis: ~$0.05-0.15 per plan (single call, ~2k input + ~4k output tokens)
- Duration: 2-5 minutes per plan (free models run sequentially via `pLimit(1)` due to aggressive rate limits)
- Hook blocks the agent's Write call for the full duration

### Environment requirements

The hook needs `OPENROUTER_API_KEY` and `ANTHROPIC_API_KEY` set in the environment Claude Code spawns hooks under. Two sources:
1. OS environment variables (preferred, permanent)
2. Fallback file at `~/.config/model-prism/env` in `KEY=value` format

If neither is present, the hook saves the draft but skips the review, logging a warning.

## Components Built

### 1. `C:/Dev/Tools/model-prism/src/lib/local-context.ts`

New module that mirrors the browser-side `context-packs.ts` but reads from the local filesystem instead of GitHub. Functions:
- `walkRepo(rootDir, maxFiles=2000)` — recursive directory walk with skip list (node_modules, .git, dist, .next, etc.) and blocked file extensions (.env, .pem, .key, etc.)
- `findRepoRoot(startPath)` — walks up from any file path looking for `package.json` or `.git` as the root marker
- `readPackageJson(repoRoot)` — loads package.json if present for stack detection
- `readLocalFile(repoRoot, relativePath)` — reads individual files with 500KB size cap
- `buildLocalContext(repoRoot, {enhance, anthropicKey})` — builds a complete context object with tree, brief, and key file contents, optionally AI-enhanced
- `buildLocalContextString(ctx, attachedFiles)` — composes the final context string for prompt injection

### 2. `C:/Dev/Tools/model-prism/scripts/review-plan.ts`

CLI script that:
- Parses args: target path (file or folder), `--batch`, `--force`, `--dry-run`, `--max-cost`, `--no-enhance`
- Defines the 10 free models as a hardcoded `ModelInfo[]`
- Defines the review prompt (adversarial plan teardown with 5 sections: fatal flaws, landmines, gaps, turbocharges, execution risks)
- Finds plans to process (single file or all `.md` in a folder)
- Builds local context once per run
- For each plan:
  - Reads content, hashes it
  - Checks for existing review file with matching hash — skips unless `--force`
  - Fans out to 10 models via the existing `fanOut()` function with `context` parameter
  - Synthesizes with Opus via `synthesizeDirect()`
  - Writes a structured review file to `docs/plans/reviews/<slug>.review.md` with frontmatter (plan name, reviewed-at, content-hash, context-repo, model counts, token counts, duration) and all synthesis sections (master document, consensus, unique insights, disagreements, blind spots, theme matrix, failed models)

Added `"review": "tsx scripts/review-plan.ts"` to package.json scripts.

### 3. `C:/Users/shuki/.claude/hooks/plan-review-cycle.py`

Python PostToolUse hook script. Reads tool payload from stdin, gates on plan filename pattern, handles loop prevention, saves draft, runs CLI subprocess, extracts master synthesis via regex, writes synthesized version back to the plan path with new frontmatter.

Uses `subprocess.run` with `shell=True` (required for npx on Windows), 10-minute timeout cap, captures stderr for failure diagnostics.

### 4. `C:/Users/shuki/.claude/settings.json`

Registered the hook via Python script that appends a new entry to the existing `hooks.PostToolUse` array:

```json
{
  "matcher": {"tool_name": "Write|Edit"},
  "hooks": [
    {
      "type": "command",
      "command": "python \"C:/Users/shuki/.claude/hooks/plan-review-cycle.py\"",
      "timeout": 900
    }
  ]
}
```

### 5. `C:/Users/shuki/.claude/CLAUDE.md`

Added a documentation bullet under "While Working" explaining the cycle to agents, so they know: (a) the hook exists, (b) it will run on every plan write, (c) they should only write plans when complete (not half-finished drafts), (d) a `reviewed-at` frontmatter means the plan is already finalized.

## Open Questions Worth Stress-Testing

1. **Draft preservation strategy**: Currently the draft is copied on every Write that passes gating. If the agent saves 3 times while iterating, only the first draft is preserved (subsequent saves skip due to content hash check). Is that right, or should we version drafts (`foo.draft.1.md`, `foo.draft.2.md`)?

2. **What if the review CLI fails midway?** The draft is already saved, but the plan is unchanged. Next agent save triggers the hook again. Is that the right behavior, or should we write a "pending review" marker to prevent re-attempts?

3. **Cost control**: No per-plan budget gate. If Opus synthesis somehow runs away, there's no circuit breaker. Should there be?

4. **Free model failures**: Free tier is flaky. If 9 of 10 models fail due to rate limits, the synthesis still runs with 1 successful response (probably useless). Should we require a minimum number of successful models before synthesizing?

5. **Prompt injection via repo content**: Model Prism's fan-out already has defensive preamble for the codebase context, but the *plan content itself* is what the models are reviewing — a malicious plan could contain instructions to the models. Low risk since plans are authored by trusted agents, but worth noting.

6. **Hook blocks the agent**: 2-5 minutes of synchronous wait during a Write tool call. Agents may appear frozen. Is that acceptable, or should the hook fire-and-forget (spawn a background process) and rely on the agent checking for `reviewed-at` later?

7. **Concurrency**: If two agents write plans simultaneously, two CLI instances run at once, both hitting free-model rate limits harder. Should the hook use a file lock?

8. **Plans that aren't in a git repo**: The local context builder looks for `package.json` or `.git` to find repo root. If neither exists, it defaults to the plan's parent directory — which might produce a useless "0 files" context. Should this case be detected and reported?

9. **Markdown-only assumption**: The plan pattern is `YYYY-MM-DD-*.md`. Plans in other formats (HTML, txt, org) are ignored. Fine or too restrictive?

10. **Global vs project scope**: Hook is registered globally, meaning it fires for ANY repo's `docs/plans/` folder. This includes repos where the user might not want auto-review (e.g., scratch repos, forks). Should there be a per-project opt-in/opt-out?

## Execution Risk Register

- **Review CLI path hardcoded**: `MODEL_PRISM_DIR = Path("C:/Dev/Tools/model-prism")`. Breaks if the repo is moved or the user is on a different machine. Acceptable for personal use, brittle for team use.
- **Windows-specific `shell=True`**: The subprocess call uses `shell=True` because Windows npx needs it. On Linux/Mac this should be False for security. Need platform detection.
- **No validation that the review file was actually written**: The hook checks `review_path.exists()` but doesn't verify the review file is well-formed. A truncated or corrupt review will cause `extract_master_synthesis` to return None and the plan to remain unchanged — we'd like that to be a clear failure signal to the user, not silent.
- **`existing_frontmatter` handling**: The `build_final_plan` function tries to preserve non-review frontmatter fields. If the original plan had complex frontmatter (arrays, nested objects), the line-by-line preservation might mangle it. Edge case but possible.
