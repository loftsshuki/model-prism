import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminToken } from "@/lib/api-auth";
import { idField, parseBody, serverError } from "@/lib/api-validate";
import { listFindingFeedback, saveFindingFeedback } from "@/lib/db";
import { summarizeFeedback } from "@/lib/feedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FeedbackBody = z.object({
  runId: idField.nullable().optional(),
  findingId: z.string().regex(/^f_[0-9a-f]{12}$/, "findingId must be a stable finding id (f_ + 12 hex)"),
  claim: z.string().max(2000).nullable().optional(),
  section: z.enum(["consensus", "uniqueInsight", "blindSpot", "strategicBlindSpot", "disagreement", "finding"]).nullable().optional(),
  models: z.array(z.string().max(200)).max(50).nullable().optional(),
  vote: z.union([z.literal(1), z.literal(-1)]),
  note: z.string().max(2000).nullable().optional(),
});

/** Record a thumbs up/down on a finding. */
export async function POST(req: NextRequest) {
  const unauthorized = requireAdminToken(req);
  if (unauthorized) return unauthorized;

  const body = await parseBody(req, FeedbackBody);
  if (!body.ok) return body.response;

  try {
    await saveFindingFeedback({
      runId: body.data.runId ?? null,
      findingId: body.data.findingId,
      claim: body.data.claim ?? null,
      section: body.data.section ?? null,
      models: body.data.models ?? null,
      vote: body.data.vote,
      note: body.data.note ?? null,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return serverError("feedback POST", error, "Failed to save feedback");
  }
}

/** Feedback for one run (`?runId=`) or the aggregate per-model feedback score. */
export async function GET(req: NextRequest) {
  const unauthorized = requireAdminToken(req);
  if (unauthorized) return unauthorized;

  const runId = req.nextUrl.searchParams.get("runId") ?? undefined;
  try {
    const rows = await listFindingFeedback({ runId });
    return NextResponse.json({ feedback: rows, byModel: summarizeFeedback(rows) });
  } catch (error) {
    return serverError("feedback GET", error, "Failed to load feedback");
  }
}
