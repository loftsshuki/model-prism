import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { resolveRepoCitation, verifyJudgeEvidence, countOccurrences, pinHeadSha } from "./fusion-integrity";
import { JudgeResult } from "./fusion";

const repository = mkdtempSync(join(tmpdir(), "model-prism-citations-"));
let sha: string | null = null;
beforeAll(() => {
  // Deployments omit .git; exercise real git against a deterministic fixture.
  writeFileSync(join(repository, "package.json"), JSON.stringify({
    name: "model-prism-fixture",
    scripts: { test: "node scripts/run-bun-tests.mjs", review: "tsx scripts/review.ts", evaluate: "tsx scripts/evaluate.ts" },
  }, null, 2) + "\n");
  const git = (args: string[]) => execFileSync("git", ["-C", repository, ...args], { stdio: "ignore", timeout: 10000 });
  git(["init"]);
  git(["add", "package.json"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Citation fixture"]);
  sha = pinHeadSha(repository);
  expect(sha).toMatch(/^[a-f0-9]{40}$/);
});
afterAll(() => {
  const target = resolve(repository);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("model-prism-citations-")) throw new Error("Unsafe fixture cleanup path");
  rmSync(target, { recursive: true, force: true });
});

describe("resolveRepoCitation — parse guards (no git needed)", () => {
  it("returns null on a non-repo source", () => {
    expect(resolveRepoCitation(".", "model:m1")).toBeNull();
    expect(resolveRepoCitation(".", "draft")).toBeNull();
  });
  it("rejects path traversal and absolute paths", () => {
    expect(resolveRepoCitation(".", "repo:../etc/passwd@abc1234:1-2")).toBeNull();
    expect(resolveRepoCitation(".", "repo:/etc/passwd@abc1234:1-2")).toBeNull();
    expect(resolveRepoCitation(".", "repo:C:/secrets@abc1234:1-2")).toBeNull();
  });
  it("rejects malformed line ranges", () => {
    expect(resolveRepoCitation(".", "repo:a.ts@abc1234:5-2")).toBeNull();
    expect(resolveRepoCitation(".", "repo:a.ts@abc1234:0-2")).toBeNull();
  });
});

describe("resolveRepoCitation — bare/file-level resolution (Component D, L4/L5)", () => {
  it("resolves a BARE repo:<path> against the pinned SHA as file-level", () => {
    const r = resolveRepoCitation(repository, "repo:package.json", sha);
    expect(r).not.toBeNull();
    expect(r?.precision).toBe("file-level");
    expect(r?.text).toContain("model-prism");
  });

  it("resolves a LINE-PINNED range as line-pinned", () => {
    const r = resolveRepoCitation(repository, `repo:package.json@${sha}:1-3`, sha);
    expect(r).not.toBeNull();
    expect(r?.precision).toBe("line-pinned");
    expect(r?.text.split("\n").length).toBe(3);
  });

  it("returns null for a bare path when no pinnedSha is available (L5)", () => {
    expect(resolveRepoCitation(repository, "repo:package.json")).toBeNull();
    expect(resolveRepoCitation(repository, "repo:package.json", null)).toBeNull();
  });

  it("excludes vendor / generated / minified / binary bare paths (L4)", () => {
    expect(resolveRepoCitation(repository, "repo:node_modules/p-limit/index.js", sha)).toBeNull();
    expect(resolveRepoCitation(repository, "repo:dist/bundle.js", sha)).toBeNull();
    expect(resolveRepoCitation(repository, "repo:app.min.js", sha)).toBeNull();
    expect(resolveRepoCitation(repository, "repo:public/logo.png", sha)).toBeNull();
  });

  it("returns null for a missing bare path (graceful, never throws) (L5)", () => {
    expect(resolveRepoCitation(repository, "repo:does/not/exist.ts", sha)).toBeNull();
  });

  it("still rejects traversal on the bare form", () => {
    expect(resolveRepoCitation(repository, "repo:../escape.ts", sha)).toBeNull();
  });
});

describe("countOccurrences", () => {
  it("counts normalized, whitespace-insensitive occurrences", () => {
    expect(countOccurrences("foo", "foo bar foo baz FOO")).toBe(3);
    expect(countOccurrences("foo", "nothing here")).toBe(0);
    expect(countOccurrences("", "anything")).toBe(0);
    expect(countOccurrences("a b", "a   b and a b")).toBe(2);
  });
});

describe("verifyJudgeEvidence", () => {
  it("keeps model/draft citations untouched (transcript-authored, not SHA-checked)", () => {
    const judge = JudgeResult.parse({
      schemaVersion: "1",
      consensus: [], contradictions: [], partial_coverage: [], unique_insights: [], blind_spots: [],
      evidence: [
        { id: "e_a", source: "model:m1", quote: "x" },
        { id: "e_b", source: "draft", quote: "y" },
      ],
    });
    const v = verifyJudgeEvidence(judge, ".", null);
    expect(v.kept).toHaveLength(2);
    expect(v.dropped).toHaveLength(0);
  });

  it("drops an unresolvable repo citation", () => {
    const judge = JudgeResult.parse({
      schemaVersion: "1",
      consensus: [], contradictions: [], partial_coverage: [], unique_insights: [], blind_spots: [],
      evidence: [{ id: "e_c", source: "repo:../escape@deadbeef:1-2", quote: "z" }],
    });
    const v = verifyJudgeEvidence(judge, ".", "deadbeef");
    expect(v.kept).toHaveLength(0);
    expect(v.dropped[0].reason).toBe("unresolvable");
  });

  it("keeps a supported bare citation and TAGS it file-level (Component D)", () => {
    const judge = JudgeResult.parse({
      schemaVersion: "2",
      consensus: [], contradictions: [], partial_coverage: [], unique_insights: [], blind_spots: [],
      // "run-bun-tests.mjs" appears exactly once in package.json → unambiguous.
      evidence: [{ id: "e_d", source: "repo:package.json", quote: "run-bun-tests.mjs" }],
    });
    const v = verifyJudgeEvidence(judge, repository, sha);
    expect(v.kept).toHaveLength(1);
    expect(v.kept[0].precision).toBe("file-level");
  });

  it("drops a bare citation whose quote is AMBIGUOUS (matches >1 occurrence)", () => {
    const judge = JudgeResult.parse({
      schemaVersion: "2",
      consensus: [], contradictions: [], partial_coverage: [], unique_insights: [], blind_spots: [],
      // "tsx scripts/" appears in several package.json scripts → ambiguous file-level match.
      evidence: [{ id: "e_e", source: "repo:package.json", quote: "tsx scripts/" }],
    });
    const v = verifyJudgeEvidence(judge, repository, sha);
    expect(v.kept).toHaveLength(0);
    expect(v.dropped[0].reason).toBe("ambiguous");
  });
});
