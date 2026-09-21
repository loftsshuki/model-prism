type BooleanQuestion = {
  type: "boolean";
  instructions: string;
  criteria?: { true: string; false: string };
};

type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
};

type ScoreQuestion = {
  type: "score";
  instructions: string;
  criteria: string[];
};

export type JevQuestion = BooleanQuestion | ChoiceQuestion | ScoreQuestion;
export type JevQuestions = Record<string, JevQuestion>;

export interface JevEvaluationResult {
  answers: Record<string, unknown>;
  latencyMs: number;
  costUsd: number;
  generationId?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export function jevEnabled(env: NodeJS.ProcessEnv = process.env) {
  const raw = (env.MODEL_PRISM_JEV_ENABLED ?? "true").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(raw);
}

function resolveGatewayToken(explicit?: string) {
  return explicit || process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || "";
}

export async function evaluateWithJev(input: {
  state: string | object | unknown[];
  questions: JevQuestions;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<JevEvaluationResult> {
  if (!jevEnabled()) throw new Error("Jev is disabled by MODEL_PRISM_JEV_ENABLED");

  const token = resolveGatewayToken(input.token);
  if (!token) throw new Error("Jev authentication unavailable; use Vercel OIDC or set AI_GATEWAY_API_KEY");

  const started = Date.now();
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl("https://ai-gateway.vercel.sh/v1/evaluate", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "typesafe-ai/jev",
      state: input.state,
      questions: input.questions,
      providerOptions: {
        gateway: {
          zeroDataRetention: true,
          only: ["typesafe-ai"],
          tags: ["model-prism", "decision-gate"],
        },
      },
    }),
    signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`Jev evaluation failed (${response.status}): ${text.slice(0, 300)}`);

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("Jev returned an invalid JSON response");
  }

  const answers = data.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw new Error("Jev response did not include typed answers");

  const providerMetadata = data.providerMetadata && typeof data.providerMetadata === "object"
    ? data.providerMetadata as Record<string, unknown>
    : {};
  const gateway = providerMetadata.gateway && typeof providerMetadata.gateway === "object"
    ? providerMetadata.gateway as Record<string, unknown>
    : {};
  const rawCost = gateway.gatewayCost ?? gateway.cost ?? 0;
  const costUsd = Number(rawCost);
  const usage = data.usage && typeof data.usage === "object" ? data.usage as Record<string, unknown> : undefined;

  return {
    answers: answers as Record<string, unknown>,
    latencyMs: Date.now() - started,
    costUsd: Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : 0,
    generationId: typeof gateway.generationId === "string" ? gateway.generationId : undefined,
    usage: usage ? {
      inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : undefined,
      outputTokens: typeof usage.outputTokens === "number" ? usage.outputTokens : undefined,
    } : undefined,
  };
}
