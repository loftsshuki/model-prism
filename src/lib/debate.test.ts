import { describe, it, expect, afterEach } from "bun:test";
import { runDebateRound, applyDebateToJudge, renderDebateMarkdown } from "./debate";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function toolResponse(args: unknown) {
  return new Response(
    JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ function: { name: "respond_to_counterargument", arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const judge = {
  consensus: [{ claim: "existing", support: ["m1"] }],
  contradictions: [
    { topic: "Should the migration be reversible?", positions: [{ model: "m1", stance: "Yes, add a down migration" }, { model: "m2", stance: "No, forward-only is fine" }] },
    { topic: "Cache TTL", positions: [{ model: "m1", stance: "60s" }, { model: "m3", stance: "600s" }] },
  ],
};

describe("runDebateRound", () => {
  it("asks each side, drops conceded positions and marks the topic resolved", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body.model);
      const prompt: string = body.messages[0].content;
      expect(prompt).toContain("<opposing_positions>");
      // m2 concedes on the migration topic; everyone else defends.
      if (body.model === "m2") return toolResponse({ verdict: "concede", stance: "", reasoning: "The plan has no rollback path; a down migration is needed." });
      return toolResponse({ verdict: "defend", stance: "same", reasoning: "Evidence in the plan supports this.", evidence: "run migration 0042", confidence: "high" });
    }) as typeof fetch;

    const result = await runDebateRound({ openrouterKey: "k", judge, draft: "plan text", maxTopics: 1 });
    expect(result.calls).toBe(2);
    expect(calls.sort()).toEqual(["m1", "m2"]);
    expect(result.exchanges).toHaveLength(1);
    expect(result.exchanges[0].resolved).toBe(true);
    expect(result.exchanges[0].resolvedPositions).toEqual([{ model: "m1", stance: "Yes, add a down migration" }]);
    expect(result.cost).toBeCloseTo(0.002, 5);

    const merged = applyDebateToJudge(judge, result);
    expect(merged.contradictions.map((c) => c.topic)).toEqual(["Cache TTL"]); // untouched topic stays
    expect(merged.consensus.at(-1)).toEqual({ claim: "Should the migration be reversible?: Yes, add a down migration", support: ["m1"] });
  });

  it("keeps the original position when a model fails to reply", async () => {
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.model === "m3") return new Response("nope", { status: 401 });
      return toolResponse({ verdict: "refine", stance: "300s with stale-while-revalidate", reasoning: "Both are partly right." });
    }) as typeof fetch;
    const result = await runDebateRound({ openrouterKey: "k", judge: { contradictions: [judge.contradictions[1]] }, draft: "plan" });
    const ex = result.exchanges[0];
    expect(ex.resolved).toBe(false);
    expect(ex.resolvedPositions).toEqual([
      { model: "m1", stance: "300s with stale-while-revalidate" },
      { model: "m3", stance: "600s" },
    ]);
    expect(ex.replies.find((r) => r.model === "m3")?.error).toContain("401");
    const md = renderDebateMarkdown(result).join("\n");
    expect(md).toContain("Cross-Examination");
    expect(md).toContain("still contested");
    expect(renderDebateMarkdown(null)).toEqual([]);
  });
});
