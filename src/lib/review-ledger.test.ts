import { describe, it, expect, afterEach } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  buildReviewRecord, appendReviewRecord, loadReviewLedger,
  renderBrainDigest, writeBrainDigest,
} from "./review-ledger";
import { ModelResponse, SynthesisResult } from "./types";

const RESPONSES: ModelResponse[] = [
  { model: "a/x", modelName: "Model X", status: "complete", cost: 0.02 },
  { model: "a/y", modelName: "Model Y", status: "error", error: "boom" },
];

const SYNTHESIS: SynthesisResult = {
  consensus: [{ point: "p", supportingModels: ["Model X"], strength: "strong" }],
  uniqueInsights: [
    { model: "Model X", insight: "low one", significance: "low" },
    { model: "Model Y", insight: "high one", significance: "high" },
  ],
  disagreements: [{ topic: "scope", positions: [{ models: ["Model X"], position: "broad" }, { models: ["Model Y"], position: "narrow" }] }],
  blindSpots: ["no rollback plan", "no observability"],
  themeMatrix: [],
};

function rec() {
  return buildReviewRecord({
    ts: "2026-05-30T16:45:00.000Z", plan: "2026-05-30-foo.md", contextRepo: "myrepo",
    roster: "default", synthesisModel: "claude-opus-4-8", durationSec: 42,
    synthesis: SYNTHESIS, responses: RESPONSES,
  });
}

const tmpLedger = path.join(os.tmpdir(), `mp-review-${process.pid}.jsonl`);
const tmpBrain = path.join(os.tmpdir(), `mp-brain-${process.pid}`);
afterEach(() => {
  try { fs.unlinkSync(tmpLedger); } catch { /* ignore */ }
  try { fs.rmSync(tmpBrain, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("buildReviewRecord", () => {
  it("captures findings and sorts top insights by significance", () => {
    const r = rec();
    expect(r.cost).toBeCloseTo(0.02);
    expect(r.modelsSucceeded).toBe(1);
    expect(r.modelsFailed).toBe(1);
    expect(r.disagreements.length).toBe(1);
    expect(r.blindSpots).toEqual(["no rollback plan", "no observability"]);
    expect(r.topInsights[0].significance).toBe("high"); // high sorts before low
    expect(r.consensusCount).toBe(1);
  });
});

describe("append + load round-trip", () => {
  it("persists and re-reads, skipping corrupt lines", () => {
    appendReviewRecord(rec(), tmpLedger);
    fs.appendFileSync(tmpLedger, "{bad\n");
    appendReviewRecord(rec(), tmpLedger);
    const loaded = loadReviewLedger(tmpLedger);
    expect(loaded.length).toBe(2);
    expect(loaded[0].plan).toBe("2026-05-30-foo.md");
  });
});

describe("Brain digest", () => {
  it("renders a wikilinked note with decisions + blind spots", () => {
    const md = renderBrainDigest(rec());
    expect(md).toContain("[[Model Prism]]");
    expect(md).toContain("[[council review]]");
    expect(md).toContain("Decisions needed");
    expect(md).toContain("scope");
    expect(md).toContain("no rollback plan");
  });

  it("writes into <brain>/council-reviews/YYYY/MM/ when given a root", () => {
    const file = writeBrainDigest(rec(), tmpBrain);
    expect(file).not.toBeNull();
    expect(file!.replace(/\\/g, "/")).toContain("council-reviews/2026/05/");
    expect(fs.existsSync(file!)).toBe(true);
    expect(fs.readFileSync(file!, "utf-8")).toContain("Council Review — 2026-05-30-foo.md");
  });

  it("no-ops (returns null) when disabled via env", () => {
    const prev = process.env.MODEL_PRISM_BRAIN_DIGEST;
    process.env.MODEL_PRISM_BRAIN_DIGEST = "0";
    try {
      expect(writeBrainDigest(rec(), tmpBrain)).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.MODEL_PRISM_BRAIN_DIGEST;
      else process.env.MODEL_PRISM_BRAIN_DIGEST = prev;
    }
  });
});
