# Tracking

## In Progress

- Council roster review + branch-fork reconciliation
  - Branch: `roster-review` (off `origin/master`, merges `feature/context-packs`) → PR to `master`
  - Resolves the master↔context-packs fork: one canonical superset (roster machinery
    + second-pass mode + auto-fallback + refreshed roster)
  - **Default roster is now FRONTIER-grade** (3 free anchors + 7 frontier reasoners),
    `cheap` preset kept for bulk. All IDs curl-verified vs OpenRouter 2026-05-30.
  - Synthesis bumped to Opus 4.8 (same price as 4.6/4.7). End-to-end validated: 10/10.
  - **POST-MERGE ACTION REQUIRED:** the live plan-review hook runs from the main
    checkout `C:/Dev/Tools/model-prism`, currently on `feature/context-packs`. After
    this PR merges to master, switch that checkout to master (or fast-forward
    context-packs to it) or the live hook keeps running the old roster.

- Context Packs feature — built, needs live testing with GitHub PAT
  - Branch: `feature/context-packs` (now subsumed into `roster-review` superset)
  - All 11 tasks complete, build passing

## Up Next

- Merge `roster-review` PR to master, then reconcile the main checkout's branch (above)
- Test Context Packs end-to-end with real GitHub repo
- HTML sibling for context-packs plan doc

## Done This Week

- chore(council): roster review — frontier-grade default, verified IDs, Opus 4.8,
  fallback map reconciled; fixed 3 dead/broken IDs from the prior "11 families" refresh
  (tencent/hy3-preview:free + nvidia/nemotron-nano-12b-v2:free absent from catalog;
  owl-alpha volatile; claude-haiku-4-5 → claude-haiku-4.5 format). Branches deforked.

- feat: Context Packs — give models read-only codebase access via GitHub API
  - 3 new files: github.ts, context-cache.ts, context-packs.ts
  - Updated fan-out to use system message for context injection
  - Updated synthesis with context + prompt injection defense
  - Context panel UI with repo picker, file tree, brief editor, AI enhancement
  - GitHub PAT validation with structured error messages
  - IndexedDB cache for file contents (not localStorage)
  - Schema versioning, export/import, secret detection
  - Context metadata persisted in run history
  - Code-aware token estimation (2.5 chars/token for code)

