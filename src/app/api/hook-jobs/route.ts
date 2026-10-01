import { NextRequest, NextResponse } from "next/server";
import { requireAdminToken, requestOwner, sameOrigin } from "@/lib/api-auth";
import { z } from "zod";
import { listHookJobs, upsertHookJob } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const unauthorized = requireAdminToken(req);
  if (unauthorized) return unauthorized;

  try {
    const jobs = await listHookJobs(100, await requestOwner(req));
    return NextResponse.json({ jobs });
  } catch (error) {
    console.error("[hook-jobs] list failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ jobs: [], error: "Hook jobs are temporarily unavailable" }, { status: 503 });
  }
}

const HookJobSchema = z.object({
  id: z.string().trim().min(1).max(200),
  planFile: z.string().trim().min(1).max(1000),
  status: z.string().trim().min(1).max(50),
  runId: z.string().max(200).nullable().optional(),
  cost: z.number().finite().nonnegative().nullable().optional(),
  models: z.array(z.string().max(200)).max(50).nullable().optional(),
  error: z.string().max(10_000).nullable().optional(),
  logs: z.string().max(200_000).nullable().optional(),
});

export async function POST(req: NextRequest) {
  const unauthorized = requireAdminToken(req) ?? sameOrigin(req);
  if (unauthorized) return unauthorized;
  const owner = await requestOwner(req);
  if (!owner) return NextResponse.json({ error: "Private review access required" }, { status: 401 });

  let raw: unknown;
  try { raw = await req.json(); }
  catch { return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 }); }
  const parsed = HookJobSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json({ error: `Invalid hook job${issue?.path.length ? ` at ${issue.path.join(".")}` : ""}: ${issue?.message ?? "validation failed"}` }, { status: 400 });
  }
  const body = parsed.data;

  try {
    const saved = await upsertHookJob({
      id: body.id,
      planFile: body.planFile,
      status: body.status,
      runId: body.runId ?? null,
      cost: body.cost ?? 0,
      models: body.models ?? null,
      error: body.error ?? null,
      logs: body.logs ?? null,
    }, owner);
    if (!saved) return NextResponse.json({ error: "Hook job not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[hook-jobs] save failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Failed to save hook job" }, { status: 500 });
  }
}
