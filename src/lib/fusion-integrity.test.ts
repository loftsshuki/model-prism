import { describe, it, expect } from "bun:test";
import { resolveRepoCitation, verifyJudgeEvidence, countOccurrences, pinHeadSha } from "./fusion-integrity";
import { JudgeResult } from "./fusion";

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
  const sha = pinHeadSha("."); // real HEAD of the model-prism repo

  it("resolves a BARE repo:<path> against the pinned SHA as file-level", () => {
    const r = resolveRepoCitation(".", "repo:package.json", sha);
    expect(r).not.toBeNull();
    expect(r?.precision).toBe("file-level");
    expect(r?.text).toContain("model-prism");
  });

  it("resolves a LINE-PINNED range as line-pinned", () => {
    const r = resolveRepoCitation(".", `repo:package.json@${sha}:1-3`, sha);
    expect(r).not.toBeNull();
    expect(r?.precision).toBe("line-pinned");
    expect(r?.text.split("\n").length).toBe(3);
  });

  it("returns null for a bare path when no pinnedSha is available (L5)", () => {
    expect(resolveRepoCitation(".", "repo:package.json")).toBeNull();
    expect(resolveRepoCitation(".", "repo:package.json", null)).toBeNull();
  });

  it("excludes vendor / generated / minified / binary bare paths (L4)", () => {
    expect(resolveRepoCitation(".", "repo:node_modules/p-limit/index.js", sha)).toBeNull();
    expect(resolveRepoCitation(".", "repo:dist/bundle.js", sha)).toBeNull();
    expect(resolveRepoCitation(".", "repo:app.min.js", sha)).toBeNull();
    expect(resolveRepoCitation(".", "repo:public/logo.png", sha)).toBeNull();
  });

  it("returns null for a missing bare path (graceful, never throws) (L5)", () => {
    expect(resolveRepoCitation(".", "repo:does/not/exist.ts", sha)).toBeNull();
  });

  it("still rejects traversal on the bare form", () => {
    expect(resolveRepoCitation(".", "repo:../escape.ts", sha)).toBeNull();
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
    const sha = pinHeadSha(".");
    const judge = JudgeResult.parse({
      schemaVersion: "2",
      consensus: [], contradictions: [], partial_coverage: [], unique_insights: [], blind_spots: [],
      // "run-bun-tests.mjs" appears exactly once in package.json → unambiguous.
      evidence: [{ id: "e_d", source: "repo:package.json", quote: "run-bun-tests.mjs" }],
    });
    const v = verifyJudgeEvidence(judge, ".", sha);
    expect(v.kept).toHaveLength(1);
    expect(v.kept[0].precision).toBe("file-level");
  });

  it("drops a bare citation whose quote is AMBIGUOUS (matches >1 occurrence)", () => {
    const sha = pinHeadSha(".");
    const judge = JudgeResult.parse({
      schemaVersion: "2",
      consensus: [], contradictions: [], partial_coverage: [], unique_insights: [], blind_spots: [],
      // "tsx scripts/" appears in several package.json scripts → ambiguous file-level match.
      evidence: [{ id: "e_e", source: "repo:package.json", quote: "tsx scripts/" }],
    });
    const v = verifyJudgeEvidence(judge, ".", sha);
    expect(v.kept).toHaveLength(0);
    expect(v.dropped[0].reason).toBe("ambiguous");
  });
});
