#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const candidates = [
  process.env.BUN_BIN,
  process.platform === "win32" ? join(homedir(), ".bun", "bin", "bun.exe") : join(homedir(), ".bun", "bin", "bun"),
  process.platform === "win32" ? "bun.cmd" : "bun",
  "bun",
].filter(Boolean);

let lastError = null;
for (const candidate of candidates) {
  const isPath = candidate.includes("/") || candidate.includes("\\");
  if (isPath && !existsSync(candidate)) continue;

  const result = spawnSync(candidate, ["test", "src/"], {
    stdio: "inherit",
    shell: !isPath,
  });

  if (!result.error) {
    process.exit(result.status ?? 0);
  }
  lastError = result.error;
}

console.error("Could not find a working Bun executable.");
if (lastError) console.error(lastError.message);
console.error("Set BUN_BIN to your Bun executable path, e.g. C:/Users/<you>/.bun/bin/bun.exe");
process.exit(1);
