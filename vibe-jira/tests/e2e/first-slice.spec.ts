import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("create a task, move it, and see persisted history", async ({ page }) => {
  const summary = `Browser slice ${Date.now()}`;
  await page.goto("/login");
  await page
    .getByLabel("Email")
    .fill(process.env.E2E_EMAIL ?? "admin@vibe.local");
  await page
    .getByLabel("Password")
    .fill(process.env.E2E_PASSWORD ?? "vibe-development-only");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/projects$/);
  await page.getByRole("link", { name: /Engineering/ }).click();
  await page.getByRole("button", { name: "+ Create task" }).click();
  await page.getByLabel("Summary").fill(summary);
  await page.locator('select[name="priority"]').selectOption("HIGH");
  await page.getByRole("button", { name: "Create", exact: true }).click();

  const card = page.getByRole("article").filter({ hasText: summary });
  await expect(card).toBeVisible();
  const moveButton = card.getByRole("button", {
    name: /Move [A-Z][A-Z0-9]+-\d+ to next column/,
  });
  const issueKey = (await moveButton.getAttribute("aria-label"))?.match(
    /[A-Z][A-Z0-9]+-\d+/,
  )?.[0];
  expect(issueKey).toBeTruthy();
  await moveButton.click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: `${issueKey} moved to In Progress.` }),
  ).toBeVisible();
  await card.getByRole("button", { name: summary }).click();
  const drawer = page.getByRole("dialog", { name: summary });
  await expect(drawer.getByText("In Progress", { exact: true })).toBeVisible();
  await expect(
    drawer.getByText(/moved it from Backlog to In Progress/),
  ).toBeVisible();
  await expect(drawer.getByText(/created this issue/)).toBeVisible();

  await page.reload();
  const refreshedDrawer = page.getByRole("dialog", { name: summary });
  await expect(
    refreshedDrawer.getByText(/moved it from Backlog to In Progress/),
  ).toBeVisible();
  await expect(refreshedDrawer.getByText(/created this issue/)).toBeVisible();

  const editedSummary = `${summary} edited`;
  const editedDescription = "Edited through the issue drawer";
  await refreshedDrawer.getByRole("button", { name: "Edit issue" }).click();
  await refreshedDrawer.getByLabel("Summary").fill(editedSummary);
  await refreshedDrawer.getByLabel("Description").fill(editedDescription);
  await refreshedDrawer.getByLabel("Priority").selectOption("CRITICAL");
  await refreshedDrawer.getByLabel("Assignee").selectOption({
    label: "Vibe Admin",
  });
  await refreshedDrawer.getByRole("button", { name: "Save changes" }).click();

  const updatedDrawer = page.getByRole("dialog", { name: editedSummary });
  await expect(updatedDrawer.getByText(editedDescription)).toBeVisible();
  await expect(
    updatedDrawer.getByText("CRITICAL", { exact: true }),
  ).toBeVisible();
  await expect(
    updatedDrawer.getByText("Vibe Admin", { exact: true }),
  ).toBeVisible();
  await expect(
    updatedDrawer.getByText(
      /updated summary, description, priority, and assignee/,
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("article").filter({ hasText: editedSummary }),
  ).toBeVisible();

  await page.reload();
  const persistedEdit = page.getByRole("dialog", { name: editedSummary });
  await expect(persistedEdit.getByText(editedDescription)).toBeVisible();
  await expect(
    persistedEdit.getByText(
      /updated summary, description, priority, and assignee/,
    ),
  ).toBeVisible();

  const accessibility = await new AxeBuilder({ page }).analyze();
  const seriousViolations = accessibility.violations.filter(
    (violation) =>
      violation.impact === "serious" || violation.impact === "critical",
  );
  expect(seriousViolations).toEqual([]);
});
