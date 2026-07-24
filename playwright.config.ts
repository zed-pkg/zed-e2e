import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./suites/playwright",
  globalSetup: "./harness/global-setup.ts",
  globalTeardown: "./harness/global-teardown.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // The stack (postgres + two rust servers + CLI store) is shared state, so
  // suites run serially; individual specs are still isolated by org/package name.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.ZED_E2E_WEB_URL ?? "http://127.0.0.1:48081",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
