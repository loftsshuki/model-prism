import { describe, expect, test } from "bun:test";
import { MCP_TOOLS } from "./review-tools";

describe("Model Prism MCP tool surface", () => {
  test("exposes one paid review action and bounded review-management tools", () => {
    expect(MCP_TOOLS.map(tool => tool.name)).toEqual([
      "review_plan",
      "get_review",
      "list_reviews",
      "stop_review",
    ]);
    expect(MCP_TOOLS.find(tool => tool.name === "review_plan")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(MCP_TOOLS.find(tool => tool.name === "get_review")?.annotations.readOnlyHint).toBe(true);
    expect(MCP_TOOLS.find(tool => tool.name === "stop_review")?.annotations.destructiveHint).toBe(true);
  });

  test("caps caller-supplied review spend and source fan-in at the MCP schema", () => {
    const review = MCP_TOOLS.find(tool => tool.name === "review_plan");
    expect(review?.inputSchema.properties.maxCost).toMatchObject({ minimum: 0.25, maximum: 25 });
    expect(review?.inputSchema.properties.sources).toMatchObject({ type: "array", maxItems: 40 });
  });
});
