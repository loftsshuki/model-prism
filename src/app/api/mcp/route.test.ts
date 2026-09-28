import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { POST } from "./route";

function request(method: string, params: Record<string, unknown> = {}, id = 1) {
  return new NextRequest("https://model-prism.vercel.app/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

describe("Model Prism MCP transport", () => {
  test("negotiates the implemented 2025-06-18 lifecycle", async () => {
    const response = await POST(request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(body.result.serverInfo.name).toBe("model-prism");
  });

  test("does not advertise a newer lifecycle it has not implemented", async () => {
    const response = await POST(request("initialize", { protocolVersion: "2026-07-28" }));
    const body = await response.json();
    expect(body.result.protocolVersion).toBe("2025-06-18");
  });

  test("supports stateless ping", async () => {
    const response = await POST(request("ping"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: {} });
  });

  test("challenges protected tool discovery with RFC 9728 metadata", async () => {
    const response = await POST(request("tools/list"));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://model-prism.vercel.app/.well-known/oauth-protected-resource/mcp"',
    );
  });
});
