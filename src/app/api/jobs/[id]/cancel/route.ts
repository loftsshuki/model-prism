import { NextRequest, NextResponse } from "next/server";
import { requireAdminToken } from "@/lib/api-auth";
import { serverError } from "@/lib/api-validate";
import { cancelReviewJob, getReviewJob } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = requireAdminToken(req);
  if (unauthorized) return unauthorized;

  const { id } = await params;
  try {
    const job = await cancelReviewJob(id);
    if (job) return NextResponse.json({ job: { ...job, step: { ...job.step, judge: undefined } } });

    // Not cancellable: distinguish "no such job" from "already finished".
    const existing = await getReviewJob(id);
    if (!existing) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    return NextResponse.json({ error: `Job is already ${existing.status}` }, { status: 409 });
  } catch (error) {
    return serverError("cancel job", error, "Failed to cancel job");
  }
}
