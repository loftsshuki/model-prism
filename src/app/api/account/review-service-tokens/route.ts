import { z } from "zod";
import { NextRequest } from "next/server";
import { requireAdminToken, sameOrigin, signedInOwner } from "@/lib/api-auth";
import { getMcpProviderCredentialStatus } from "@/lib/server/mcp-credential-store";
import {
  REVIEW_SERVICE_SCOPES,
  createReviewServiceToken,
  listReviewServiceTokens,
  revokeReviewServiceToken,
} from "@/lib/server/review-service-token-store";
import { limitedJson, privateJson, reviewError } from "@/lib/server/http";

const CreateInput = z.object({
  label: z.string().trim().min(1).max(100).default("HOSS"),
  scopes: z.array(z.enum(REVIEW_SERVICE_SCOPES)).min(1).max(REVIEW_SERVICE_SCOPES.length).optional(),
}).strict();

const DeleteInput = z.object({
  tokenId: z.string().regex(/^svc_[0-9a-f-]{36}$/),
}).strict();

async function ownerOrResponse(req: NextRequest) {
  const denied = requireAdminToken(req) ?? sameOrigin(req);
  if (denied) return { response: denied, owner: null };
  const owner = await signedInOwner();
  if (!owner) return { response: privateJson({ error: "Sign in to manage service review access" }, 401), owner: null };
  return { response: null, owner };
}

export async function GET(req: NextRequest) {
  try {
    const auth = await ownerOrResponse(req);
    if (auth.response) return auth.response;
    return privateJson({ tokens: await listReviewServiceTokens(auth.owner!) });
  } catch (error) { return reviewError(error); }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await ownerOrResponse(req);
    if (auth.response) return auth.response;
    const credential = await getMcpProviderCredentialStatus(auth.owner!);
    if (!credential.enabled) {
      return privateJson({ error: "Enable agent review access and save an OpenRouter key before creating a HOSS service token." }, 409);
    }
    const parsed = CreateInput.safeParse(await limitedJson(req).catch(() => null));
    if (!parsed.success) return privateJson({ error: parsed.error.issues[0]?.message ?? "Invalid service-token request" }, 400);
    const created = await createReviewServiceToken(
      auth.owner!,
      parsed.data.label,
      parsed.data.scopes ?? REVIEW_SERVICE_SCOPES,
    );
    return privateJson({
      ...created,
      warning: "Copy this token now. Model Prism stores only its hash and cannot show the token again.",
    }, 201);
  } catch (error) { return reviewError(error); }
}

export async function DELETE(req: NextRequest) {
  try {
    const auth = await ownerOrResponse(req);
    if (auth.response) return auth.response;
    const parsed = DeleteInput.safeParse(await limitedJson(req).catch(() => null));
    if (!parsed.success) return privateJson({ error: parsed.error.issues[0]?.message ?? "Invalid token identity" }, 400);
    await revokeReviewServiceToken(auth.owner!, parsed.data.tokenId);
    return privateJson({ revoked: true, tokenId: parsed.data.tokenId });
  } catch (error) { return reviewError(error); }
}
