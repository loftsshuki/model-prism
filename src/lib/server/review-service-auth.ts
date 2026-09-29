import { NextRequest } from "next/server";
import { privateJson } from "@/lib/server/http";
import {
  authenticateReviewServiceToken,
  bearerReviewServiceToken,
  serviceTokenHasScope,
  type ReviewServiceScope,
} from "@/lib/server/review-service-token-store";

export async function requireReviewService(req: NextRequest, scope: ReviewServiceScope) {
  const token = bearerReviewServiceToken(req.headers.get("authorization"));
  if (!token) {
    return {
      auth: null,
      response: privateJson({ error: "Review Fabric service token required" }, 401),
    };
  }
  const auth = await authenticateReviewServiceToken(token);
  if (!auth) {
    return {
      auth: null,
      response: privateJson({ error: "Review Fabric service token is invalid or revoked" }, 401),
    };
  }
  if (!serviceTokenHasScope(auth.scopes, scope)) {
    return {
      auth: null,
      response: privateJson({ error: "Service token lacks required scope: " + scope }, 403),
    };
  }
  return { auth, response: null };
}