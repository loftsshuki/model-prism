# Tracking

## In Progress

- Context Packs feature — built, needs live testing with GitHub PAT
  - Branch: `feature/context-packs`
  - All 11 tasks complete, build passing

## Up Next

- Test Context Packs end-to-end with real GitHub repo
- HTML sibling for context-packs plan doc

## Done This Week

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

