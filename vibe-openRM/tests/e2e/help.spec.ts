import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.locator(".topbar").getByRole("button", { name: "Help" }).click();
  await expect(page.getByRole("heading", { name: "OpenRM user manual" })).toBeVisible();
});

test("opens from the persistent dashboard control and navigates the manual", async ({ page }) => {
  const contents = page.getByRole("navigation", { name: "User manual table of contents" });
  await expect(contents.getByRole("link", { name: /Requirements authoring/ })).toBeVisible();
  await contents.getByRole("link", { name: /Requirements authoring/ }).click();
  await expect(page.getByRole("heading", { name: "Requirements authoring", exact: true })).toBeInViewport();

  await page.getByLabel("Search this manual").fill("access denied");
  await expect(page.getByRole("status")).toContainText("section");
  await expect(page.getByRole("heading", { name: "Troubleshooting", exact: true })).toBeVisible();
});

test("has no automatically detectable WCAG A or AA violations", async ({ page }) => {
  const results = await new AxeBuilder({ page })
    .include(".page-stage")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations.map((violation) => ({
    id: violation.id,
    targets: violation.nodes.flatMap((node) => node.target),
  }))).toEqual([]);
});

test("keeps the manual usable without horizontal overflow on a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  const contents = page.getByRole("navigation", { name: "User manual table of contents" });
  await expect(contents.getByRole("link", { name: /Getting started/ })).toBeVisible();
  await expect(page.getByLabel("Search this manual")).toBeVisible();

  const horizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(horizontalOverflow).toBeLessThanOrEqual(1);
});
