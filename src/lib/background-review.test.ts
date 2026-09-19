import { afterEach, describe, expect, test } from "bun:test";
import { encryptCredential, decryptCredential } from "./server/credentials";
import { BackgroundReviewSchema, escalationReasons, initialCouncil, SourceDocumentSchema } from "./review-policy";
import { compareFindings, diffSourceDocuments, evidenceLocations, findingIdentity, type ReviewFinding, type TrackedFinding } from "./finding-tracking";
import { getCouncilModels } from "./model-catalog";
import { requestCompletion } from "./openrouter-client";
import { RunBudget } from "./run-budget";
import type { SynthesisResult, ModelUsage } from "./types";

const models = getCouncilModels("balanced");
const synthesis: SynthesisResult = { masterDocument: "Review", findings: [], consensus: [], uniqueInsights: [], disagreements: [], blindSpots: [], themeMatrix: [] };
const finding: ReviewFinding = { id: "f1", title: "Missing owner filter", severity: "high", recommendation: "Scope the query to its owner", supportingModels: [], evidence: [{ source: "file:query.ts", quote: "SELECT * FROM runs" }], evidenceVerified: true };
const key = process.env.MODEL_PRISM_ENCRYPTION_KEY;
afterEach(() => { if (key) process.env.MODEL_PRISM_ENCRYPTION_KEY = key; else delete process.env.MODEL_PRISM_ENCRYPTION_KEY; });

describe("durable review boundaries", () => {
  test("credentials are authenticated, randomized and bound to the owner/run/execution", () => {
    process.env.MODEL_PRISM_ENCRYPTION_KEY = "01".repeat(32);
    const a = encryptCredential("private-provider-key", "owner:run:1");
    expect(a).not.toContain("private-provider-key");
    expect(a).not.toBe(encryptCredential("private-provider-key", "owner:run:1"));
    expect(decryptCredential(a, "owner:run:1")).toBe("private-provider-key");
    expect(() => decryptCredential(a, "other:run:1")).toThrow();
    expect(() => decryptCredential(a, "owner:run:2")).toThrow();
    const parts = a.split(":"); parts[3] = (parts[3][0] === "a" ? "b" : "a") + parts[3].slice(1);
    expect(() => decryptCredential(parts.join(":"), "owner:run:1")).toThrow();
  });
  test("missing encryption config fails closed", () => {
    delete process.env.MODEL_PRISM_ENCRYPTION_KEY;
    expect(() => encryptCredential("secret", "binding")).toThrow("not configured");
  });
  test("source IDs cannot replace content or model evidence; maps and duplicate IDs are checked", () => {
    expect(SourceDocumentSchema.safeParse({ id: "content", path: "a", text: "fake source" }).success).toBe(false);
    expect(SourceDocumentSchema.safeParse({ id: "file:a", path: "a", text: "a\nb", lineNumbers: [1] }).success).toBe(false);
    const base = { id: "run_test", content: "plan", prompt: "review", modelIds: models.slice(0, 2).map(m => m.id), synthesisModel: "test", maxCost: 1 };
    expect(BackgroundReviewSchema.safeParse(base).success).toBe(true);
    expect(BackgroundReviewSchema.safeParse({ ...base, modelIds: ["same", "same"] }).success).toBe(false);
    expect(BackgroundReviewSchema.safeParse({ ...base, sources: Array(2).fill({ id: "file:a", path: "a", text: "line" }) }).success).toBe(false);
    expect(BackgroundReviewSchema.safeParse({ ...base, maxCost: Infinity }).success).toBe(false);
  });
  test("fixed and high-risk reviews retain all models; standard adaptive starts diverse", () => {
    expect(initialCouncil(models, false, "standard")).toEqual(models);
    expect(initialCouncil(models, true, "high")).toEqual(models);
    expect(initialCouncil([models[0], { ...models[0], id: "same-family" }, ...models.slice(1)], true, "standard").map(m => m.family)).toEqual(models.slice(0, 3).map(m => m.family));
    expect(escalationReasons(synthesis, 3, "standard")).toEqual([]);
    expect(escalationReasons({ ...synthesis, findings: [finding] }, 3, "standard")).toHaveLength(1);
    expect(escalationReasons({ ...synthesis, blindSpots: ["Missing schema"] }, 3, "standard")).toHaveLength(1);
  });
  test("a persistent reservation completes before any paid request, and settlement before return", async () => {
    const events: string[] = [];
    class AsyncBudget extends RunBudget {
      override async reserve(id: string, ceiling: number) { await new Promise(resolve => setTimeout(resolve, 10)); super.reserve(id, ceiling); events.push("reserved"); }
      override async settle(id: string, usage: ModelUsage) { await new Promise(resolve => setTimeout(resolve, 10)); super.settle(id, usage); events.push("settled"); }
    }
    await requestCompletion({ apiKey: "test", model: models[0], maxTokens: 256, maxAttempts: 1, messages: [{ role: "user", content: "review" }], budget: new AsyncBudget(1),
      fetchImpl: (async () => { events.push("sent"); return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "reviewed" } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: .001 } })); }) as typeof fetch });
    expect(events).toEqual(["reserved", "sent", "settled"]);
  });
  test("a failed database reservation never sends a model request", async () => {
    class FailedBudget extends RunBudget { override async reserve() { throw new Error("Database unavailable"); } }
    let requests = 0;
    await expect(requestCompletion({ apiKey: "test", model: models[0], maxTokens: 256, messages: [{ role: "user", content: "review" }], budget: new FailedBudget(1),
      fetchImpl: (async () => { requests++; return new Response("{}"); }) as typeof fetch })).rejects.toThrow("Database unavailable");
    expect(requests).toBe(0);
  });
});

