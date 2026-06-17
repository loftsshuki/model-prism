import { describe, it, expect } from "bun:test";
import { resolveRepoCitation, verifyJudgeEvidence } from "./fusion-integrity";
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
});
