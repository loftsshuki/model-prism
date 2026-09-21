import { afterEach, describe, expect, test } from "bun:test";
import { evaluateWithJev, jevEnabled } from "./jev-evaluator";

const originalEnabled = process.env.MODEL_PRISM_JEV_ENABLED;
afterEach(() => {
  if (originalEnabled === undefined) delete process.env.MODEL_PRISM_JEV_ENABLED;
  else process.env.MODEL_PRISM_JEV_ENABLED = originalEnabled;
});

describe("Jev gateway evaluator", () => {
  test("honors the global kill switch", () => {
    process.env.MODEL_PRISM_JEV_ENABLED = "false";
    expect(jevEnabled()).toBe(false);
  });

  test("uses the native evaluate endpoint with ZDR and parses decision metadata", async () => {
    process.env.MODEL_PRISM_JEV_ENABLED = "true";
    let request: RequestInit | undefined;
    let url = "";

    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      url = String(input);
      request = init;
      return new Response(JSON.stringify({
        answers: {
          depth: {
            type: "choice",
            choice: "standard",
            probabilities: { minimal: 0.02, standard: 0.94, full: 0.03, uncertain: 0.01 },
          },
        },
        usage: { inputTokens: 123, outputTokens: 0 },
        providerMetadata: { gateway: { gatewayCost: "0.00000492", generationId: "gen_test" } },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const result = await evaluateWithJev({
      token: "test-token",
      state: { content: "small reversible copy edit" },
      questions: {
        depth: {
          type: "choice",
          instructions: "Choose review depth.",
          criteria: { minimal: "routine", standard: "normal", full: "high risk", uncertain: "not enough context" },
        },
      },
      fetchImpl,
    });

    expect(url).toBe("https://ai-gateway.vercel.sh/v1/evaluate");
    expect((request?.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    const body = JSON.parse(String(request?.body));
    expect(body.model).toBe("typesafe-ai/jev");
    expect(body.providerOptions.gateway.zeroDataRetention).toBe(true);
    expect(body.providerOptions.gateway.only).toEqual(["typesafe-ai"]);
    expect(result.answers.depth).toMatchObject({ type: "choice", choice: "standard" });
    expect(result.costUsd).toBeCloseTo(0.00000492);
    expect(result.generationId).toBe("gen_test");
    expect(result.usage?.inputTokens).toBe(123);
  });
});
