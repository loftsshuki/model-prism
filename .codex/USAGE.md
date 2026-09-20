# Usage diagnostics

Use this only for deliberate usage investigations.

When Codex usage is unexpectedly high:
1. Record model + effort + fast mode/subagents.
2. Note broad repository discovery and rereads.
3. Note full build/E2E/CI/log loops.
4. If RTK is installed, inspect `rtk gain --weekly` and `rtk discover --all --since 7`.
5. RTK measures estimated terminal-output reduction, not total plan consumption.
6. Fix repeated waste with the smallest lever: router update, narrower test, reusable skill, or cheaper helper.

Do not create persistent per-task logs unless explicitly requested.
