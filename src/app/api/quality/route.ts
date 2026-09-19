import { NextRequest } from "next/server";
import { requireAdminToken, requestOwner } from "@/lib/api-auth";
import { humanModelQuality } from "@/lib/server/finding-store";
import { privateJson, reviewError } from "@/lib/server/http";

export async function GET(req: NextRequest) {
  const denied = requireAdminToken(req); if (denied) return denied;
  const owner = await requestOwner(req);
  if (!owner) return privateJson({ models: [], error: "Connect your private review history to see confirmed outcomes" }, 401);
  try { return privateJson({ models: await humanModelQuality(owner), minimumReviewed: 5 }); }
  catch (error) { return reviewError(error); }
}
