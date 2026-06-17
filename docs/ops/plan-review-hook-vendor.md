# Plan-review hook — vendoring & recovery reference (E8)

The plan-review cycle is driven by a **local-only dotfile hook** with no remote and no
CI: `~/.claude/hooks/plan-review-cycle.py`. The fusion-unification default flip
(Phase 5, Component F) edits this hook's `resolve_prism_settings`. Because the file is
unreproducible from any checkout, its hash is recorded here so the change is auditable
and recoverable (council E8).

## Pre-flip baseline (recorded 2026-06-17, branch `feat/fusion-unify`)

| Field | Value |
|---|---|
| Path | `~/.claude/hooks/plan-review-cycle.py` |
| Lines | 1379 |
| SHA-256 | `7c81a49a3d638df29e7b70262d3485cff698ac45124b754cfb391479a7128468` |
| `resolve_prism_settings` default | `legacy` (UNFLIPPED — flip is gated) |

## The flip (Component F — apply ONLY after Phase-5 gates pass + founder approval)

Two independent commits, each reverting alone (E7). **Commit 1 must land + verify on
the model-prism CLI BEFORE commit 2** (G13 two-repo sequencing — LA config pointing at
a mode the CLI doesn't support would degrade every review to fallback).

### Commit 1 — hook default (dotfile, recorded by hash here)

In `resolve_prism_settings`, change the final fallback while keeping an explicitly
invalid/typo'd mode → `legacy` (L12 fail-safe). The structure must distinguish
"explicitly set" from "unset":

```python
fm_mode = (plan_fm or {}).get("prism-mode")
rc_mode = config.get("prismMode")
if fm_mode is not None:                 # author set it in frontmatter
    mode = fm_mode if fm_mode in ("legacy", "fusion") else "legacy"   # typo → legacy
elif rc_mode is not None:               # repo set it in .modelprismrc
    mode = rc_mode if rc_mode in ("legacy", "fusion") else "legacy"   # typo → legacy
else:
    mode = "fusion"                     # NEW DEFAULT (was "legacy") — THE FLIP
```

After editing, re-record the new SHA-256 below and confirm the `--dry-run` proof
asserts the exact flag translation `--prism-mode fusion` (`prism_cli_flags`).

### Commit 2 — LA `.modelprismrc`

Add `"prismMode": "fusion"` to `C:/Dev/LuxuryApartments/.modelprismrc` (and this repo's
own `.modelprismrc` if present). **Verify current contents first (E9)** — do not blind-
rewrite; preserve `planReview` and any other local keys/comments.

## Post-flip baseline

| Field | Value |
|---|---|
| SHA-256 | _(record after Commit 1)_ |
| `resolve_prism_settings` default | `fusion` |

## Rollback

Revert Commit 2 (`.modelprismrc`) alone → reviews fall back to the hook default.
Revert Commit 1 (hook) alone → default returns to `legacy`. The degraded-mode legacy
fallback path is untouched throughout (Locked Decision 2), so any judge/synth failure
still soft-falls-back tagged `prism-fallback: legacy`.
