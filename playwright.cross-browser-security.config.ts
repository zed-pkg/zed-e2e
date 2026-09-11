import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./suites/playwright",
  globalSetup: "./harness/global-setup.ts",
  globalTeardown: "./harness/global-teardown.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"], ["html", { open: "never" }]],
  projects: [
    { name: "chromium-security", use: { browserName: "chromium" } },
    { name: "firefox-security", use: { browserName: "firefox" } },
    { name: "webkit-security", use: { browserName: "webkit" } },
  ],
  use: {
    baseURL: process.env.ZED_E2E_WEB_URL ?? "http://127.0.0.1:48081",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
