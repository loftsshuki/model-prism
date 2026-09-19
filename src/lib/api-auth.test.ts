import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { sameOrigin, matchesSecret } from "./api-auth";

describe("request boundaries", () => {
  test("same-origin requests work behind Next's internal hostname", () => {
    expect(sameOrigin(new NextRequest("http://localhost:3000/api/reviews", { headers: { host: "model-prism.vercel.app", "x-forwarded-proto": "https", origin: "https://model-prism.vercel.app", "sec-fetch-site": "same-origin" } }))).toBeNull();
  });
  test("foreign origins and cross-site requests are rejected", () => {
    expect(sameOrigin(new NextRequest("https://model-prism.vercel.app/api/reviews", { headers: { host: "model-prism.vercel.app", origin: "https://other.example" } }))?.status).toBe(403);
    expect(sameOrigin(new NextRequest("https://model-prism.vercel.app/api/reviews", { headers: { "sec-fetch-site": "cross-site" } }))?.status).toBe(403);
  });
  test("secret comparison handles missing and different byte-length inputs", () => {
    expect(matchesSecret("test", undefined)).toBe(false);
    expect(matchesSecret("é", "a")).toBe(false);
    expect(matchesSecret("value", "value")).toBe(true);
    expect(matchesSecret("other", "value")).toBe(false);
  });
});
