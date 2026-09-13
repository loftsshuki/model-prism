import { test, expect, type Page } from "@playwright/test";
import snapshot from "../../src/lib/model-catalog.json";

const master = `## Review complete\n\nNo critical security blocker found.\n\n<img src=x onerror="window.__prism_xss=1">\n\n[Unsafe](javascript:alert(1))\n\n| Evidence | State |\n|---|---|\n| Supplied code | Checked |`;
async function setup(page: Page, options: { delay?: boolean; saveFailure?: boolean } = {}) {
  const calls: Array<{ model: string; messages: Array<{ content: string }>; tools?: unknown[] }> = [];
  const saves: Array<{ id: string; content: string; status: string; usage: Array<{ cost: number }>; responses: unknown[] }> = [];
  await page.addInitScript(() => sessionStorage.setItem("openrouter-api-key", "test-key"));
  await page.route("**/api/**", async (route) => {
    if (route.request().url().includes("/api/models")) return route.fulfill({ json: { models: snapshot.models, checkedAt: snapshot.checkedAt, stale: false } });
    if (route.request().method() === "PUT") {
      saves.push(route.request().postDataJSON());
      return route.fulfill({ status: options.saveFailure ? 503 : 200, json: { saved: !options.saveFailure } });
    }
    return route.fulfill({ json: { runs: [], jobs: [], leaderboard: [], diagnostics: [], recommendations: [], runCount: 0 } });
  });
  await page.route("https://openrouter.ai/api/v1/chat/completions", async (route) => {
    const body = route.request().postDataJSON(); calls.push(body);
    if (options.delay) await new Promise((resolve) => setTimeout(resolve, 1000));
    const message = body.tools ? { tool_calls: [{ id: "t", type: "function", function: { name: "synthesis", arguments: JSON.stringify({ masterDocument: master, findings: [], consensus: [], uniqueInsights: [], disagreements: [], blindSpots: [], themeMatrix: [] }) } }] } : { content: `Reviewed ${body.messages.at(-1).content}` };
    await route.fulfill({ json: { model: body.model, choices: [{ finish_reason: body.tools ? "tool_calls" : "stop", message }], usage: { prompt_tokens: 100, completion_tokens: 50, cost: body.tools ? 0.05 : 0.02 } } }).catch(() => {});
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "API key", exact: true })).toBeVisible();
  return { calls, saves };
}
async function tab(page: Page, name: "Setup" | "Results") {
  const button = page.getByRole("tab", { name: new RegExp(`^${name}`) });
  if (await button.isVisible()) await button.click();
}

test("safe synthesis, accurate cost, immutable input, and local resume", async ({ page }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  const { calls, saves } = await setup(page);
  await page.getByLabel("Content to review", { exact: true }).fill("PLAN_A_FIXTURE");
  await page.getByTestId("run-button").click();
  await expect(page.getByRole("heading", { name: "Master Synthesis", exact: true })).toBeVisible();
  expect(calls).toHaveLength(6);
  await expect(page.getByText("$0.150 recorded", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "__prism_xss"))).toBeUndefined();
  expect(await page.locator('a[href^="javascript:"]').count()).toBe(0);
  expect(await page.locator('img[src="x"]').count()).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("results.png") });
  await tab(page, "Setup");
  await page.getByLabel("Content to review", { exact: true }).fill("PLAN_B_FIXTURE");
  await expect(page.getByTestId("run-button")).toHaveText("Run edited input");
  await page.getByTestId("run-button").click();
  await expect.poll(() => calls.length).toBe(12);
  await expect(page.getByRole("heading", { name: "Master Synthesis", exact: true })).toBeVisible();
  await expect.poll(() => saves.filter((run) => run.status === "complete").length).toBeGreaterThanOrEqual(2);
  const completed = saves.filter((run) => run.status === "complete");
  expect(new Set(completed.map((run) => run.id)).size).toBe(2);
  expect(calls[11].messages[0].content).not.toContain("PLAN_A_FIXTURE");
  await page.reload();
  await page.getByRole("button", { name: "Restore review" }).click();
  await expect(page.getByRole("heading", { name: "Master Synthesis", exact: true })).toBeVisible();
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("run-button")).toBeEnabled();
  expect(calls).toHaveLength(12);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("stop prevents synthesis and save failure remains recoverable", async ({ page }) => {
  const { calls } = await setup(page, { delay: true, saveFailure: true });
  await page.getByLabel("Content to review", { exact: true }).fill("CANCEL_FIXTURE");
  await page.getByTestId("run-button").click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByTestId("run-button")).toBeEnabled();
  await expect(page.getByText("Stopped. Completed answers", { exact: false })).toBeVisible();
  expect(calls.every((call) => !call.tools)).toBe(true);
  await expect(page.getByRole("button", { name: "Retry save" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Restore review" })).toBeVisible();
});

test("responsive navigation and selected controls remain usable", async ({ page }, testInfo) => {
  await setup(page);
  expect(await page.getByRole("button", { pressed: true }).count()).toBe(5);
  await expect(page.getByTestId("run-button")).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("setup.png") });
  for (const route of ["/settings", "/history", "/models", "/hooks"]) {
    await page.goto(route);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), route).toBe(true);
  }
});
