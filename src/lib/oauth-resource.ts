import { NextResponse } from "next/server";

/** Scopes the MCP endpoint asks for; Clerk issues them to dynamically registered clients. */
export const MCP_OAUTH_SCOPES = ["openid", "profile", "email", "offline_access"];

type Env = Record<string, string | undefined>;

/** The Clerk Frontend API host encoded in a publishable key (`pk_<env>_<base64(host + "$")>`). */
export function clerkFrontendApi(publishableKey: string | undefined): string | null {
  const encoded = publishableKey?.match(/^pk_(?:test|live)_([A-Za-z0-9+/=_-]+)$/)?.[1];
  if (!encoded) return null;
  try {
    const decoded = Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const host = decoded.endsWith("$") ? decoded.slice(0, -1) : "";
    return /^[a-z0-9.-]+(?::\d+)?$/i.test(host) ? host : null;
  } catch { return null; }
}

/**
 * The OAuth authorization server clients should use. The `/__clerk` proxy only runs
 * for production keys (see proxy.ts); with a development key the metadata must name
 * Clerk's own Frontend API, or every client's discovery 404s.
 */
export function authorizationServer(origin: string, env: Env = process.env): string {
  const override = env.MODEL_PRISM_OAUTH_AUTHORIZATION_SERVER?.trim();
  if (override) return override.replace(/\/+$/, "");
  const key = env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  if (key?.startsWith("pk_live_")) return `${origin}/__clerk`;
  const frontendApi = clerkFrontendApi(key);
  return frontendApi ? `https://${frontendApi}` : `${origin}/__clerk`;
}

export function protectedResourceMetadata(origin: string, env: Env = process.env) {
  return {
    resource: `${origin}/api/mcp`,
    authorization_servers: [authorizationServer(origin, env)],
    scopes_supported: MCP_OAUTH_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "Model Prism MCP",
  };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
  "Cache-Control": "public, max-age=300",
};

export function protectedResourceResponse(origin: string) {
  return NextResponse.json(protectedResourceMetadata(origin), { headers: corsHeaders });
}
export function protectedResourceOptions() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
