import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  timeout: 60_000,
  workers: process.env.PLAYWRIGHT_MATRIX ? 1 : undefined,
  retries: 0,
  reporter: "line",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
    headless: true,
    trace: "retain-on-failure",
  },
  projects: process.env.PLAYWRIGHT_MATRIX
    ? [
        { name: "chromium", use: { browserName: "chromium" } },
        { name: "firefox", use: { browserName: "firefox" } },
        { name: "webkit", use: { browserName: "webkit" } },
      ]
    : [
        {
          name: "local-chrome",
          use: { channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome" },
        },
      ],
});
