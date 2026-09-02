import { NextRequest, NextResponse } from "next/server";
import { requireAdminToken } from "@/lib/api-auth";
import { serverError } from "@/lib/api-validate";
import { getReviewJob, listRunResponses } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = requireAdminToken(req);
  if (unauthorized) return unauthorized;

  const { id } = await params;
  try {
    const job = await getReviewJob(id);
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

    // Per-model status from the responses table (the durable record), not the step JSON.
    const rows = await listRunResponses(job.run_id);
    const responses = rows.map((row) => ({
      model: row.model,
      modelName: row.model_name ?? row.model,
      status: row.error ? "error" : "complete",
      error: row.error,
      cost: row.cost,
      timeMs: row.time_ms,
    }));
    return NextResponse.json({ job: { ...job, step: { ...job.step, judge: undefined } }, responses });
  } catch (error) {
    return serverError("get job", error, "Failed to load job");
  }
}
