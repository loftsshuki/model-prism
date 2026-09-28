import { NextRequest, NextResponse } from "next/server";

function headers() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Cache-Control": "public, max-age=300",
  };
}

export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  return NextResponse.json({
    resource: `${origin}/api/mcp`,
    authorization_servers: [`${origin}/__clerk`],
    scopes_supported: ["openid", "profile", "email", "offline_access"],
    resource_documentation: `${origin}/docs/mcp`,
  }, { headers: headers() });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: headers() });
}
