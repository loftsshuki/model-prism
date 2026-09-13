import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

const localChrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
export default defineConfig({
  testDir: "./tests/browser", timeout: 45000, workers: 1, fullyParallel: false,
  use: { baseURL: process.env.PRISM_TEST_URL ?? "http://127.0.0.1:3107", headless: true, trace: "retain-on-failure",
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? (existsSync(localChrome) ? localChrome : undefined) } },
  projects: [{ name: "desktop", use: { viewport: { width: 1440, height: 1000 } } }, { name: "mobile", use: { viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 1 } }],
  webServer: process.env.PRISM_TEST_URL ? undefined : { command: "npm run start -- --hostname 127.0.0.1 --port 3107", url: "http://127.0.0.1:3107", reuseExistingServer: !process.env.CI, timeout: 60000 },
});
