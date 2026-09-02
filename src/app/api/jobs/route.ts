import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAdminToken } from "@/lib/api-auth";
import { MAX_TEXT, parseBody, serverError, textField } from "@/lib/api-validate";
import { enqueueReviewJob, listReviewJobs } from "@/lib/db";
import { kickWorker } from "@/lib/job-worker";
import { ROSTERS } from "@/lib/rosters";
import type { ModelInfo } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ModelInfoBody = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  family: z.string().min(1).max(100),
  tier: z.enum(["frontier", "strong", "fast", "free"]),
  contextLength: z.number().int().nonnegative(),
  inputCostPer1k: z.number().nonnegative(),
  outputCostPer1k: z.number().nonnegative(),
});

// Either an explicit council or a named roster; the roster is resolved server-side
// so a caller (or a hook) does not need to ship the price table.
const CreateJobBody = z.object({
  content: textField.min(1),
  prompt: textField.min(1),
  models: z.array(ModelInfoBody).min(1).max(50).optional(),
  roster: z.enum(["default", "cheap"]).optional(),
  mode: z.enum(["legacy", "fusion"]).default("legacy"),
  context: z.string().max(MAX_TEXT).nullable().optional(),
}).refine((body) => (body.models?.length ?? 0) > 0 || body.roster, { message: "Provide `models` or `roster`", path: ["models"] });

export async function POST(req: NextRequest) {
  const unauthorized = requireAdminToken(req);
  if (unauthorized) return unauthorized;

  const body = await parseBody(req, CreateJobBody);
  if (!body.ok) return body.response;

  const models: ModelInfo[] = body.data.models?.length ? body.data.models : ROSTERS[body.data.roster ?? "default"];
  const jobId = `job_${randomUUID()}`;
  const runId = `run_${Date.now()}_${randomUUID().slice(0, 8)}`;

  try {
    await enqueueReviewJob({
      id: jobId,
      runId,
      content: body.data.content,
      prompt: body.data.prompt,
      models,
      mode: body.data.mode,
      context: body.data.context ?? null,
    });
  } catch (error) {
    return serverError("enqueue job", error, "Failed to enqueue job");
  }

  // Start the first step now; the cron tick is only the fallback.
  kickWorker(req);
  return NextResponse.json({ jobId, runId });
}

export async function GET(req: NextRequest) {
  const unauthorized = requireAdminToken(req);
  if (unauthorized) return unauthorized;

  try {
    const jobs = await listReviewJobs(50);
    // The stashed judge JSON can be tens of KB per job; the list only needs progress.
    return NextResponse.json({ jobs: jobs.map((job) => ({ ...job, step: { ...job.step, judge: undefined } })) });
  } catch (error) {
    return serverError("list jobs", error, "Failed to load jobs");
  }
}
