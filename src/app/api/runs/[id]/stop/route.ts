import { NextRequest } from "next/server";
import { requireAdminToken, requestOwner, sameOrigin } from "@/lib/api-auth";
import { stopBackgroundReview } from "@/lib/server/background-store";
import { privateJson, reviewError } from "@/lib/server/http";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireAdminToken(req) ?? sameOrigin(req);
  if (denied) return denied;
  const owner = await requestOwner(req);
  if (!owner) return privateJson({ error: "Private review access required" }, 401);
  try { await stopBackgroundReview((await params).id, owner); return privateJson({ stopping: true }); }
  catch (error) { return reviewError(error); }
}
