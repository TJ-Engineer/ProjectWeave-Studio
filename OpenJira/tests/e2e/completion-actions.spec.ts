import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

const demoPassword = process.env.E2E_PASSWORD ?? "vibe-development-only";

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page
    .getByLabel("Email")
    .fill(process.env.E2E_EMAIL ?? "admin@vibe.local");
  await page.getByLabel("Password").fill(demoPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/projects$/);
}

async function issueKey(card: Locator): Promise<string> {
  const key = (await card.textContent())?.match(/[A-Z][A-Z0-9]+-\d+/)?.[0];
  expect(key).toBeTruthy();
  return key!;
}

async function moveToNextColumn(card: Locator, key: string): Promise<void> {
  await card
    .getByRole("button", { name: `Move ${key} to next column` })
    .click();
}

async function moveThroughReview(card: Locator, key: string): Promise<void> {
  await moveToNextColumn(card, key);
  await card.getByRole("button", { name: `Move ${key} to Review` }).click();
}

test("Story COAs generate Tasks and enforce accessible completion controls", async ({
  page,
}) => {
  const suffix = Date.now().toString(36).toUpperCase().slice(-7);
  const projectKey = `C${suffix}`;
  const storySummary = `COA release ${suffix}`;
  await login(page);
  await page.getByLabel("Project name").fill(`COA browser ${suffix}`);
  await page.getByLabel("Project key").fill(projectKey);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/projects/${projectKey}/boards/[a-f0-9-]+$`),
  );

  await page.getByRole("button", { name: "+ Create issue" }).click();
  const createDialog = page.getByRole("dialog", { name: "Create issue" });
  await createDialog.getByLabel("Summary").fill(storySummary);
  await createDialog.getByLabel("Type").selectOption("STORY");
  const newAction = createDialog.getByLabel("New completion action");
  await newAction.fill("Implement release");
  await createDialog.getByRole("button", { name: "Add action" }).click();
  await newAction.fill("Verify release");
  await createDialog.getByRole("button", { name: "Add action" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    createDialog.getByRole("checkbox", { name: /is incomplete/ }),
  ).toHaveCount(2);
  const createAccessibility = await new AxeBuilder({ page })
    .include(".issue-dialog")
    .analyze();
  expect(
    createAccessibility.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);
  await createDialog
    .getByRole("button", { name: "Create", exact: true })
    .click();

  const storyCard = page.getByRole("article").filter({ hasText: storySummary });
  const implementationCard = page
    .getByRole("article")
    .filter({ hasText: "Implement release" });
  const verificationCard = page
    .getByRole("article")
    .filter({ hasText: "Verify release" });
  await expect(storyCard).toBeVisible();
  await expect(implementationCard).toBeVisible();
  await expect(verificationCard).toBeVisible();

  await storyCard.getByRole("button", { name: storySummary }).click();
  let drawer = page.getByRole("dialog", { name: storySummary });
  let checklist = drawer.getByRole("region", {
    name: "Completion actions (COAs)",
  });
  await expect(checklist.getByText("0/2", { exact: true })).toBeVisible();
  await expect(
    checklist.getByRole("button", {
      name: new RegExp(`Open Task ${projectKey}-`),
    }),
  ).toHaveCount(2);

  const firstRow = checklist.locator(".completion-action-list li").first();
  await firstRow.getByLabel("Completion action 1").fill("Build release");
  await firstRow.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByRole("article").filter({ hasText: "Build release" }),
  ).toBeVisible();

  checklist = page
    .getByRole("dialog", { name: storySummary })
    .getByRole("region", { name: "Completion actions (COAs)" });
  await checklist.getByLabel("Add completion action").fill("Publish notes");
  await checklist.getByRole("button", { name: "Add action" }).click();
  await expect(checklist.locator(".completion-action-list li")).toHaveCount(3);
  page.once("dialog", (dialog) => void dialog.accept());
  await checklist
    .getByLabel("Completion action 3")
    .locator("xpath=ancestor::li")
    .getByRole("button", { name: "Remove" })
    .click();
  await expect(checklist.locator(".completion-action-list li")).toHaveCount(2);

  drawer = page.getByRole("dialog", { name: storySummary });
  await drawer.getByRole("button", { name: "Close issue details" }).click();
  const storyKey = await issueKey(storyCard);
  await moveThroughReview(storyCard, storyKey);
  await moveToNextColumn(storyCard, storyKey);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Complete 2 remaining COA tasks" }),
  ).toBeVisible();

  for (const taskCard of [
    page.getByRole("article").filter({ hasText: "Build release" }),
    verificationCard,
  ]) {
    const taskKey = await issueKey(taskCard);
    await moveThroughReview(taskCard, taskKey);
    await moveToNextColumn(taskCard, taskKey);
    await expect(
      page.getByRole("status").filter({ hasText: `${taskKey} moved to Done.` }),
    ).toBeVisible();
  }

  await storyCard.getByRole("button", { name: storySummary }).click();
  drawer = page.getByRole("dialog", { name: storySummary });
  checklist = drawer.getByRole("region", { name: "Completion actions (COAs)" });
  const completedCheckboxes = checklist.getByRole("checkbox");
  await expect(completedCheckboxes).toHaveCount(2);
  await expect(completedCheckboxes.nth(0)).toBeChecked();
  await expect(completedCheckboxes.nth(1)).toBeChecked();
  await expect(checklist.getByText("2/2", { exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "Close issue details" }).click();
  await moveToNextColumn(storyCard, storyKey);
  await expect(
    page.getByRole("status").filter({ hasText: `${storyKey} moved to Done.` }),
  ).toBeVisible();

  await storyCard.getByRole("button", { name: storySummary }).click();
  drawer = page.getByRole("dialog", { name: storySummary });
  checklist = drawer.getByRole("region", { name: "Completion actions (COAs)" });
  await checklist.getByRole("checkbox").first().focus();
  await page.keyboard.press("Space");
  await expect(
    checklist.getByRole("alert").filter({ hasText: `Reopen ${storyKey}` }),
  ).toBeVisible();

  await page.setViewportSize({ width: 320, height: 900 });
  const reflow = await drawer.evaluate((element) => ({
    clientWidth: element.clientWidth,
    offenders: Array.from(element.querySelectorAll<HTMLElement>("*"))
      .flatMap((candidate) => {
        const rectangle = candidate.getBoundingClientRect();
        const drawerRectangle = element.getBoundingClientRect();
        return rectangle.right > drawerRectangle.right + 1
          ? [
              {
                className: candidate.className,
                right: Math.round(rectangle.right),
                tagName: candidate.tagName,
                width: Math.round(rectangle.width),
              },
            ]
          : [];
      })
      .slice(0, 12),
    scrollWidth: element.scrollWidth,
  }));
  expect(
    reflow.scrollWidth,
    `Overflowing drawer elements: ${JSON.stringify(reflow.offenders)}`,
  ).toBeLessThanOrEqual(reflow.clientWidth + 1);
  const drawerAccessibility = await new AxeBuilder({ page })
    .include(".issue-drawer")
    .analyze();
  expect(
    drawerAccessibility.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);
});
