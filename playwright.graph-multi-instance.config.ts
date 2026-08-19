import { defineConfig } from "@playwright/test";

const PW_CONNECT_WS = process.env.PW_CONNECT_WS;

export default defineConfig({
  testDir: "./suites/playwright",
  globalSetup: "./harness/global-setup.ts",
  globalTeardown: "./harness/global-teardown.ts",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  use: {
    baseURL: process.env.ZED_E2E_WEB_URL ?? "http://127.0.0.1:48081",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...(PW_CONNECT_WS ? { connectOptions: { wsEndpoint: PW_CONNECT_WS } } : {}),
  },
});
