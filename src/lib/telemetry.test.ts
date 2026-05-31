import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import { buildRunTelemetry, aggregateModelValue, analyzeModelFailures, recommendRosterChanges } from "./telemetry";
import { appendRunTelemetry, loadTelemetry, TELEMETRY_PATH } from "./telemetry-ledger";
import { ModelInfo, ModelResponse, SynthesisResult } from "./types";

const USED: ModelInfo[] = [
  { id: "a/x", name: "Model X", family: "x", tier: "fast", contextLength: 0, inputCostPer1k: 0, outputCostPer1k: 0 },
  { id: "a/y", name: "Model Y", family: "y", tier: "free", contextLength: 0, inputCostPer1k: 0, outputCostPer1k: 0 },
];

const RESPONSES: ModelResponse[] = [
  { model: "a/x", modelName: "Model X", status: "complete", inputTokens: 100, outputTokens: 50, cost: 0.01 },
  { model: "a/y", modelName: "Model Y", status: "error", error: "boom" },
];

const SYNTHESIS: SynthesisResult = {
  consensus: [{ point: "p", supportingModels: ["Model X"], strength: "strong" }],
  uniqueInsights: [
    { model: "Model X", insight: "i", significance: "high" },
    { model: "Model X", insight: "j", significance: "low" },
  ],
  disagreements: [],
  blindSpots: [],
  themeMatrix: [
    { theme: "t1", scores: { "Model X": 3, "Model Y": 1 } },
    { theme: "t2", scores: { "Model X": 2 } },
  ],
};

function run() {
  return buildRunTelemetry({
    ts: "2026-05-30T00:00:00Z", plan: "p.md", contentHash: "h", contextRepo: "r",
    roster: "default", synthesisModel: "claude-opus-4-8", durationSec: 10,
    synthesis: SYNTHESIS, responses: RESPONSES, usedModels: USED,
  });
}

let telemetryBackup: string | null = null;
afterEach(() => {
  try {
    if (telemetryBackup === null) fs.rmSync(TELEMETRY_PATH, { force: true });
    else fs.writeFileSync(TELEMETRY_PATH, telemetryBackup, "utf-8");
  } catch { /* ignore */ }
  telemetryBackup = null;
});

describe("buildRunTelemetry", () => {
  it("attributes theme coverage, unique insights, and consensus to the right model by name", () => {
    const r = run();
    const x = r.models.find((m) => m.id === "a/x")!;
    const y = r.models.find((m) => m.id === "a/y")!;

    expect(x.status).toBe("complete");
    expect(x.themeAvg).toBeCloseTo(2.5); // (3 + 2) / 2
    expect(x.themeCount).toBe(2);
    expect(x.uniqueHigh).toBe(1);
    expect(x.uniqueLow).toBe(1);
    expect(x.consensusSupports).toBe(1);
    expect(x.cost).toBe(0.01);

    expect(y.status).toBe("error");
    expect(y.themeAvg).toBe(1); // only t1 scored Y
    expect(y.uniqueHigh + y.uniqueMed + y.uniqueLow).toBe(0);
  });

  it("marks a substituted slot as a fallback", () => {
    const resp: ModelResponse[] = [{ model: "a/x", modelName: "Model X → Sub", status: "complete", fallbackFrom: "a/x", cost: 0 }];
    const r = buildRunTelemetry({ ...{
      ts: "t", plan: "p", contentHash: "h", contextRepo: "r", roster: "default", synthesisModel: "o", durationSec: 1,
      synthesis: SYNTHESIS, responses: resp, usedModels: [USED[0]],
    } });
    expect(r.models[0].status).toBe("fallback");
  });
});

describe("aggregateModelValue", () => {
  it("ranks the unique-insight contributor high and flags the failing model", () => {
    const rows = aggregateModelValue([run(), run()]);
    const x = rows.find((r) => r.id === "a/x")!;
    const y = rows.find((r) => r.id === "a/y")!;

    expect(x.appearances).toBe(2);
    expect(x.successRate).toBe(1);
    expect(x.uniquePerRun).toBe(4); // high(3) + low(1) per run
    expect(x.verdict).toContain("🌟");

    expect(y.successRate).toBe(0);
    expect(y.verdict).toContain("🔴");

    // Highest value ranks first.
    expect(rows[0].id).toBe("a/x");
  });
});

describe("model intelligence", () => {
  it("surfaces failure diagnostics and roster recommendations", () => {
    const rows = aggregateModelValue([run(), run()]);
    const diagnostics = analyzeModelFailures(rows);
    const recommendations = recommendRosterChanges(rows);

    expect(diagnostics.some((d) => d.id === "a/y" && d.severity === "high")).toBe(true);
    expect(recommendations.some((r) => r.modelId === "a/y" && r.type === "replace")).toBe(true);
    expect(recommendations.some((r) => r.modelId === "a/x" && r.type === "promote")).toBe(true);
  });
});

describe("append + load round-trip", () => {
  it("persists and re-reads a run, skipping corrupt lines", () => {
    try { telemetryBackup = fs.readFileSync(TELEMETRY_PATH, "utf-8"); } catch { telemetryBackup = null; }
    fs.rmSync(TELEMETRY_PATH, { force: true });
    appendRunTelemetry(run());
    fs.appendFileSync(TELEMETRY_PATH, "{not json}\n");
    appendRunTelemetry(run());
    const loaded = loadTelemetry();
    expect(loaded.length).toBe(2); // corrupt line skipped, two valid runs kept
    expect(loaded[0].models.length).toBe(2);
  });
});
