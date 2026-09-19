import { NextRequest } from "next/server";
import { start } from "workflow/api";
import { z } from "zod";
import { requireAdminToken, requestOwner, sameOrigin } from "@/lib/api-auth";
import { BackgroundReviewSchema } from "@/lib/review-policy";
import { fetchModelCatalog } from "@/lib/model-catalog";
import { getRun } from "@/lib/db";
import { startBackgroundReview } from "@/lib/server/background-store";
import { limitedJson, privateJson, reviewError } from "@/lib/server/http";
import { backgroundReview } from "@/workflows/review";

export const runtime = "nodejs";
export const maxDuration = 60;
const RequestSchema = z.object({ submissionId: z.string().uuid(), review: BackgroundReviewSchema, apiKey: z.string().trim().regex(/^sk-or-[a-zA-Z0-9_-]+$/, "Supply a valid OpenRouter API key").max(500) });

export async function POST(req: NextRequest) {
  const denied = requireAdminToken(req) ?? sameOrigin(req);
  if (denied) return denied;
  const owner = await requestOwner(req);
  if (!owner) return privateJson({ error: "Connect your key to start a private background review" }, 401);
  const parsed = RequestSchema.safeParse(await limitedJson(req).catch(() => null));
  if (!parsed.success) return privateJson({ error: parsed.error.issues[0]?.message ?? "Invalid review request" }, 400);
  if (!process.env.MODEL_PRISM_ENCRYPTION_KEY) return privateJson({ error: "Background review is not configured on this deployment" }, 503);
  try {
    const keyCheck = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${parsed.data.apiKey}` }, signal: AbortSignal.timeout(10000), cache: "no-store" });
    if (!keyCheck.ok) return privateJson({ error: "OpenRouter could not validate this key. Check its access and try again." }, keyCheck.status === 401 || keyCheck.status === 403 ? 401 : 503);
    const catalog = await fetchModelCatalog();
    const job = await startBackgroundReview(parsed.data.review, owner, parsed.data.apiKey, catalog, parsed.data.submissionId);
    if (job.started) {
      try { await start(backgroundReview, [job.id, job.execution]); }
      catch {
        // A dispatch failure can be ambiguous. Leave the job queued so a retry
        // cannot launch another paid execution. Recovery retains any reservation.
        return privateJson({ id: job.id, queued: true, warning: "Dispatch could not be confirmed. The review is saved; check its status before retrying." }, 202);
      }
    }
    const run = await getRun(job.id, owner);
    return privateJson({ id: job.id, started: job.started, snapshot: run?.snapshot }, 202);
  } catch (error) { return reviewError(error); }
}
