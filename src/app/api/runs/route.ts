import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createRun, listRuns } from "@/lib/db";
import { requireAdminToken } from "@/lib/api-auth";
import { idField, parseBody, serverError, textField } from "@/lib/api-validate";

const CreateRunBody = z.object({
  id: idField,
  content: textField.min(1),
  prompt: textField.min(1),
  models: z.array(z.string().min(1).max(200)).min(1).max(200),
  contextMetadata: z.string().max(100_000).nullable().optional(),
});

export async function POST(req: NextRequest) {
  const unauthorized = requireAdminToken(req);
  if (unauthorized) return unauthorized;

  const body = await parseBody(req, CreateRunBody);
  if (!body.ok) return body.response;
  const { id, content, prompt, models, contextMetadata } = body.data;

  try {
    await createRun(id, content, prompt, models, contextMetadata ?? null);
    return NextResponse.json({ id });
  } catch (error) {
    return serverError("create run", error, "Failed to create run");
  }
}

export async function GET(req: NextRequest) {
  const unauthorized = requireAdminToken(req);
  if (unauthorized) return unauthorized;

  try {
    const runs = await listRuns();
    return NextResponse.json({ runs });
  } catch (error) {
    return serverError("list runs", error, "Failed to load runs");
  }
}
