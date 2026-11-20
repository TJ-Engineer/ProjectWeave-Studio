import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/container-e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: "list",
  use: {
    baseURL: process.env.OPENRM_LOCAL_BASE_URL ?? "http://127.0.0.1:8080",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "container-chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
