import * as path from "node:path";
import * as fs from "node:fs";
import { RunTelemetry } from "./telemetry";

export const TELEMETRY_PATH =
  process.env.MODEL_PRISM_TELEMETRY || path.join(process.cwd(), ".model-prism", "model-telemetry.jsonl");

// Local JSONL ledger for CLI/offline use. The web app stores telemetry in DB to avoid
// tracing local filesystem access into the Next.js server bundle.
export function appendRunTelemetry(record: RunTelemetry): void {
  fs.mkdirSync(path.dirname(TELEMETRY_PATH), { recursive: true });
  fs.appendFileSync(TELEMETRY_PATH, JSON.stringify(record) + "\n", "utf-8");
}

export function loadTelemetry(pathOverride?: string): RunTelemetry[] {
  const file = pathOverride || TELEMETRY_PATH;
  if (!fs.existsSync(file)) return [];
  const out: RunTelemetry[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as RunTelemetry);
    } catch {
      /* skip corrupt lines */
    }
  }
  return out;
}
