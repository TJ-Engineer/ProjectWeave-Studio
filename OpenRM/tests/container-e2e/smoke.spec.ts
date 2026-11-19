import { expect, test } from "@playwright/test";

const pilotOrganizationId = "00000000-0000-4000-8000-000000000002";

test("serves the clean OpenRM workspace and administration surface", async ({ page, request }) => {
  const healthResponse = await request.get("/health");
  expect(healthResponse.ok()).toBeTruthy();
  await expect(healthResponse.json()).resolves.toMatchObject({ status: "ok" });

  const readyResponse = await request.get("/ready");
  expect(readyResponse.ok()).toBeTruthy();
  await expect(readyResponse.json()).resolves.toMatchObject({ status: "ready", database: "available" });

  const configResponse = await request.get("/openrm-config.json");
  expect(configResponse.ok()).toBeTruthy();
  await expect(configResponse.json()).resolves.toMatchObject({
    authMode: "development",
    organizationId: pilotOrganizationId,
    projectKey: "OPENRM",
    projectName: "OpenRM",
  });

  await page.goto("/");
  await expect(page.getByRole("combobox", { name: "Active project" })).toHaveValue("00000000-0000-4000-8000-000000000102");
  await page.getByRole("button", { name: "Open profile menu for Local user" }).click();
  const profileMenu = page.getByRole("menu", { name: "User profiles" });
  await expect(profileMenu.getByText("Local development")).toBeVisible();
  await expect(profileMenu.getByRole("menuitemradio", { name: /Local user/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(profileMenu).toBeHidden();
  await expect(page.getByRole("button", { name: /Overview/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Development/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /API & SDK/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Guided demo/ })).toHaveCount(0);
  await expect(page.getByText("Funding preview")).toHaveCount(0);

  await expect(page.getByRole("heading", { name: "Requirements workspace" })).toBeVisible();
  await expect(page.getByText("Live controlled workspace")).toBeVisible();

  await page.getByRole("button", { name: /Architecture/ }).click();
  await expect(page.getByRole("heading", { name: "OpenRM platform architecture" })).toBeVisible();
  await expect(page.getByText(/Fund the 90-day vertical slice/i)).toHaveCount(0);

  await page.getByRole("button", { name: /Administration/ }).click();
  await expect(page.getByRole("heading", { name: "Projects and people" })).toBeVisible();
  await expect(page.getByText("Live organization settings")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Invite a user" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Personal details" })).toBeVisible();
});
