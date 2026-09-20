# RTK terminal compression

Use this only when Rust Token Killer is already installed and `rtk gain` succeeds.

- Prefer RTK for terminal-heavy discovery, git output, grep/find, test runners, lint, logs, and other supported commands.
- Let the Codex RTK integration rewrite supported commands when available; otherwise call an `rtk` wrapper explicitly.
- If RTK output is ambiguous, truncated too aggressively, or a command fails, rerun the smallest raw command needed for diagnosis.
- Do not filter away exact security, migration, destructive-operation, or data-loss diagnostics when full output is required.
- Do not install or upgrade RTK automatically from a project task.
- RTK reduces terminal-output context; it does not measure total Codex usage.

Useful local checks:
- `rtk --version`
- `rtk gain`
- `rtk discover --all --since 7`
- `rtk gain --weekly`
