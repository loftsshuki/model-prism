import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  cacheKey,
  fileResponseCache,
  pruneResponseCache,
  runResponsesPath,
  saveRunResponses,
  loadRunResponses,
  type CachedResponse,
  type PersistedRun,
} from "./response-cache";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-cache-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const sample = (over: Partial<CachedResponse> = {}): CachedResponse => ({
  model: "anthropic/claude-opus-4.8",
  modelName: "Claude Opus 4.8",
  family: "anthropic",
  response: "The plan drops a table without a backup.",
  findings: [{ claim: "drops a table without a backup", severity: "high" }],
  inputTokens: 1200,
  outputTokens: 300,
  cost: 0.0421,
  timeMs: 8400,
  finishReason: "stop",
  cachedAt: new Date().toISOString(),
  ...over,
});

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

describe("cacheKey", () => {
  const base = { model: "m", prompt: "p", content: "c", context: "x", maxTokens: 100, structured: true };

  it("is 32 hex chars and stable across calls and key order", () => {
    const k = cacheKey(base);
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(cacheKey({ ...base })).toBe(k);
    expect(cacheKey({ structured: true, maxTokens: 100, context: "x", content: "c", prompt: "p", model: "m" })).toBe(k);
  });

  it("changes when any part changes", () => {
    const k = cacheKey(base);
    expect(cacheKey({ ...base, model: "m2" })).not.toBe(k);
    expect(cacheKey({ ...base, prompt: "p2" })).not.toBe(k);
    expect(cacheKey({ ...base, content: "c2" })).not.toBe(k);
    expect(cacheKey({ ...base, context: "x2" })).not.toBe(k);
    expect(cacheKey({ ...base, maxTokens: 101 })).not.toBe(k);
    expect(cacheKey({ ...base, structured: false })).not.toBe(k);
  });

  it("treats an omitted optional part and an undefined one the same", () => {
    expect(cacheKey({ model: "m", prompt: "p", content: "c" })).toBe(cacheKey({ model: "m", prompt: "p", content: "c", context: undefined }));
    expect(cacheKey({ model: "m", prompt: "p", content: "c" })).not.toBe(cacheKey({ model: "m", prompt: "p", content: "c", context: "" }));
  });
});

describe("fileResponseCache", () => {
  it("round-trips a response", async () => {
    const cache = fileResponseCache(dir);
    const key = cacheKey({ model: "m", prompt: "p", content: "c" });
    expect(await cache.get(key)).toBeNull();
    const value = sample();
    await cache.set(key, value);
    expect(await cache.get(key)).toEqual(value);
    expect(fs.existsSync(path.join(dir, `${key}.json`))).toBe(true);
    // No temp files left behind by the atomic write.
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("ignores expired entries according to ttlDays", async () => {
    const key = "a".repeat(32);
    fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(sample({ cachedAt: daysAgo(45) })));
    expect(await fileResponseCache(dir).get(key)).toBeNull();
    expect(await fileResponseCache(dir, { ttlDays: 60 }).get(key)).not.toBeNull();
    expect(await fileResponseCache(dir, { ttlDays: Infinity }).get(key)).not.toBeNull();
  });

  it("ignores corrupt and malformed files", async () => {
    const cache = fileResponseCache(dir);
    fs.writeFileSync(path.join(dir, "bad1.json"), "{not json");
    fs.writeFileSync(path.join(dir, "bad2.json"), JSON.stringify({ hello: "world" }));
    expect(await cache.get("bad1")).toBeNull();
    expect(await cache.get("bad2")).toBeNull();
  });

  it("refuses keys that could escape the directory", async () => {
    const cache = fileResponseCache(dir);
    await expect(cache.get("../escape")).rejects.toThrow(/invalid cache key/);
    await expect(cache.set("a/b", sample())).rejects.toThrow(/invalid cache key/);
  });

  it("creates the directory on first write", async () => {
    const nested = path.join(dir, "deeper", "cache");
    const cache = fileResponseCache(nested);
    await cache.set("k1", sample());
    expect((await cache.get("k1"))?.model).toBe("anthropic/claude-opus-4.8");
  });
});

describe("pruneResponseCache", () => {
  it("removes expired, corrupt, and stray temp files, keeping fresh entries", () => {
    fs.writeFileSync(path.join(dir, "fresh.json"), JSON.stringify(sample()));
    fs.writeFileSync(path.join(dir, "old.json"), JSON.stringify(sample({ cachedAt: daysAgo(40) })));
    fs.writeFileSync(path.join(dir, "corrupt.json"), "nope");
    fs.writeFileSync(path.join(dir, "fresh.json.123.abc.tmp"), "partial");
    fs.writeFileSync(path.join(dir, "README"), "not a cache file");
    expect(pruneResponseCache(dir)).toEqual({ removed: 3, kept: 1 });
    expect(fs.readdirSync(dir).sort()).toEqual(["README", "fresh.json"]);
  });

  it("enforces maxFiles by dropping the oldest entries", () => {
    for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(dir, `k${i}.json`), JSON.stringify(sample({ cachedAt: daysAgo(i) })));
    expect(pruneResponseCache(dir, { maxFiles: 2 })).toEqual({ removed: 2, kept: 2 });
    expect(fs.readdirSync(dir).sort()).toEqual(["k0.json", "k1.json"]);
  });

  it("is a no-op on a missing directory", () => {
    expect(pruneResponseCache(path.join(dir, "missing"))).toEqual({ removed: 0, kept: 0 });
  });
});

describe("run persistence", () => {
  const run: PersistedRun = {
    version: 1,
    plan: "docs/plans/x.md",
    contentHash: "deadbeef",
    promptHash: "cafe",
    roster: "cheap",
    savedAt: new Date().toISOString(),
    responses: [sample(), sample({ model: "openai/gpt-5.5", modelName: "GPT-5.5", family: "openai" })],
  };

  it("builds the responses path under the slug directory", () => {
    expect(runResponsesPath("/reviews", "my-plan", "deadbeef")).toBe(path.join("/reviews", "my-plan", "deadbeef.responses.json"));
  });

  it("round-trips a persisted run, creating parent directories", () => {
    const p = runResponsesPath(dir, "my-plan", "deadbeef");
    saveRunResponses(p, run);
    expect(loadRunResponses(p)).toEqual(run);
  });

  it("returns null for missing, corrupt, or wrong-version files", () => {
    const p = path.join(dir, "x.responses.json");
    expect(loadRunResponses(p)).toBeNull();
    fs.writeFileSync(p, "{{{");
    expect(loadRunResponses(p)).toBeNull();
    fs.writeFileSync(p, JSON.stringify({ ...run, version: 2 }));
    expect(loadRunResponses(p)).toBeNull();
    fs.writeFileSync(p, JSON.stringify({ ...run, responses: "nope" }));
    expect(loadRunResponses(p)).toBeNull();
  });
});
