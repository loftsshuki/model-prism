import { z } from "zod";
import { NextRequest } from "next/server";
import { requireAdminToken, sameOrigin, signedInOwner } from "@/lib/api-auth";
import {
  deleteMcpProviderCredential,
  getMcpProviderCredentialStatus,
  saveMcpProviderCredential,
} from "@/lib/server/mcp-credential-store";
import { limitedJson, privateJson, reviewError } from "@/lib/server/http";

const Input = z.object({
  apiKey: z.string().trim().regex(/^sk-or-[a-zA-Z0-9_-]+$/, "Supply a valid OpenRouter API key").max(500),
}).strict();

async function ownerOrResponse(req: NextRequest) {
  const denied = requireAdminToken(req) ?? sameOrigin(req);
  if (denied) return { response: denied, owner: null };
  const owner = await signedInOwner();
  if (!owner) return { response: privateJson({ error: "Sign in to manage agent review access" }, 401), owner: null };
  return { response: null, owner };
}

export async function GET(req: NextRequest) {
  try {
    const auth = await ownerOrResponse(req);
    if (auth.response) return auth.response;
    return privateJson(await getMcpProviderCredentialStatus(auth.owner!));
  } catch (error) { return reviewError(error); }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await ownerOrResponse(req);
    if (auth.response) return auth.response;
    const parsed = Input.safeParse(await limitedJson(req).catch(() => null));
    if (!parsed.success) return privateJson({ error: parsed.error.issues[0]?.message ?? "Invalid credential" }, 400);
    const check = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${parsed.data.apiKey}` },
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    });
    if (!check.ok) return privateJson({ error: "OpenRouter could not validate this key. Check its access and try again." }, check.status === 401 || check.status === 403 ? 401 : 503);
    return privateJson(await saveMcpProviderCredential(auth.owner!, parsed.data.apiKey));
  } catch (error) { return reviewError(error); }
}

export async function DELETE(req: NextRequest) {
  try {
    const auth = await ownerOrResponse(req);
    if (auth.response) return auth.response;
    await deleteMcpProviderCredential(auth.owner!);
    return privateJson({ enabled: false });
  } catch (error) { return reviewError(error); }
}
