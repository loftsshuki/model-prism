import { NextRequest, NextResponse } from "next/server";
import { publicErrorMessage } from "@/lib/server/http";
import { oauthOwner } from "@/lib/api-auth";
import { MCP_TOOLS, invokeMcpTool } from "@/lib/mcp/review-tools";

export const runtime = "nodejs";
export const maxDuration = 60;

const PROTOCOL_VERSION = "2025-06-18";
type RpcId = string | number | null;

function jsonRpc(id: RpcId, result: unknown, status = 200) {
  return NextResponse.json({ jsonrpc: "2.0", id, result }, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
    },
  });
}

function rpcError(id: RpcId, code: number, message: string, status = 200) {
  return NextResponse.json({ jsonrpc: "2.0", id, error: { code, message } }, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
    },
  });
}

function authChallenge(req: NextRequest, id: RpcId = null) {
  const origin = req.nextUrl.origin;
  return NextResponse.json({
    jsonrpc: "2.0",
    id,
    error: { code: -32001, message: "Authentication required" },
  }, {
    status: 401,
    headers: {
      "Cache-Control": "no-store",
      "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="openid profile email offline_access"`,
      "MCP-Protocol-Version": PROTOCOL_VERSION,
    },
  });
}

async function accountOwner(req: NextRequest, id: RpcId) {
  try {
    const owner = await oauthOwner();
    return owner ? { owner, response: null } : { owner: null, response: authChallenge(req, id) };
  } catch {
    return { owner: null, response: authChallenge(req, id) };
  }
}

function toolResult(value: unknown) {
  const text = JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text", text }],
    structuredContent: typeof value === "object" && value !== null ? value : { value },
    isError: false,
  };
}

function toolError(message: string) {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    const raw = await req.json();
    if (!raw || Array.isArray(raw) || typeof raw !== "object") return rpcError(null, -32600, "Invalid Request", 400);
    body = raw as Record<string, unknown>;
  } catch {
    return rpcError(null, -32700, "Parse error", 400);
  }

  const id = (typeof body.id === "string" || typeof body.id === "number" || body.id === null) ? body.id : null;
  const method = typeof body.method === "string" ? body.method : "";
  const params = body.params && typeof body.params === "object" && !Array.isArray(body.params)
    ? body.params as Record<string, unknown>
    : {};

  const auth = await accountOwner(req, id);
  if (auth.response) return auth.response;

  if (method === "initialize") {
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION;
    const protocolVersion = requested === PROTOCOL_VERSION ? requested : PROTOCOL_VERSION;
    return jsonRpc(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "model-prism", version: "1.0.0" },
      instructions: "Model Prism runs durable multi-model council reviews. Use review_plan for a frozen artifact, then poll get_review until the review is complete.",
    });
  }

  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return new NextResponse(null, { status: 202, headers: { "MCP-Protocol-Version": PROTOCOL_VERSION } });
  }

  if (method === "ping") return jsonRpc(id, {});

  if (method === "tools/list") {
    const securitySchemes = [{ type: "oauth2", scopes: ["openid", "profile", "email", "offline_access"] }];
    return jsonRpc(id, {
      tools: MCP_TOOLS.map(tool => ({
        ...tool,
        securitySchemes,
        _meta: { securitySchemes },
      })),
    });
  }

  if (method === "tools/call") {
    const name = typeof params.name === "string" ? params.name : "";
    const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
      ? params.arguments
      : {};
    try {
      return jsonRpc(id, toolResult(await invokeMcpTool(auth.owner!, name, args)));
    } catch (error) {
      return jsonRpc(id, toolError(publicErrorMessage(error)));
    }
  }

  return rpcError(id, -32601, `Method not found: ${method || "(missing)"}`);
}

export async function GET(req: NextRequest) {
  const auth = await accountOwner(req, null);
  if (auth.response) return auth.response;
  return new NextResponse(null, {
    status: 405,
    headers: {
      "Allow": "POST, OPTIONS",
      "Cache-Control": "no-store",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
    },
  });
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, MCP-Protocol-Version",
      "Access-Control-Max-Age": "86400",
    },
  });
}
