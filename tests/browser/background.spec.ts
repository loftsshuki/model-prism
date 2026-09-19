import { test, expect } from "@playwright/test";
import catalog from "../../src/lib/model-catalog.json";
import { getCouncilModels, SYNTHESIS_IDS } from "../../src/lib/model-catalog";
import type { RunCheckpoint } from "../../src/lib/run-checkpoint";

test("background review restores after closing the tab and saves a finding decision", async ({ page, context }, testInfo) => {
  const models = getCouncilModels("balanced");
  const now = new Date().toISOString();
  const snapshot: RunCheckpoint = { version: 1, id: "run_background_fixture", revision: 1, createdAt: now, updatedAt: now,
    content: "SELECT * FROM runs", prompt: "Review", context: "", reasoningEffort: "medium", status: "running", models, responses: [], usage: [],
    synthesisModel: SYNTHESIS_IDS.sonnet, maxCost: 1.5, maxTokens: 8192, synthesisMaxTokens: 16384,
    background: { execution: 1, state: "running", phase: "Reviewing" }, projectKey: "owner/repo" };
  const finding = { id: "f1", title: "Missing owner filter", severity: "high", recommendation: "Scope the query", supportingModels: [`model:${models[0].id}`], evidence: [{ source: "file:query.ts", quote: "SELECT * FROM runs" }], evidenceVerified: true } as const;
  let decision = "open", requestBody: Record<string, unknown> = {}, stops = 0;
  await context.addInitScript(() => sessionStorage.setItem("openrouter-api-key", "sk-or-test-fixture"));
  await context.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/models") return route.fulfill({ json: { models: catalog.models, checkedAt: catalog.checkedAt, stale: false } });
    if (url.pathname === "/api/reviews/capabilities") return route.fulfill({ json: { background: true } });
    if (url.pathname === "/api/reviews") { requestBody = route.request().postDataJSON().review; return route.fulfill({ status: 202, json: { id: snapshot.id, snapshot } }); }
    if (url.pathname.endsWith("/stop")) { stops++; return route.fulfill({ json: { stopping: true } }); }
    if (url.pathname.endsWith("/findings")) {
      if (route.request().method() === "PATCH") { decision = route.request().postDataJSON().state; return route.fulfill({ json: { saved: true } }); }
      return route.fulfill({ json: { findings: [{ fingerprint: "a".repeat(32), finding, state: decision, note: "", change: "new", updatedAt: now,
        locations: [{ sourceId: "file:query.ts", path: "query.ts", startLine: 12, endLine: 12, url: `https://github.com/owner/repo/blob/${"a".repeat(40)}/query.ts#L12-L12` }] }] } });
    }
    if (url.pathname === `/api/runs/${snapshot.id}`) return route.fulfill({ json: { run: { id: snapshot.id, snapshot } } });
    return route.fulfill({ json: { runs: [] } });
  });
  await page.goto("/");
  await page.getByLabel("Content to review", { exact: true }).fill("SELECT * FROM runs");
  await expect(page.getByLabel("Keep running after you close this tab")).toBeChecked();
  await expect(page.getByLabel("Adaptive council:", { exact: false })).not.toBeChecked();
  await page.getByTestId("run-button").click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  expect(requestBody.adaptive).toBe(false);
  expect(requestBody.modelIds).toHaveLength(5);
  await page.close();
  expect(stops).toBe(0);
  snapshot.status = "complete"; snapshot.background!.state = "complete"; snapshot.background!.phase = "Review complete"; snapshot.revision++;
  snapshot.synthesis = { masterDocument: "## Background review complete", findings: [{ ...finding, evidence: [...finding.evidence], supportingModels: [...finding.supportingModels] }], consensus: [], uniqueInsights: [], disagreements: [], blindSpots: [], themeMatrix: [] };
  const restored = await context.newPage();
  await restored.goto(`/?resume=${snapshot.id}`);
  await restored.getByRole("button", { name: "Restore review", exact: true }).click();
  await expect(restored.getByRole("heading", { name: "Master Synthesis", exact: true })).toBeVisible();
  await expect(restored.getByRole("link", { name: "query.ts:12", exact: true })).toHaveAttribute("href", /^https:\/\/github\.com\/owner\/repo\/blob\/[a-f0-9]{40}\/query.ts#L12-L12$/);
  await restored.getByLabel("Decision for Missing owner filter").selectOption("accepted");
  await restored.getByRole("button", { name: "Save decision", exact: true }).click();
  await expect.poll(() => decision).toBe("accepted");
  await expect(restored.getByText("Saved", { exact: true })).toBeVisible();
  expect(await restored.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await restored.screenshot({ path: testInfo.outputPath("background-findings.png"), fullPage: true });
});
