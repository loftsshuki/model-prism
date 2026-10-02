import { test, expect, type Page } from "@playwright/test";
import snapshot from "../../src/lib/model-catalog.json";

const master = `## Review complete\n\nNo critical security blocker found.\n\n<img src=x onerror="window.__prism_xss=1">\n\n[Unsafe](javascript:alert(1))\n\n| Evidence | State |\n|---|---|\n| Supplied code | Checked |`;
async function setup(page: Page, options: { delay?: boolean; saveFailure?: boolean; routes?: (page: Page) => Promise<void>; path?: string } = {}) {
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
  // Registered last so these handlers win over the generic /api mock.
  await options.routes?.(page);
  await page.goto(options.path ?? "/");
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

test("a spending limit that cannot pay for synthesis is refused before any spend", async ({ page }) => {
  const { calls } = await setup(page);
  await page.getByLabel("Content to review", { exact: true }).fill("BUDGET_FIXTURE");
  await page.getByLabel("Spending limit (USD)").fill("1");
  await page.getByTestId("run-button").click();
  await expect(page.getByRole("alert").filter({ hasText: "Raise the spending limit to at least" })).toBeVisible();
  expect(calls).toHaveLength(0);
});

test("leaving during a browser run asks first, and a confirmed exit saves the stopped run", async ({ page }) => {
  const { saves } = await setup(page, { delay: true });
  await page.getByLabel("Content to review", { exact: true }).fill("LEAVE_FIXTURE");
  await page.getByTestId("run-button").click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("link", { name: "History", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("link", { name: "History", exact: true }).click();
  await expect(page).toHaveURL(/\/history$/);
  await expect.poll(() => saves.some((run) => run.content === "LEAVE_FIXTURE" && run.status === "stopped")).toBe(true);
});

function backgroundSnapshot(id: string, state: "running" | "stopped", content = "BACKGROUND_FIXTURE") {
  const now = new Date().toISOString();
  return { version: 1, id, revision: 3, createdAt: now, updatedAt: now, content, prompt: "Review this", context: "", reasoningEffort: "medium",
    status: state === "running" ? "running" : "stopped", models: [], responses: [], usage: [], synthesisModel: "anthropic/claude-fable-5", maxCost: 5, maxTokens: 4096, synthesisMaxTokens: 8192,
    background: { execution: 1, state, phase: state === "running" ? "Council reviewing" : "Stopped" } };
}

test("Stop pressed while a background review is still starting stops it once queued", async ({ page }) => {
  const stops: string[] = [];
  let stopped = false;
  await setup(page, { routes: async page => {
    await page.route("**/api/reviews/capabilities", route => route.fulfill({ json: { background: true } }));
    await page.route("**/api/reviews", async route => {
      if (route.request().method() !== "POST") return route.fallback();
      await new Promise(resolve => setTimeout(resolve, 1500));
      await route.fulfill({ json: { id: "run_pending_stop", snapshot: backgroundSnapshot("run_pending_stop", "running") } }).catch(() => {});
    });
    await page.route("**/api/runs/run_pending_stop/stop", route => { stops.push(route.request().method()); stopped = true; return route.fulfill({ json: { ok: true } }); });
    await page.route("**/api/runs/run_pending_stop", route => route.fulfill({ json: { run: { snapshot: backgroundSnapshot("run_pending_stop", stopped ? "stopped" : "running") } } }));
  } });
  await page.getByLabel("Content to review", { exact: true }).fill("BACKGROUND_FIXTURE");
  await page.getByTestId("run-button").click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByText("Stopping as soon as the server confirms", { exact: false })).toBeVisible();
  await expect.poll(() => stops.length).toBe(1);
  await expect(page.getByTestId("run-button")).toBeEnabled();
});

test("a gateway error page when starting a background review shows the status, not a JSON error", async ({ page }) => {
  await setup(page, { routes: async page => {
    await page.route("**/api/reviews/capabilities", route => route.fulfill({ json: { background: true } }));
    await page.route("**/api/reviews", route => route.request().method() === "POST"
      ? route.fulfill({ status: 502, contentType: "text/html", body: "<html><body>Bad gateway</body></html>" })
      : route.fallback());
  } });
  await page.getByLabel("Content to review", { exact: true }).fill("GATEWAY_FIXTURE");
  await page.getByTestId("run-button").click();
  await expect(page.getByRole("alert").filter({ hasText: "Unable to start review (502)" })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "JSON" })).toHaveCount(0);
  await expect(page.getByTestId("run-button")).toBeEnabled();
});

test("opening live controls for a running background review attaches to it directly", async ({ page }) => {
  let reads = 0;
  await setup(page, { path: "/?resume=run_live_controls", routes: async page => {
    await page.route("**/api/runs/run_live_controls", route => { reads++; return route.fulfill({ json: { run: { snapshot: backgroundSnapshot("run_live_controls", "running", "LIVE_FIXTURE") } } }); });
  } });
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Restore review" })).toHaveCount(0);
  await expect.poll(() => reads, { timeout: 10000 }).toBeGreaterThanOrEqual(2);
});
