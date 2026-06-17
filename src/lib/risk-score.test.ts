import { describe, it, expect } from "bun:test";
import { computeRiskScore, summarizeRisk, RISK_TIER_HIGH } from "./risk-score";

describe("computeRiskScore", () => {
  it("scores a trivial doc-only plan as low tier, not build, not irreversible", () => {
    const r = computeRiskScore("Update the README wording and fix a typo in the about page copy.");
    expect(r.tier).toBe("low");
    expect(r.irreversible).toBe(false);
    expect(r.build).toBe(false);
  });

  it("flags a migration plan as irreversible and high tier", () => {
    const plan = "Add a column then DROP TABLE legacy_users. Edit supabase/migrations/0042_x.sql and update RLS create policy.";
    const r = computeRiskScore(plan);
    expect(r.irreversible).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(RISK_TIER_HIGH);
    expect(r.tier).toBe("high");
  });

  it("flags build-config changes via the build signal", () => {
    const r = computeRiskScore("Bump deps in package.json and tweak next.config.ts and the .github/workflows/ci.yml file.");
    expect(r.build).toBe(true);
    expect(r.signals.find((s) => s.name === "package-json")?.matched).toBe(true);
    expect(r.signals.find((s) => s.name === "ci-workflow")?.matched).toBe(true);
  });

  it("auth + api + schema domain signals raise the score", () => {
    const low = computeRiskScore("small copy edit");
    const high = computeRiskScore("Rework the authentication session token flow in api/login/route.ts and add a schema migration with a new table.");
    expect(high.score).toBeGreaterThan(low.score);
  });

  it("clamps to 0–100 and produces a parseable summary", () => {
    const r = computeRiskScore("DROP TABLE x; TRUNCATE y; supabase/migrations/ create policy auth. payment stripe pii package.json next.config.ts .github/workflows/ api/route.ts schema migration".repeat(3), 50);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(summarizeRisk(r)).toMatch(/score=\d+ tier=(low|medium|high)/);
  });
});
