import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { saveSynthesis } from "@/lib/db";
import { requireAdminToken } from "@/lib/api-auth";
import { idField, parseBody, serverError, textField } from "@/lib/api-validate";

const SaveSynthesisBody = z.object({
  runId: idField,
  result: textField.min(1),
  modelUsed: z.string().min(1).max(200),
});

export async function POST(req: NextRequest) {
  const unauthorized = requireAdminToken(req);
  if (unauthorized) return unauthorized;

  const body = await parseBody(req, SaveSynthesisBody);
  if (!body.ok) return body.response;

  try {
    await saveSynthesis(body.data.runId, body.data.result, body.data.modelUsed);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return serverError("save synthesis", error, "Failed to save");
  }
}
