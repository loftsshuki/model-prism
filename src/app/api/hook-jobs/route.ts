import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminToken } from "@/lib/api-auth";
import { listHookJobs, upsertHookJob } from "@/lib/db";
import { idField, parseBody, serverError } from "@/lib/api-validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const unauthorized = requireAdminToken(req);
  if (unauthorized) return unauthorized;

  try {
    const jobs = await listHookJobs();
    return NextResponse.json({ jobs });
  } catch (error) {
    // A real 500 (not a 200 with an error field) so the dashboard and monitoring see the outage.
    return serverError("hook jobs GET", error, "Failed to load hook jobs");
  }
}

const HookJobBody = z.object({
  id: idField,
  planFile: z.string().min(1).max(1000),
  status: z.enum(["pending", "running", "completed", "failed"]),
  runId: idField.nullable().optional(),
  cost: z.number().nonnegative().nullable().optional(),
  models: z.array(z.string().max(200)).max(100).nullable().optional(),
  error: z.string().max(10_000).nullable().optional(),
  logs: z.string().max(200_000).nullable().optional(),
});

export async function POST(req: NextRequest) {
  const unauthorized = requireAdminToken(req);
  if (unauthorized) return unauthorized;

  const body = await parseBody(req, HookJobBody);
  if (!body.ok) return body.response;

  try {
    await upsertHookJob({
      id: body.data.id,
      planFile: body.data.planFile,
      status: body.data.status,
      runId: body.data.runId ?? null,
      cost: body.data.cost ?? 0,
      models: body.data.models ?? null,
      error: body.data.error ?? null,
      logs: body.data.logs ?? null,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return serverError("hook jobs POST", error, "Failed to save hook job");
  }
}
