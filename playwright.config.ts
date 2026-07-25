import { defineConfig } from "@playwright/test";

// Remote-browser support (doc 13): run the browser in a grid deployed on the
// ORES clusters instead of locally. Playwright talks to a remote Playwright
// browser server via connectOptions.wsEndpoint (PW_CONNECT_WS); it also honors
// SELENIUM_REMOTE_URL natively for a Selenium Grid (Chromium), which needs no
// config here. When neither is set it launches a local Chromium as before.
const PW_CONNECT_WS = process.env.PW_CONNECT_WS;

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
