import { NextRequest, NextResponse } from "next/server";
import { serverError } from "@/lib/api-validate";
import { claimNextReviewJob } from "@/lib/db";
import { isActiveJobStatus } from "@/lib/job-types";
import { authorizeWorker, kickWorker } from "@/lib/job-worker";
import { advanceJob } from "@/lib/jobs";

// The worker: claim one job, advance it one step, re-schedule. Invoked by the
// Vercel cron every minute (vercel.json) and by the self-kick after each step, so
// a run progresses continuously without any browser tab open.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Headroom under maxDuration for the claim, the final writes and the self-kick.
const WORKER_BUDGET_MS = 240_000;

async function work(req: NextRequest) {
  const unauthorized = authorizeWorker(req);
  if (unauthorized) return unauthorized;

  try {
    const job = await claimNextReviewJob();
    if (!job) return NextResponse.json({ advanced: null, status: "idle" });

    // The browser never sends a key for server-side runs; a missing server key fails the job clearly.
    const result = await advanceJob(job, { openrouterKey: process.env.OPENROUTER_API_KEY, budgetMs: WORKER_BUDGET_MS });

    // More steps to run: kick again so the run does not wait for the next cron tick.
    if (isActiveJobStatus(result.status)) kickWorker(req);

    return NextResponse.json({ advanced: result.id, status: result.status, phase: result.step.phase });
  } catch (error) {
    return serverError("jobs worker", error, "Worker step failed");
  }
}

export async function GET(req: NextRequest) {
  return work(req);
}

export async function POST(req: NextRequest) {
  return work(req);
}