describe("finding provenance and decisions", () => {
  test("exact quotes produce commit-pinned line links, ambiguous quotes produce none", () => {
    const source = { id: "file:query.ts", path: "query.ts", text: "header\nSELECT * FROM runs\nfooter", repo: "owner/repo", commit: "a".repeat(40) };
    const [location] = evidenceLocations(finding, [source]);
    expect(location.startLine).toBe(2); expect(location.url).toEndWith("/query.ts#L2-L2");
    expect(evidenceLocations(finding, [{ ...source, text: "SELECT * FROM runs\nSELECT * FROM runs" }])).toEqual([]);
    expect(evidenceLocations({ ...finding, evidence: [{ source: "context", quote: "SELECT * FROM runs" }] }, [source, { ...source, id: "file:other.ts", path: "other.ts", text: "SELECT * FROM runs\nSELECT * FROM runs" }])).toEqual([]);
    expect(evidenceLocations({ ...finding, evidence: [{ source: "content", quote: "SELECT * FROM runs" }] }, [source, { ...source, id: "file:other.ts", path: "other.ts" }])).toEqual([]);
    expect(evidenceLocations(finding, [{ ...source, path: "../secret" }])[0].url).toBeUndefined();
    expect(evidenceLocations(finding, [{ ...source, path: "C:\\secret.ts" }])[0].url).toBeUndefined();
  });
  test("diff excerpts preserve original line numbers and reject quotes spanning separate hunks", () => {
    const sources = diffSourceDocuments("diff --git a/query.ts b/query.ts\n--- a/query.ts\n+++ b/query.ts\n@@ -10 +10 @@\n+SELECT * FROM runs\n@@ -90 +90 @@\n+another statement", "owner/repo", "b".repeat(40));
    expect(SourceDocumentSchema.safeParse(sources[0]).success).toBe(true);
    expect(evidenceLocations(finding, sources)[0].startLine).toBe(10);
    expect(evidenceLocations({ ...finding, evidence: [{ source: "file:query.ts", quote: "SELECT * FROM runs\nanother statement" }] }, sources)).toEqual([]);
  });
  test("line moves keep finding identity; disappearance never marks fixed", () => {
    const location = { sourceId: "file:query.ts", path: "query.ts", startLine: 4, endLine: 4 };
    expect(findingIdentity(finding, [location])).toBe(findingIdentity(finding, [{ ...location, startLine: 9, endLine: 9 }]));
    expect(findingIdentity({ ...finding, title: "缺少权限" }, [location])).not.toBe(findingIdentity({ ...finding, title: "数据丢失" }, [location]));
    const old: TrackedFinding = { fingerprint: "stable", finding, locations: [location], state: "accepted", change: "new", note: "confirmed", updatedAt: "now" };
    expect(compareFindings([], [old])[0]).toMatchObject({ change: "not_reported", state: "accepted" });
    expect(compareFindings([old], [old])[0].change).toBe("recurring");
  });
});
