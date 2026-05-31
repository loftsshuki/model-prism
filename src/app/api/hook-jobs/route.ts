import { NextRequest, NextResponse } from "next/server";
import { requireAdminToken } from "@/lib/api-auth";
import { listHookJobs, upsertHookJob } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const unauthorized = requireAdminToken(req);
  if (unauthorized) return unauthorized;

  try {
    const jobs = await listHookJobs();
    return NextResponse.json({ jobs });
  } catch (error) {
    return NextResponse.json({ jobs: [], error: error instanceof Error ? error.message : "Failed to load hook jobs" });
  }
}

export async function POST(req: NextRequest) {
  const unauthorized = requireAdminToken(req);
  if (unauthorized) return unauthorized;

  const body = await req.json();
  if (!body.id || !body.planFile || !body.status) {
    return NextResponse.json({ error: "Missing id, planFile, or status" }, { status: 400 });
  }

  try {
    await upsertHookJob({
      id: body.id,
      planFile: body.planFile,
      status: body.status,
      runId: body.runId ?? null,
      cost: body.cost ?? 0,
      models: Array.isArray(body.models) ? body.models : null,
      error: body.error ?? null,
      logs: body.logs ?? null,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to save hook job" }, { status: 500 });
  }
}
