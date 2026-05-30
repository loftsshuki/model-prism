import { describe, it, expect } from "bun:test";
import { estimateTokens, readCriticality, resolveAutoRoster, ROSTERS } from "./rosters";

describe("estimateTokens", () => {
  it("approximates ~4 chars per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(4000))).toBe(1000);
  });
});

describe("readCriticality", () => {
  it("reads criticality from leading frontmatter", () => {
    expect(readCriticality("---\ntitle: x\ncriticality: high\n---\nbody")).toBe("high");
    expect(readCriticality("---\ncriticality: LOW\n---\n")).toBe("low");
    expect(readCriticality("---\ncriticality: medium\n---\n")).toBe("medium");
  });
  it("returns null when absent or no frontmatter", () => {
    expect(readCriticality("---\ntitle: x\n---\nbody")).toBeNull();
    expect(readCriticality("no frontmatter here\ncriticality: high")).toBeNull();
    expect(readCriticality("---\ncriticality: bogus\n---\n")).toBeNull();
  });
});

describe("resolveAutoRoster", () => {
  const big = "x".repeat(8000); // ~2000 tokens
  const small = "x".repeat(400); // ~100 tokens

  it("picks frontier for substantial plans, cheap for trivial ones", () => {
    expect(resolveAutoRoster(big).roster).toBe("default");
    expect(resolveAutoRoster(small).roster).toBe("cheap");
  });

  it("honors an explicit criticality override regardless of size", () => {
    expect(resolveAutoRoster("---\ncriticality: low\n---\n" + big).roster).toBe("cheap");
    expect(resolveAutoRoster("---\ncriticality: high\n---\n" + small).roster).toBe("default");
  });

  it("respects a custom threshold", () => {
    expect(resolveAutoRoster(small, 50).roster).toBe("default"); // ~100 tokens ≥ 50
    expect(resolveAutoRoster(big, 5000).roster).toBe("cheap"); // ~2000 tokens < 5000
  });

  it("only ever resolves to real rosters", () => {
    for (const c of [big, small, "---\ncriticality: high\n---\n"]) {
      expect(ROSTERS[resolveAutoRoster(c).roster]).toBeDefined();
    }
  });
});
