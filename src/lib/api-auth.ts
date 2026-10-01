import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { accountOwner } from "./account-identity";

export function runOwner(req: NextRequest): string | null {
  const token = req.headers.get("x-model-prism-owner") ?? "";
  return /^[a-f0-9]{64}$/.test(token) ? createHash("sha256").update(token).digest("hex") : null;
}

export async function signedInOwner(): Promise<string | null> {
  if (!process.env.CLERK_SECRET_KEY || !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) return null;
  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  return userId ? accountOwner(userId) : null;
}

/** Comma/space separated OAuth client ids allowed to call /api/mcp; empty means any client the user consents to. */
export function allowedOAuthClients(env: Record<string, string | undefined> = process.env): Set<string> | null {
  const ids = (env.MODEL_PRISM_MCP_ALLOWED_CLIENT_IDS ?? "").split(/[\s,]+/).filter(Boolean);
  return ids.length ? new Set(ids) : null;
}
export function oauthClientAllowed(clientId: string | null | undefined, env: Record<string, string | undefined> = process.env) {
  const allowed = allowedOAuthClients(env);
  return !allowed || (!!clientId && allowed.has(clientId));
}
const seenOAuthClients = new Set<string>();
let warnedOpenOAuth = false;

export async function oauthOwner(): Promise<string | null> {
  if (!process.env.CLERK_SECRET_KEY || !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) return null;
  const { auth } = await import("@clerk/nextjs/server");
  const { userId, clientId } = await auth({ acceptsToken: "oauth_token" });
  if (!userId) return null;
  // Dynamic client registration lets any app obtain a token once a user consents.
  // An allowlist pins MCP access to known agents (e.g. ChatGPT, Claude).
  if (!oauthClientAllowed(clientId)) {
    console.warn(`[mcp] rejected OAuth client ${clientId ?? "(none)"}: not in MODEL_PRISM_MCP_ALLOWED_CLIENT_IDS`);
    return null;
  }
  if (!allowedOAuthClients()) {
    if (!warnedOpenOAuth) { warnedOpenOAuth = true; console.warn("[mcp] MODEL_PRISM_MCP_ALLOWED_CLIENT_IDS is not set; any OAuth client a user authorizes can call /api/mcp."); }
    if (clientId && !seenOAuthClients.has(clientId) && seenOAuthClients.size < 1000) { seenOAuthClients.add(clientId); console.info(`[mcp] OAuth client in use: ${clientId}`); }
  }
  return accountOwner(userId);
}

export async function requestOwner(req: NextRequest): Promise<string | null> {
  const account = await signedInOwner();
  if (account) return account;
  const legacy = runOwner(req);
  if (!legacy) return null;
  const { legacyOwnerIsClaimed } = await import("./server/account-store");
  return await legacyOwnerIsClaimed(legacy) ? null : legacy;
}

export function sameOrigin(req: NextRequest) {
  const origin = req.headers.get("origin");
  // Next may use its internal hostname in nextUrl behind a proxy. The Host
  // header identifies the origin the browser actually addressed.
  const host = req.headers.get("host");
  const protocol = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  let expected = req.nextUrl.origin;
  try { if (host && ["http", "https"].includes(protocol)) expected = new URL(`${protocol}://${host}`).origin; }
  catch { return NextResponse.json({ error: "Invalid request host" }, { status: 403 }); }
  if (origin && origin !== expected) return NextResponse.json({ error: "Request origin is not allowed" }, { status: 403 });
  if (req.headers.get("sec-fetch-site") === "cross-site") return NextResponse.json({ error: "Cross-site request is not allowed" }, { status: 403 });
  return null;
}

export function matchesSecret(provided: string, expected: string | undefined) {
  if (!expected) return false;
  const a = Buffer.from(provided), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requireAdminToken(req: NextRequest) {
  const expected = process.env.MODEL_PRISM_ADMIN_TOKEN;
  if (!expected) return null;

  const provided = req.headers.get("x-model-prism-token") || "";
  if (matchesSecret(provided, expected)) return null;

  return NextResponse.json(
    { error: "Unauthorized. Set the Model Prism admin token in Settings." },
    { status: 401 }
  );
}
