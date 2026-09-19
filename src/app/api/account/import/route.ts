import { NextRequest } from "next/server";
import { requireAdminToken, runOwner, sameOrigin, signedInOwner } from "@/lib/api-auth";
import { importKeyHistory, previewHistoryImport } from "@/lib/server/account-store";
import { privateJson, reviewError } from "@/lib/server/http";

async function handle(req: NextRequest, apply: boolean) {
  const denied = requireAdminToken(req) ?? (apply ? sameOrigin(req) : null);
  if (denied) return denied;
  try {
    const owner = await signedInOwner();
    if (!owner) return privateJson({ error: "Sign in to import your history" }, 401);
    const legacy = runOwner(req);
    if (!legacy) return privateJson({ error: "Connect the OpenRouter key used for your previous reviews" }, 400);
    return privateJson(await (apply ? importKeyHistory(owner, legacy) : previewHistoryImport(owner, legacy)));
  } catch (error) { return reviewError(error); }
}
export const GET = (req: NextRequest) => handle(req, false);
export const POST = (req: NextRequest) => handle(req, true);
