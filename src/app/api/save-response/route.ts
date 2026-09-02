import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { saveResponse } from "@/lib/db";
import { requireAdminToken } from "@/lib/api-auth";
import { idField, parseBody, serverError, textField } from "@/lib/api-validate";

const SaveResponseBody = z.object({
  runId: idField,
  model: idField,
  modelName: z.string().max(200).nullable().optional(),
  family: z.string().max(100).nullable().optional(),
  response: textField.nullable().optional(),
  error: z.string().max(10_000).nullable().optional(),
  timeMs: z.number().int().nonnegative().nullable().optional(),
  inputTokens: z.number().int().nonnegative().nullable().optional(),
  outputTokens: z.number().int().nonnegative().nullable().optional(),
  cost: z.number().nonnegative().nullable().optional(),
});

export async function POST(req: NextRequest) {
  const unauthorized = requireAdminToken(req);
  if (unauthorized) return unauthorized;

  const body = await parseBody(req, SaveResponseBody);
  if (!body.ok) return body.response;
  const { runId, model, modelName, family, response, error, timeMs, inputTokens, outputTokens, cost } = body.data;

  try {
    // Upserts the (run, model) row and recomputes runs.total_cost from the sum of
    // response costs in one round trip — the previous overwrite made the run total
    // equal to whichever model happened to report last.
    await saveResponse(
      runId,
      model,
      modelName ?? model,
      family ?? "unknown",
      response ?? null,
      error ?? null,
      timeMs ?? null,
      inputTokens ?? null,
      outputTokens ?? null,
      cost ?? null
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return serverError("save response", error, "Failed to save response");
  }
}
