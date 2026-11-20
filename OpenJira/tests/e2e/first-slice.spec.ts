import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

const demoPassword = process.env.E2E_PASSWORD ?? "vibe-development-only";

async function login(
  page: Page,
  email: string,
  password = demoPassword,
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/projects$/);
}

async function logout(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
}

async function dragWithMouse(
  page: Page,
  source: Locator,
  destination: Locator,
): Promise<void> {
  await source.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  const destinationBox = await destination.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(destinationBox).not.toBeNull();
  if (!sourceBox || !destinationBox) return;
  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2,
    sourceBox.y + sourceBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 10, sourceBox.y, {
    steps: 3,
  });
  await page.mouse.move(
    destinationBox.x + destinationBox.width / 2,
    destinationBox.y + Math.min(destinationBox.height / 2, 150),
    { steps: 12 },
  );
  await page.mouse.up();
}

async function dragWithTouch(
  page: Page,
  source: Locator,
  destination: Locator,
): Promise<void> {
  await source.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  const viewport = page.viewportSize();
  expect(sourceBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (!sourceBox || !viewport) return;

  const start = {
    x: sourceBox.x + sourceBox.width / 2,
    y: sourceBox.y + sourceBox.height / 2,
  };
  const session = await page.context().newCDPSession(page);
  async function dispatchMove(
    from: { x: number; y: number },
    to: { x: number; y: number },
    steps: number,
  ) {
    for (let step = 1; step <= steps; step += 1) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          {
            x: from.x + ((to.x - from.x) * step) / steps,
            y: from.y + ((to.y - from.y) * step) / steps,
            id: 1,
            force: 1,
          },
        ],
      });
      await page.waitForTimeout(24);
    }
  }
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ ...start, id: 1, force: 1 }],
  });

  let destinationBox = await destination.boundingBox();
  expect(destinationBox).not.toBeNull();
  if (!destinationBox) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await session.detach();
    return;
  }

  const rightEdge = { x: viewport.width - 24, y: start.y };
  let current = start;
  if (destinationBox.x + destinationBox.width / 2 > rightEdge.x) {
    await dispatchMove(start, rightEdge, 10);
    current = rightEdge;
    const scroller = source.locator(
      "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' board-grid ')][1]",
    );
    for (let step = 0; step < 16; step += 1) {
      await scroller.evaluate((element) => {
        element.scrollLeft = Math.min(
          element.scrollLeft + 64,
          element.scrollWidth - element.clientWidth,
        );
      });
      await page.waitForTimeout(32);
      await dispatchMove(rightEdge, rightEdge, 1);
      destinationBox = (await destination.boundingBox()) ?? destinationBox;
      if (destinationBox.x + destinationBox.width / 2 <= rightEdge.x) break;
    }
  }

  const finish = {
    x: Math.max(
      24,
      Math.min(
        viewport.width - 24,
        destinationBox.x + destinationBox.width / 2,
      ),
    ),
    y: Math.min(
      viewport.height - 24,
      destinationBox.y + Math.min(destinationBox.height / 2, 150),
    ),
  };
  await dispatchMove(current, finish, 12);
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await session.detach();
}

test("create, move, and edit a task with persisted history", async ({
  page,
}) => {
  const suffix = Date.now().toString(36).toUpperCase().slice(-7);
  const projectKey = `S${suffix}`;
  const summary = `Browser slice ${suffix}`;
  await login(page, process.env.E2E_EMAIL ?? "admin@vibe.local");
  await page.getByLabel("Project name").fill(`Browser slice ${suffix}`);
  await page.getByLabel("Project key").fill(projectKey);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/projects/${projectKey}/boards/[a-f0-9-]+$`),
  );
  await page.getByRole("button", { name: "+ Create issue" }).click();
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
  const editedDescription =
    "## Edited through the issue drawer\n**Safe Markdown** [unsafe](javascript:alert(1)) <script>alert('x')</script>";
  await refreshedDrawer.getByRole("button", { name: "Edit issue" }).click();
  const editAccessibility = await new AxeBuilder({ page })
    .include(".issue-drawer")
    .analyze();
  expect(
    editAccessibility.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);
  await refreshedDrawer.getByLabel("Summary").fill(editedSummary);
  await refreshedDrawer.getByLabel("Description").fill(editedDescription);
  await refreshedDrawer.getByLabel("Priority").selectOption("CRITICAL");
  await refreshedDrawer.getByLabel("Assignee").selectOption({
    label: "Vibe Admin",
  });
  await refreshedDrawer.getByLabel("Estimate points").fill("8");
  await refreshedDrawer.getByLabel("Due date").fill("2030-01-15");
  await refreshedDrawer.getByRole("button", { name: "Save changes" }).click();

  const updatedDrawer = page.getByRole("dialog", { name: editedSummary });
  await expect(
    updatedDrawer.getByText("CRITICAL", { exact: true }),
  ).toBeVisible();
  await expect(
    updatedDrawer.getByRole("heading", {
      name: "Edited through the issue drawer",
    }),
  ).toBeVisible();
  await expect(
    updatedDrawer.getByText("Safe Markdown", { exact: true }),
  ).toBeVisible();
  await expect(updatedDrawer.locator("script")).toHaveCount(0);
  await expect(
    updatedDrawer.getByText("8 points", { exact: true }),
  ).toBeVisible();
  await expect(
    updatedDrawer.getByText("2030-01-15", { exact: true }),
  ).toBeVisible();
  const assigneeField = updatedDrawer
    .locator(".issue-fields > div")
    .filter({ hasText: "Assignee" });
  await expect(assigneeField.getByRole("definition")).toHaveText("Vibe Admin");
  await expect(
    updatedDrawer.getByText(
      /updated summary, description, priority, assignee, estimate, and due date/,
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("article").filter({ hasText: editedSummary }),
  ).toBeVisible();

  await page.reload();
  const persistedEdit = page.getByRole("dialog", { name: editedSummary });
  await expect(
    persistedEdit.getByRole("heading", {
      name: "Edited through the issue drawer",
    }),
  ).toBeVisible();
  await expect(
    persistedEdit.getByText(
      /updated summary, description, priority, assignee, estimate, and due date/,
    ),
  ).toBeVisible();

  const accessibility = await new AxeBuilder({ page }).analyze();
  const seriousViolations = accessibility.violations.filter(
    (violation) =>
      violation.impact === "serious" || violation.impact === "critical",
  );
  expect(seriousViolations).toEqual([]);
});

test("comment, mention, and watch an issue across two sessions", async ({
  browser,
  page,
}) => {
  const suffix = Date.now().toString(36).toUpperCase().slice(-7);
  const projectKey = `C${suffix}`;
  const projectName = `Collaboration ${suffix}`;
  const summary = `Discuss ${suffix}`;
  await login(page, process.env.E2E_EMAIL ?? "admin@vibe.local");
  await page.getByLabel("Project name").fill(projectName);
  await page.getByLabel("Project key").fill(projectKey);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/projects/${projectKey}/boards/[a-f0-9-]+$`),
  );
  const boardUrl = page.url();

  await page.getByRole("link", { name: "Manage members" }).click();
  const memberRow = page.getByRole("row").filter({ hasText: "Vibe Member" });
  await memberRow
    .getByLabel("Project role for Vibe Member")
    .selectOption("MEMBER");
  await memberRow.getByRole("button", { name: "Add to project" }).click();
  await page.getByRole("link", { name: "Back to board" }).click();

  await page.getByRole("button", { name: "+ Create issue" }).click();
  const createDialog = page.getByRole("dialog", { name: "Create issue" });
  await createDialog.getByLabel("Summary").fill(summary);
  await createDialog
    .getByLabel("Assignee")
    .selectOption({ label: "Vibe Member" });
  await createDialog
    .getByRole("button", { name: "Create", exact: true })
    .click();
  await page
    .getByRole("article")
    .filter({ hasText: summary })
    .getByRole("button", { name: summary })
    .click();
  const adminDrawer = page.getByRole("dialog", { name: summary });
  await adminDrawer.getByRole("button", { name: "Watch (0)" }).click();
  await expect(
    adminDrawer.getByRole("button", { name: "Unwatch (1)" }),
  ).toBeVisible();
  const unsafeText =
    "Please review @member@vibe.local <img src=x onerror=alert(1)>";
  await adminDrawer.getByLabel("Add comment").fill(unsafeText);
  const accessibility = await new AxeBuilder({ page })
    .include(".issue-drawer")
    .analyze();
  expect(
    accessibility.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);
  await adminDrawer.getByRole("button", { name: "Add comment" }).click();
  await expect(
    adminDrawer.getByText(unsafeText, { exact: true }),
  ).toBeVisible();
  await expect(adminDrawer.locator(".comment-list img")).toHaveCount(0);
  await expect(
    adminDrawer.getByRole("button", { name: "Unwatch (2)" }),
  ).toBeVisible();

  await adminDrawer.getByLabel("Attach a file").setInputFiles({
    name: `evidence-${suffix}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from(`attachment evidence ${suffix}`),
  });
  await adminDrawer.getByRole("button", { name: "Upload file" }).click();
  const cleanAttachment = adminDrawer.getByRole("link", {
    name: `evidence-${suffix}.txt`,
  });
  await expect(cleanAttachment).toBeVisible();
  const downloadUrl = await cleanAttachment.getAttribute("href");
  expect(downloadUrl).toBeTruthy();
  const download = await page.request.get(downloadUrl!);
  expect(download.ok()).toBe(true);
  expect(await download.text()).toBe(`attachment evidence ${suffix}`);

  await adminDrawer.getByLabel("Attach a file").setInputFiles({
    name: `scanner-check-${suffix}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from(
      "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
    ),
  });
  await adminDrawer.getByRole("button", { name: "Upload file" }).click();
  await expect(
    adminDrawer.getByText("The malware scanner rejected this file."),
  ).toBeVisible();
  const rejectedAttachment = adminDrawer
    .locator(".attachment-list li")
    .filter({ hasText: `scanner-check-${suffix}.txt` });
  await expect(rejectedAttachment).toContainText("rejected");
  await expect(rejectedAttachment.getByRole("link")).toHaveCount(0);
  page.once("dialog", (dialog) => void dialog.accept());
  await rejectedAttachment.getByRole("button", { name: "Remove" }).click();
  await expect(rejectedAttachment).toHaveCount(0);

  const memberContext = await browser.newContext({
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
  });
  const memberPage = await memberContext.newPage();
  try {
    await login(
      memberPage,
      process.env.E2E_MEMBER_EMAIL ?? "member@vibe.local",
    );
    await memberPage.getByRole("link", { name: /Notifications/ }).click();
    await expect(
      memberPage.getByRole("heading", { name: "Notifications" }),
    ).toBeVisible();
    await expect(
      memberPage.getByRole("button").filter({ hasText: summary }),
    ).toContainText("mentioned you");
    await memberPage.getByLabel("Watched issue comments").uncheck();
    await memberPage.getByRole("button", { name: "Save preferences" }).click();
    await expect(
      memberPage.getByText("Notification preferences saved."),
    ).toBeVisible();
    await memberPage.getByRole("button", { name: "Mark all read" }).click();
    await expect(
      memberPage.getByText("0 unread", { exact: true }),
    ).toBeVisible();
    const inboxAccessibility = await new AxeBuilder({
      page: memberPage,
    }).analyze();
    expect(
      inboxAccessibility.violations.filter(
        (violation) =>
          violation.impact === "serious" || violation.impact === "critical",
      ),
    ).toEqual([]);
    await memberPage.goto(boardUrl);
    await memberPage
      .getByRole("article")
      .filter({ hasText: summary })
      .getByRole("button", { name: summary })
      .click();
    const memberDrawer = memberPage.getByRole("dialog", { name: summary });
    await expect(
      memberDrawer.getByText(unsafeText, { exact: true }),
    ).toBeVisible();
    const reply = `Reviewed ${suffix}`;
    await memberDrawer.getByLabel("Add comment").fill(reply);
    await memberDrawer.getByRole("button", { name: "Add comment" }).click();
    await expect(memberDrawer.getByText(reply, { exact: true })).toBeVisible();
    await expect(adminDrawer.getByText(reply, { exact: true })).toBeVisible();
  } finally {
    await memberContext.close();
  }

  await adminDrawer.getByRole("button", { name: /Unwatch/ }).click();
  await expect(
    adminDrawer.getByRole("button", { name: "Watch (1)" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("dialog", { name: summary }).getByText(unsafeText, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("dialog", { name: summary })
      .getByRole("link", { name: `evidence-${suffix}.txt` }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close issue details" }).click();
  await page.getByRole("link", { name: /Notifications/ }).click();
  await expect(
    page.getByRole("button").filter({ hasText: summary }),
  ).toContainText("commented on a watched issue");
});

test("create and edit an Epic, standard issue, and Subtask hierarchy", async ({
  page,
}) => {
  const suffix = Date.now().toString(36).toUpperCase().slice(-7);
  const projectKey = `H${suffix}`;
  const projectName = `Hierarchy ${suffix}`;
  const epicSummary = `Release ${suffix}`;
  const storySummary = `Customer flow ${suffix}`;
  const subtaskSummary = `Wire form ${suffix}`;
  await login(page, process.env.E2E_EMAIL ?? "admin@vibe.local");

  await page.getByLabel("Project name").fill(projectName);
  await page.getByLabel("Project key").fill(projectKey);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/projects/${projectKey}/boards/[a-f0-9-]+$`),
  );

  await page.getByRole("button", { name: "+ Create issue" }).click();
  let createDialog = page.getByRole("dialog", { name: "Create issue" });
  await createDialog.getByLabel("Summary").fill(epicSummary);
  await createDialog.getByLabel("Type").selectOption("EPIC");
  await createDialog.getByLabel("Priority").selectOption("HIGH");
  await createDialog.getByLabel("Assignee").selectOption({
    label: "Vibe Admin",
  });
  await createDialog.locator('input[name="labels"]').fill("Roadmap, Urgent");
  await createDialog
    .getByRole("button", { name: "Create", exact: true })
    .click();

  const epicCard = page.getByRole("article").filter({ hasText: epicSummary });
  await expect(epicCard).toContainText("EPIC");
  await expect(epicCard).toContainText("Roadmap");
  const epicKey = (await epicCard.textContent())?.match(
    /[A-Z][A-Z0-9]+-\d+/,
  )?.[0];
  expect(epicKey).toBeTruthy();

  await page.getByRole("button", { name: "+ Create issue" }).click();
  createDialog = page.getByRole("dialog", { name: "Create issue" });
  await createDialog.getByLabel("Summary").fill(storySummary);
  await createDialog.getByLabel("Type").selectOption("STORY");
  await createDialog
    .getByLabel("Parent")
    .selectOption({ label: `${epicKey} · ${epicSummary}` });
  await createDialog.getByLabel("Assignee").selectOption({
    label: "Vibe Admin",
  });
  await createDialog
    .locator('input[name="labels"]')
    .fill("Customer Request, roadmap");
  await createDialog
    .getByRole("button", { name: "Create", exact: true })
    .click();

  const storyCard = page.getByRole("article").filter({ hasText: storySummary });
  await expect(storyCard).toContainText("STORY");
  const storyKey = (await storyCard.textContent())?.match(
    /[A-Z][A-Z0-9]+-\d+/,
  )?.[0];
  expect(storyKey).toBeTruthy();
  await storyCard.getByRole("button", { name: storySummary }).click();
  let drawer = page.getByRole("dialog", { name: storySummary });
  await expect(drawer.getByText("STORY", { exact: true })).toBeVisible();
  const parentField = drawer
    .locator(".issue-fields > div")
    .filter({ hasText: "Parent" });
  await expect(parentField).toContainText(`${epicKey} · ${epicSummary}`);
  await expect(
    drawer.getByText("Customer Request", { exact: true }),
  ).toBeVisible();
  await expect(drawer.getByText("Roadmap", { exact: true })).toBeVisible();

  await drawer.getByRole("button", { name: "Edit issue" }).click();
  await drawer.getByLabel("Type").selectOption("BUG");
  await drawer
    .getByLabel("Parent")
    .selectOption({ label: `${epicKey} · ${epicSummary}` });
  await drawer.locator('input[name="labels"]').fill("Backend, Roadmap");
  await drawer.getByRole("button", { name: "Save changes" }).click();
  drawer = page.getByRole("dialog", { name: storySummary });
  await expect(drawer.getByText("BUG", { exact: true })).toBeVisible();
  await expect(drawer.getByText("Backend", { exact: true })).toBeVisible();
  await expect(drawer.getByText(/updated type and labels/)).toBeVisible();
  await drawer.getByRole("button", { name: "Close issue details" }).click();

  await page.getByRole("button", { name: "+ Create issue" }).click();
  createDialog = page.getByRole("dialog", { name: "Create issue" });
  await createDialog.getByLabel("Summary").fill(subtaskSummary);
  await createDialog.getByLabel("Type").selectOption("SUBTASK");
  await expect(createDialog.getByLabel("Parent")).toHaveAttribute(
    "required",
    "",
  );
  await createDialog
    .getByLabel("Parent")
    .selectOption({ label: `${storyKey} · ${storySummary}` });
  const dialogAccessibility = await new AxeBuilder({ page })
    .include(".issue-dialog")
    .analyze();
  expect(
    dialogAccessibility.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);
  await createDialog
    .getByRole("button", { name: "Create", exact: true })
    .click();

  const subtaskCard = page
    .getByRole("article")
    .filter({ hasText: subtaskSummary });
  await expect(subtaskCard).toContainText("SUBTASK");
  await subtaskCard.getByRole("button", { name: subtaskSummary }).click();
  const subtaskDrawer = page.getByRole("dialog", { name: subtaskSummary });
  await expect(
    subtaskDrawer.locator(".issue-fields > div").filter({ hasText: "Parent" }),
  ).toContainText(storySummary);

  await page.reload();
  const persisted = page.getByRole("dialog", { name: subtaskSummary });
  await expect(persisted.getByText("SUBTASK", { exact: true })).toBeVisible();
  await expect(
    persisted.locator(".issue-fields > div").filter({ hasText: "Parent" }),
  ).toContainText(storySummary);
});

test("reorder cards within a column and persist the server-owned order", async ({
  page,
}) => {
  const suffix = Date.now().toString(36).toUpperCase().slice(-7);
  const projectKey = `R${suffix}`;
  const summaries = [
    `First ranked ${suffix}`,
    `Second ranked ${suffix}`,
    `Third ranked ${suffix}`,
  ] as const;
  await login(page, process.env.E2E_EMAIL ?? "admin@vibe.local");
  await page.getByLabel("Project name").fill(`Ranking ${suffix}`);
  await page.getByLabel("Project key").fill(projectKey);
  await page.getByRole("button", { name: "Create project" }).click();

  for (const summary of summaries) {
    await page.getByRole("button", { name: "+ Create issue" }).click();
    const dialog = page.getByRole("dialog", { name: "Create issue" });
    await dialog.getByLabel("Summary").fill(summary);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(
      page.getByRole("article").filter({ hasText: summary }),
    ).toBeVisible();
  }

  const thirdCard = page.getByRole("article").filter({ hasText: summaries[2] });
  const moveUp = thirdCard.getByRole("button", {
    name: `Move ${projectKey}-3 up within column`,
  });
  await moveUp.click();
  await expect(
    page.getByRole("status").filter({ hasText: `${projectKey}-3 reordered` }),
  ).toBeVisible();

  const todoCards = page
    .locator(".board-column")
    .filter({ has: page.getByRole("heading", { name: "To Do" }) })
    .getByRole("article");
  await expect(todoCards.nth(0)).toContainText(summaries[0]);
  await expect(todoCards.nth(1)).toContainText(summaries[2]);
  await expect(todoCards.nth(2)).toContainText(summaries[1]);

  await thirdCard.getByRole("button", { name: summaries[2] }).click();
  await expect(
    page
      .getByRole("dialog", { name: summaries[2] })
      .getByText("reordered this issue"),
  ).toBeVisible();
  await page.reload();
  const persistedCards = page
    .locator(".board-column")
    .filter({ has: page.getByRole("heading", { name: "To Do" }) })
    .getByRole("article");
  await expect(persistedCards.nth(0)).toContainText(summaries[0]);
  await expect(persistedCards.nth(1)).toContainText(summaries[2]);
  await expect(persistedCards.nth(2)).toContainText(summaries[1]);
});

test("pointer movement rolls back a rejected move and persists a valid move", async ({
  page,
}) => {
  const suffix = Date.now().toString(36).toUpperCase().slice(-7);
  const projectKey = `P${suffix}`;
  const summary = `Pointer card ${suffix}`;
  await login(page, process.env.E2E_EMAIL ?? "admin@vibe.local");
  await page.getByLabel("Project name").fill(`Pointer ${suffix}`);
  await page.getByLabel("Project key").fill(projectKey);
  await page.getByRole("button", { name: "Create project" }).click();

  await page.getByRole("button", { name: "+ Create issue" }).click();
  const dialog = page.getByRole("dialog", { name: "Create issue" });
  await dialog.getByLabel("Summary").fill(summary);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();

  const card = page.getByRole("article").filter({ hasText: summary });
  const handle = card.getByRole("button", { name: `Drag ${projectKey}-1` });
  const inProgress = page
    .locator(".board-column")
    .filter({ has: page.getByRole("heading", { name: "In Progress" }) });
  const todo = page
    .locator(".board-column")
    .filter({ has: page.getByRole("heading", { name: "To Do" }) });

  await page.route("**/api/v1/issues/*/transitions", async (route) => {
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "VERSION_CONFLICT",
          message: "Issue was changed by another user",
          correlationId: "e2e-rejected-move",
        },
      }),
    });
  });
  await dragWithMouse(page, handle, inProgress);
  await expect(
    page.getByRole("status").filter({
      hasText: "Issue was changed by another user",
    }),
  ).toBeVisible();
  await expect(
    todo.getByRole("article").filter({ hasText: summary }),
  ).toBeVisible();
  await expect(
    inProgress.getByRole("article").filter({ hasText: summary }),
  ).toHaveCount(0);

  await page.unroute("**/api/v1/issues/*/transitions");
  await dragWithMouse(page, handle, inProgress);
  await expect(
    page.getByRole("status").filter({ hasText: `${projectKey}-1 moved` }),
  ).toBeVisible();
  await expect(
    inProgress.getByRole("article").filter({ hasText: summary }),
  ).toBeVisible();
  await page.reload();
  await expect(
    inProgress.getByRole("article").filter({ hasText: summary }),
  ).toBeVisible();

  const movedCard = inProgress
    .getByRole("article")
    .filter({ hasText: summary });
  await movedCard
    .getByRole("button", { name: `Move ${projectKey}-1 to Review` })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: `${projectKey}-1 moved to Review` }),
  ).toBeVisible();
  await movedCard
    .getByRole("button", { name: `Move ${projectKey}-1 to next column` })
    .click();
  const done = page
    .locator(".board-column")
    .filter({ has: page.getByRole("heading", { name: "Done" }) });
  await expect(
    done.getByRole("article").filter({ hasText: summary }),
  ).toBeVisible();
  await dragWithMouse(
    page,
    done
      .getByRole("article")
      .filter({ hasText: summary })
      .getByRole("button", { name: `Drag ${projectKey}-1` }),
    todo,
  );
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: `workflow does not allow ${projectKey}-1` }),
  ).toBeVisible();
  await expect(
    done.getByRole("article").filter({ hasText: summary }),
  ).toBeVisible();
});

test("touch movement works at a mobile viewport and persists", async ({
  browser,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "Raw touch-event coverage uses the Chromium DevTools protocol",
  );
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const suffix = Date.now().toString(36).toUpperCase().slice(-7);
  const projectKey = `T${suffix}`;
  const summary = `Touch card ${suffix}`;
  try {
    await login(page, process.env.E2E_EMAIL ?? "admin@vibe.local");
    await page.getByLabel("Project name").fill(`Touch ${suffix}`);
    await page.getByLabel("Project key").fill(projectKey);
    await page.getByLabel("Project key").press("Enter");
    await expect(page).toHaveURL(
      new RegExp(`/projects/${projectKey}/boards/[a-f0-9-]+$`),
    );

    const created = await page.evaluate(
      async ({ projectKey, summary }) => {
        const response = await fetch(`/api/v1/projects/${projectKey}/issues`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": crypto.randomUUID(),
          },
          body: JSON.stringify({
            summary,
            description: "",
            priority: "MEDIUM",
            issueType: "TASK",
            assigneeId: null,
            labels: [],
            parentIssueKey: null,
          }),
        });
        return response.ok;
      },
      { projectKey, summary },
    );
    expect(created).toBe(true);
    await page.reload();

    const card = page.getByRole("article").filter({ hasText: summary });
    const inProgress = page
      .locator(".board-column")
      .filter({ has: page.getByRole("heading", { name: "In Progress" }) });
    await dragWithTouch(
      page,
      card.getByRole("button", { name: `Drag ${projectKey}-1` }),
      inProgress,
    );
    await expect(
      page.getByRole("status").filter({ hasText: `${projectKey}-1 moved` }),
    ).toBeVisible();
    await expect(
      inProgress.getByRole("article").filter({ hasText: summary }),
    ).toBeVisible();
    await page.reload();
    await expect(
      inProgress.getByRole("article").filter({ hasText: summary }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("a second browser session receives live board invalidations", async ({
  browser,
  page,
}) => {
  const suffix = Date.now().toString(36).toUpperCase().slice(-7);
  const projectKey = `L${suffix}`;
  const summary = `Live card ${suffix}`;
  await login(page, process.env.E2E_EMAIL ?? "admin@vibe.local");
  await page.getByLabel("Project name").fill(`Live ${suffix}`);
  await page.getByLabel("Project key").fill(projectKey);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/projects/${projectKey}/boards/[a-f0-9-]+$`),
  );
  const boardUrl = page.url();

  const secondContext = await browser.newContext({
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
  });
  const secondPage = await secondContext.newPage();
  try {
    await login(secondPage, process.env.E2E_EMAIL ?? "admin@vibe.local");
    await secondPage.goto(boardUrl);
    await expect(
      page.getByText("Live updates connected", { exact: true }),
    ).toBeVisible();
    await expect(
      secondPage.getByText("Live updates connected", { exact: true }),
    ).toBeVisible();
    await secondPage.getByLabel("Swimlanes").selectOption("assignee");

    await page.getByRole("button", { name: "+ Create issue" }).click();
    const dialog = page.getByRole("dialog", { name: "Create issue" });
    await dialog.getByLabel("Summary").fill(summary);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();

    const remoteUnassignedLane = secondPage.locator(".swimlane").filter({
      has: secondPage.getByRole("heading", {
        name: "Unassigned",
        exact: true,
      }),
    });
    const remoteCard = remoteUnassignedLane
      .getByRole("article")
      .filter({ hasText: summary });
    await expect(remoteCard).toBeVisible();
    const localCard = page.getByRole("article").filter({ hasText: summary });
    await localCard
      .getByRole("button", { name: `Move ${projectKey}-1 to next column` })
      .click();
    const remoteInProgress = remoteUnassignedLane
      .locator(".board-column")
      .filter({
        has: secondPage.getByRole("heading", { name: "In Progress" }),
      });
    await expect(
      remoteInProgress.getByRole("article").filter({ hasText: summary }),
    ).toBeVisible();
  } finally {
    await secondContext.close();
  }
});

test("window and filter a large board while preserving two-session updates", async ({
  browser,
  page,
}) => {
  test.setTimeout(120_000);
  const suffix = Date.now().toString(36).toUpperCase().slice(-7);
  const projectKey = `B${suffix}`;
  await login(page, process.env.E2E_EMAIL ?? "admin@vibe.local");
  await page.getByLabel("Project name").fill(`Large board ${suffix}`);
  await page.getByLabel("Project key").fill(projectKey);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/projects/${projectKey}/boards/[a-f0-9-]+$`),
  );
  const boardUrl = page.url();

  const failures = await page.evaluate(async (key) => {
    const failures: Array<{ number: number; status: number; body: string }> =
      [];
    for (let number = 1; number <= 105; number += 1) {
      const response = await fetch(`/api/v1/projects/${key}/issues`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          summary: `Scale card ${number}`,
          description: "",
          priority: number % 2 === 0 ? "HIGH" : "MEDIUM",
          issueType: "TASK",
          assigneeId: null,
          labels: number === 105 ? ["scale-target"] : [],
          parentIssueKey: null,
        }),
      });
      if (response.status !== 201) {
        failures.push({
          number,
          status: response.status,
          body: await response.text(),
        });
      }
    }
    return failures;
  }, projectKey);
  expect(failures).toEqual([]);
  await page.reload();

  await expect(page.getByRole("article")).toHaveCount(50);
  await expect(page.getByText("To Do: showing 50 of 105")).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);

  await page.getByRole("button", { name: "Load next 50" }).click();
  await expect(page.getByRole("article")).toHaveCount(100);
  await page.getByRole("button", { name: "Load next 50" }).click();
  await expect(page.getByRole("article")).toHaveCount(5);
  await expect(
    page.getByText(/To Do: showing 5 of 105 \(later window\)/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to first" }).click();
  await expect(page.getByRole("article")).toHaveCount(50);

  const search = page.getByPlaceholder("Filter issues…");
  await search.fill("Scale card 105");
  await expect(page.getByRole("article")).toHaveCount(1);
  await expect(page.getByRole("article")).toContainText("Scale card 105");
  await expect(page).toHaveURL(/q=Scale\+card\+105/);
  await page.reload();
  await expect(page.getByPlaceholder("Filter issues…")).toHaveValue(
    "Scale card 105",
  );
  await expect(page.getByRole("article")).toHaveCount(1);

  const remoteSummary = `Remote scale ${suffix}`;
  await page.getByPlaceholder("Filter issues…").fill(remoteSummary);
  await expect(page.getByRole("article")).toHaveCount(0);
  const secondContext = await browser.newContext({
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
  });
  const secondPage = await secondContext.newPage();
  try {
    await login(secondPage, process.env.E2E_EMAIL ?? "admin@vibe.local");
    await secondPage.goto(page.url());
    await expect(
      secondPage.getByText("Live updates connected", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "+ Create issue" }).click();
    const dialog = page.getByRole("dialog", { name: "Create issue" });
    await dialog.getByLabel("Summary").fill(remoteSummary);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(
      secondPage.getByRole("article").filter({ hasText: remoteSummary }),
    ).toBeVisible();
  } finally {
    await secondContext.close();
  }

  await page.goto(boardUrl);
});

test("group by epic and assignee swimlanes with shareable URL state", async ({
  page,
}) => {
  const suffix = Date.now().toString(36).toUpperCase().slice(-7);
  const projectKey = `S${suffix}`;
  const epicSummary = `Swimlane epic ${suffix}`;
  const storySummary = `Assigned story ${suffix}`;
  const secondStorySummary = `Second assigned ${suffix}`;
  const taskSummary = `No epic task ${suffix}`;
  await login(page, process.env.E2E_EMAIL ?? "admin@vibe.local");
  await page.getByLabel("Project name").fill(`Swimlanes ${suffix}`);
  await page.getByLabel("Project key").fill(projectKey);
  await page.getByRole("button", { name: "Create project" }).click();

  await page.getByRole("button", { name: "+ Create issue" }).click();
  let dialog = page.getByRole("dialog", { name: "Create issue" });
  await dialog.getByLabel("Summary").fill(epicSummary);
  await dialog.getByLabel("Type").selectOption("EPIC");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  const epicCard = page.getByRole("article").filter({ hasText: epicSummary });
  const epicKey = (await epicCard.textContent())?.match(
    /[A-Z][A-Z0-9]+-\d+/,
  )?.[0];
  expect(epicKey).toBeTruthy();

  for (const summary of [storySummary, secondStorySummary]) {
    await page.getByRole("button", { name: "+ Create issue" }).click();
    dialog = page.getByRole("dialog", { name: "Create issue" });
    await dialog.getByLabel("Summary").fill(summary);
    await dialog.getByLabel("Type").selectOption("STORY");
    await dialog
      .getByLabel("Parent")
      .selectOption({ label: `${epicKey} · ${epicSummary}` });
    await dialog.getByLabel("Assignee").selectOption({ label: "Vibe Admin" });
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
  }

  await page.getByRole("button", { name: "+ Create issue" }).click();
  dialog = page.getByRole("dialog", { name: "Create issue" });
  await dialog.getByLabel("Summary").fill(taskSummary);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();

  await page.getByLabel("Swimlanes").selectOption("epic");
  await expect(page).toHaveURL(/\?swimlane=epic$/);
  const epicLane = page.locator(".swimlane").filter({
    has: page.getByRole("heading", {
      name: `${epicKey} · ${epicSummary}`,
      exact: true,
    }),
  });
  const noEpicLane = page.locator(".swimlane").filter({
    has: page.getByRole("heading", { name: "No epic", exact: true }),
  });
  await expect(epicLane.getByRole("article")).toHaveCount(3);
  await expect(
    noEpicLane.getByRole("article").filter({ hasText: taskSummary }),
  ).toBeVisible();

  const filterResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      /\/api\/v1\/boards\/[^/]+\/issues$/.test(url.pathname) &&
      url.searchParams.get("q") === storySummary &&
      response.ok()
    );
  });
  await page.getByPlaceholder("Filter issues…").fill(storySummary);
  await filterResponse;
  await expect
    .poll(() => new URL(page.url()).searchParams.get("q"))
    .toBe(storySummary);
  await expect(epicLane.getByRole("article")).toHaveCount(1);
  await expect(noEpicLane).toBeVisible();
  await expect(noEpicLane.getByRole("article")).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("Swimlanes")).toHaveValue("epic");

  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByRole("article")).toHaveCount(4);
  await page.getByLabel("Swimlanes").selectOption("assignee");
  await expect(page).toHaveURL(/\?swimlane=assignee$/);
  const adminLane = page.locator(".swimlane").filter({
    has: page.getByRole("heading", { name: "Vibe Admin", exact: true }),
  });
  const unassignedLane = page.locator(".swimlane").filter({
    has: page.getByRole("heading", { name: "Unassigned", exact: true }),
  });
  await expect(adminLane.getByRole("article")).toHaveCount(2);
  await expect(unassignedLane.getByRole("article")).toHaveCount(2);

  const secondAssigned = adminLane
    .getByRole("article")
    .filter({ hasText: secondStorySummary });
  const secondAssignedKey = (await secondAssigned.textContent())?.match(
    /[A-Z][A-Z0-9]+-\d+/,
  )?.[0];
  expect(secondAssignedKey).toBeTruthy();
  const moveUp = secondAssigned.getByRole("button", {
    name: `Move ${secondAssignedKey} up within column`,
  });
  await moveUp.focus();
  await moveUp.press("Enter");
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: `${secondAssignedKey} reordered` }),
  ).toBeVisible();
  await expect(adminLane.getByRole("article").nth(0)).toContainText(
    secondStorySummary,
  );

  await secondAssigned
    .getByRole("button", {
      name: `Move ${secondAssignedKey} to next column`,
    })
    .press("Enter");
  const adminInProgress = adminLane
    .locator(".board-column")
    .filter({ has: page.getByRole("heading", { name: "In Progress" }) });
  await expect(
    adminInProgress
      .getByRole("article")
      .filter({ hasText: secondStorySummary }),
  ).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);
});

test("configure a non-blocking WIP warning that survives filtering and refresh", async ({
  page,
}) => {
  const suffix = Date.now().toString(36).toUpperCase().slice(-7);
  const projectKey = `W${suffix}`;
  await login(page, process.env.E2E_EMAIL ?? "admin@vibe.local");
  await page.getByLabel("Project name").fill(`WIP ${suffix}`);
  await page.getByLabel("Project key").fill(projectKey);
  await page.getByRole("button", { name: "Create project" }).click();

  await page.getByRole("link", { name: "WIP limits" }).click();
  await expect(
    page.getByRole("heading", { name: "Board and workflow" }),
  ).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);
  await page.getByLabel("WIP limit for To Do").fill("1");
  await page
    .getByRole("row")
    .filter({ hasText: "To Do" })
    .getByRole("button", { name: "Save limit" })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "To Do WIP limit set to 1." }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Back to board" }).click();

  for (const summary of [`Alpha WIP ${suffix}`, `Beta WIP ${suffix}`]) {
    await page.getByRole("button", { name: "+ Create issue" }).click();
    const dialog = page.getByRole("dialog", { name: "Create issue" });
    await dialog.getByLabel("Summary").fill(summary);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  const warning = page
    .locator(".board-column")
    .filter({ has: page.getByRole("heading", { name: "To Do" }) })
    .getByRole("status");
  await expect(warning).toHaveText("WIP limit exceeded: 2 of 1");

  await page.getByPlaceholder("Filter issues…").fill("Alpha WIP");
  await expect(
    page.getByRole("article").filter({ hasText: `Beta WIP ${suffix}` }),
  ).toHaveCount(0);
  await expect(warning).toHaveText("WIP limit exceeded: 2 of 1");
  await page.reload();
  await expect(warning).toHaveText("WIP limit exceeded: 2 of 1");

  const alpha = page
    .getByRole("article")
    .filter({ hasText: `Alpha WIP ${suffix}` });
  await alpha
    .getByRole("button", { name: new RegExp(`Move ${projectKey}-1 to next`) })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: `${projectKey}-1 moved` }),
  ).toBeVisible();
  await expect(warning).toHaveCount(0);
});

test("soft-delete an issue and restore its key and history", async ({
  page,
}) => {
  const suffix = Date.now().toString(36).toUpperCase().slice(-7);
  const projectKey = `D${suffix}`;
  const projectName = `Lifecycle ${suffix}`;
  const summary = `Recoverable work ${suffix}`;
  await login(page, process.env.E2E_EMAIL ?? "admin@vibe.local");

  await page.getByLabel("Project name").fill(projectName);
  await page.getByLabel("Project key").fill(projectKey);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/projects/${projectKey}/boards/[a-f0-9-]+$`),
  );

  await page.getByRole("button", { name: "+ Create issue" }).click();
  const createDialog = page.getByRole("dialog", { name: "Create issue" });
  await createDialog.getByLabel("Summary").fill(summary);
  await createDialog
    .getByRole("button", { name: "Create", exact: true })
    .click();
  const card = page.getByRole("article").filter({ hasText: summary });
  await expect(card).toBeVisible();
  const issueKey = (await card.textContent())?.match(/[A-Z][A-Z0-9]+-\d+/)?.[0];
  expect(issueKey).toBeTruthy();

  await card.getByRole("button", { name: summary }).click();
  const drawer = page.getByRole("dialog", { name: summary });
  page.once("dialog", (dialog) => void dialog.accept());
  await drawer.getByRole("button", { name: "Delete issue" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: `${issueKey} moved to deleted issues.` }),
  ).toBeVisible();
  await expect(card).toHaveCount(0);
  const hiddenRead = await page.evaluate(async (key) => {
    const response = await fetch(`/api/v1/issues/${key}`);
    return { status: response.status, body: await response.json() };
  }, issueKey!);
  expect(hiddenRead).toMatchObject({
    status: 404,
    body: { error: { code: "ISSUE_NOT_FOUND" } },
  });

  await page.getByRole("link", { name: "Deleted issues" }).click();
  await expect(
    page.getByRole("heading", { name: "Deleted issues" }),
  ).toBeVisible();
  const deletedRow = page.getByRole("row").filter({ hasText: summary });
  await expect(deletedRow).toContainText(issueKey!);
  await expect(deletedRow).toContainText("Vibe Admin");
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);
  await deletedRow.getByRole("button", { name: "Restore" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: `${issueKey} restored to the board.` }),
  ).toBeVisible();
  await expect(deletedRow).toHaveCount(0);

  await page.getByRole("link", { name: "Back to board" }).click();
  const restoredCard = page.getByRole("article").filter({ hasText: summary });
  await expect(restoredCard).toBeVisible();
  await expect(restoredCard).toContainText(issueKey!);
  await restoredCard.getByRole("button", { name: summary }).click();
  const restoredDrawer = page.getByRole("dialog", { name: summary });
  await expect(restoredDrawer.getByText(/created this issue/)).toBeVisible();
  await expect(restoredDrawer.getByText(/deleted this issue/)).toBeVisible();
  await expect(restoredDrawer.getByText(/restored this issue/)).toBeVisible();

  await page.reload();
  const persistedDrawer = page.getByRole("dialog", { name: summary });
  await expect(persistedDrawer.getByText(/deleted this issue/)).toBeVisible();
  await expect(persistedDrawer.getByText(/restored this issue/)).toBeVisible();
});

test("project admins manage roles while members and viewers stay constrained", async ({
  page,
}) => {
  const suffix = Date.now().toString(36).toUpperCase().slice(-7);
  const projectKey = `R${suffix}`;
  const projectName = `Role matrix ${suffix}`;
  const issueSummary = `Protected work ${suffix}`;
  await login(page, process.env.E2E_EMAIL ?? "admin@vibe.local");

  await page.getByLabel("Project name").fill(projectName);
  await page.getByLabel("Project key").fill(projectKey);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/projects/${projectKey}/boards/[a-f0-9-]+$`),
  );
  const boardUrl = page.url();

  await page.getByRole("button", { name: "+ Create issue" }).click();
  await page.getByLabel("Summary").fill(issueSummary);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    page.getByRole("article").filter({ hasText: issueSummary }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Manage members" }).click();
  await expect(
    page.getByRole("heading", { name: "Members and roles" }),
  ).toBeVisible();

  const memberRow = page.getByRole("row").filter({ hasText: "Vibe Member" });
  await memberRow
    .getByLabel("Project role for Vibe Member")
    .selectOption("MEMBER");
  await memberRow.getByRole("button", { name: "Add to project" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Vibe Member added as Member.",
  );

  const viewerRow = page.getByRole("row").filter({ hasText: "Vibe Viewer" });
  const viewerRole = viewerRow.getByLabel("Project role for Vibe Viewer");
  const viewerControlId = await viewerRole.getAttribute("id");
  const viewerUserId = viewerControlId?.replace("role-", "");
  expect(viewerUserId).toBeTruthy();
  await viewerRole.selectOption("MEMBER");
  await viewerRow.getByRole("button", { name: "Add to project" }).click();
  await viewerRole.selectOption("VIEWER");
  await viewerRow.getByRole("button", { name: "Save role" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Vibe Viewer updated as Viewer.",
  );

  page.once("dialog", (dialog) => void dialog.accept());
  await viewerRow.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Vibe Viewer removed from the project.",
  );
  await viewerRow.getByRole("button", { name: "Add to project" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Vibe Viewer added as Viewer.",
  );

  const settingsAccessibility = await new AxeBuilder({ page }).analyze();
  expect(
    settingsAccessibility.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);

  await logout(page);
  await login(page, process.env.E2E_MEMBER_EMAIL ?? "member@vibe.local");
  await page.goto(boardUrl);
  await expect(
    page.getByRole("button", { name: "+ Create issue" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Manage members" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("link", { name: "Deleted issues" })).toHaveCount(
    0,
  );
  const memberProtectedCard = page
    .getByRole("article")
    .filter({ hasText: issueSummary });
  await memberProtectedCard.getByRole("button", { name: issueSummary }).click();
  await expect(
    page.getByRole("button", { name: "Delete issue" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close issue details" }).click();
  const memberAttempt = await page.evaluate(
    async ({ key, userId }) => {
      const response = await fetch(
        `/api/v1/projects/${key}/members/${userId}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: "ADMIN" }),
        },
      );
      return { status: response.status, body: await response.json() };
    },
    { key: projectKey, userId: viewerUserId! },
  );
  expect(memberAttempt).toMatchObject({
    status: 403,
    body: { error: { code: "FORBIDDEN" } },
  });

  await logout(page);
  await login(page, process.env.E2E_VIEWER_EMAIL ?? "viewer@vibe.local");
  await page.goto(boardUrl);
  await expect(page).toHaveURL(boardUrl);
  await expect(
    page.getByRole("button", { name: "+ Create issue" }),
  ).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Manage members" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("link", { name: "Deleted issues" })).toHaveCount(
    0,
  );
  const protectedCard = page
    .getByRole("article")
    .filter({ hasText: issueSummary });
  await expect(protectedCard).toBeVisible();
  await expect(protectedCard.getByRole("button", { name: /Move/ })).toHaveCount(
    0,
  );
  await expect(protectedCard.getByRole("button", { name: /Drag/ })).toHaveCount(
    0,
  );
  await protectedCard.getByRole("button", { name: issueSummary }).click();
  await expect(page.getByLabel("Attach a file")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit issue" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete issue" })).toHaveCount(
    0,
  );

  const protectedIssueKey = (await protectedCard.textContent())?.match(
    /[A-Z][A-Z0-9]+-\d+/,
  )?.[0];
  expect(protectedIssueKey).toBeTruthy();
  const viewerDeleteAttempt = await page.evaluate(async (key) => {
    const response = await fetch(`/api/v1/issues/${key}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1 }),
    });
    return { status: response.status, body: await response.json() };
  }, protectedIssueKey!);
  expect(viewerDeleteAttempt).toMatchObject({
    status: 403,
    body: { error: { code: "FORBIDDEN" } },
  });

  const viewerAttempt = await page.evaluate(async (key) => {
    const response = await fetch(`/api/v1/projects/${key}/issues`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        summary: "Unauthorized issue",
        description: "",
        priority: "MEDIUM",
        issueType: "TASK",
      }),
    });
    return { status: response.status, body: await response.json() };
  }, projectKey);
  expect(viewerAttempt).toMatchObject({
    status: 403,
    body: { error: { code: "FORBIDDEN" } },
  });

  const viewerAccessibility = await new AxeBuilder({ page }).analyze();
  expect(
    viewerAccessibility.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);
});

test("search accessible projects with ranked filters and shareable URL state", async ({
  page,
}) => {
  const suffix = Date.now().toString(36).toUpperCase().slice(-7);
  const alphaKey = `A${suffix}`;
  const betaKey = `B${suffix}`;
  const signal = `SearchSignal${suffix}`;
  const alphaSummary = `${signal} critical bug`;
  const betaSummary = `Operational notes ${suffix}`;
  await login(page, process.env.E2E_EMAIL ?? "admin@vibe.local");

  const projects = await page.evaluate(
    async ({ alpha, beta, marker }) => {
      const createProject = async (key: string, name: string) => {
        const response = await fetch("/api/v1/projects", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": crypto.randomUUID(),
          },
          body: JSON.stringify({ key, name }),
        });
        return response.json();
      };
      const first = await createProject(alpha, `Search Alpha ${marker}`);
      const second = await createProject(beta, `Search Beta ${marker}`);
      return { first, second };
    },
    { alpha: alphaKey, beta: betaKey, marker: suffix },
  );
  expect(projects.first).toMatchObject({ key: alphaKey });
  expect(projects.second).toMatchObject({ key: betaKey });

  const issues = await page.evaluate(
    async ({ alpha, beta, alphaTitle, betaTitle, querySignal }) => {
      const createIssue = async (
        projectKey: string,
        body: Record<string, unknown>,
      ) => {
        const response = await fetch(`/api/v1/projects/${projectKey}/issues`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": crypto.randomUUID(),
          },
          body: JSON.stringify(body),
        });
        return response.json();
      };
      return {
        first: await createIssue(alpha, {
          summary: alphaTitle,
          description: "Customer release is blocked",
          priority: "CRITICAL",
          issueType: "BUG",
          labels: ["Search acceptance"],
        }),
        second: await createIssue(beta, {
          summary: betaTitle,
          description: `${querySignal} appears in this description`,
          priority: "LOW",
          issueType: "TASK",
        }),
      };
    },
    {
      alpha: alphaKey,
      beta: betaKey,
      alphaTitle: alphaSummary,
      betaTitle: betaSummary,
      querySignal: signal,
    },
  );
  expect(issues.first).toMatchObject({ summary: alphaSummary });
  expect(issues.second).toMatchObject({ summary: betaSummary });

  await page.getByRole("link", { name: "Search", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Search issues" }),
  ).toBeVisible();
  await page.getByLabel("Words or issue key").fill(signal);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`q=${signal}`));
  const alphaResult = page
    .getByRole("article")
    .filter({ hasText: alphaSummary });
  const betaResult = page.getByRole("article").filter({ hasText: betaSummary });
  await expect(alphaResult).toBeVisible();
  await expect(betaResult).toBeVisible();
  await expect(
    page.locator(".search-result-list").getByRole("article").first(),
  ).toContainText(alphaSummary);

  await page.getByLabel("Projects", { exact: true }).selectOption([alphaKey]);
  await page.getByLabel("Priorities").selectOption(["CRITICAL"]);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(alphaResult).toBeVisible();
  await expect(betaResult).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`projects=${alphaKey}`));
  await page.reload();
  await expect(alphaResult).toBeVisible();
  await expect(betaResult).toHaveCount(0);

  const accessibility = await new AxeBuilder({ page })
    .include(".search-page")
    .exclude(".search-form option")
    .analyze();
  expect(
    accessibility.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);
  await alphaResult.getByRole("link", { name: alphaSummary }).click();
  await expect(page.getByRole("dialog", { name: alphaSummary })).toBeVisible();
});

test("save a project quick filter and reuse it on the board and backlog", async ({
  page,
}) => {
  const suffix = Date.now().toString(36).toUpperCase().slice(-7);
  const projectKey = `F${suffix}`;
  const summary = `Saved filter work ${suffix}`;
  const signal = `FilterSignal${suffix}`;
  const filterName = `Release focus ${suffix}`;
  const renamedFilter = `Board focus ${suffix}`;
  await login(page, process.env.E2E_EMAIL ?? "admin@vibe.local");

  const setup = await page.evaluate(
    async ({ key, title, query }) => {
      const projectResponse = await fetch("/api/v1/projects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({ key, name: `Filter project ${key}` }),
      });
      const project = await projectResponse.json();
      const issueResponse = await fetch(`/api/v1/projects/${key}/issues`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          summary: title,
          description: `${query} is ready for planning`,
          priority: "CRITICAL",
          issueType: "BUG",
          labels: ["saved-filter"],
        }),
      });
      return {
        project,
        issueStatus: issueResponse.status,
        issue: await issueResponse.json(),
      };
    },
    { key: projectKey, title: summary, query: signal },
  );
  expect(setup.project).toMatchObject({ key: projectKey });
  expect(setup.issueStatus).toBe(201);
  expect(setup.issue).toMatchObject({ summary });
  const boardUrl = `/projects/${projectKey}/boards/${setup.project.boardId}`;

  await page.goto(`/search?q=${signal}`);
  await expect(
    page.getByRole("article").filter({ hasText: summary }),
  ).toBeVisible();
  const savedFilterForm = page.locator(".saved-filter-form");
  await savedFilterForm.getByLabel("Name", { exact: true }).fill(filterName);
  await savedFilterForm.locator("select").nth(0).selectOption("PROJECT");
  await savedFilterForm.locator("select").nth(1).selectOption(projectKey);
  await savedFilterForm.locator('input[type="checkbox"]').check();
  await savedFilterForm
    .getByRole("button", { name: "Save current search" })
    .click();
  await expect(page.getByText(`${filterName} saved.`)).toBeVisible();

  let savedFilter = page
    .locator(".saved-filter-list article")
    .filter({ hasText: filterName });
  const stableLink = savedFilter.getByRole("link", { name: filterName });
  await expect(stableLink).toHaveAttribute("href", /\/filters\/[a-f0-9-]+$/);
  await stableLink.click();
  await expect(page).toHaveURL(new RegExp(`/search\\?.*q=${signal}`));
  await expect(
    page.getByRole("article").filter({ hasText: summary }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("article").filter({ hasText: summary }),
  ).toBeVisible();

  savedFilter = page
    .locator(".saved-filter-list article")
    .filter({ hasText: filterName });
  page.once("dialog", (dialog) => void dialog.accept(renamedFilter));
  await savedFilter.getByRole("button", { name: "Rename" }).click();
  await expect(page.getByText(`${renamedFilter} updated.`)).toBeVisible();

  await page.goto(boardUrl);
  const quickFilter = page.getByRole("link", { name: renamedFilter });
  await expect(quickFilter).toBeVisible();
  await quickFilter.click();
  await expect(page).toHaveURL(new RegExp(`q=${signal}`));
  await expect(page.getByPlaceholder("Filter issues…")).toHaveValue(signal);
  await expect(
    page.getByRole("article").filter({ hasText: summary }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Backlog", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Backlog and issues" }),
  ).toBeVisible();
  const issueRow = page.getByRole("row").filter({ hasText: summary });
  await expect(issueRow).toContainText("CRITICAL");
  await page.getByLabel("Search").fill(signal);
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(new RegExp(`view=backlog.*q=${signal}`));
  await page.reload();
  await expect(
    page.getByRole("row").filter({ hasText: summary }),
  ).toBeVisible();
  const backlogAccessibility = await new AxeBuilder({ page })
    .include(".issue-list-page")
    .analyze();
  expect(
    backlogAccessibility.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);
  await page.getByRole("link", { name: "All issues" }).click();
  await expect(page.getByRole("heading", { name: "All issues" })).toBeVisible();

  await page.goto(`/search?q=${signal}`);
  savedFilter = page
    .locator(".saved-filter-list article")
    .filter({ hasText: renamedFilter });
  page.once("dialog", (dialog) => void dialog.accept());
  await savedFilter.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText(`${renamedFilter} deleted.`)).toBeVisible();
  await expect(savedFilter).toHaveCount(0);
});

test("organization admins monitor durable outbox delivery while members cannot", async ({
  page,
}) => {
  const suffix = Date.now().toString(36).toUpperCase().slice(-7);
  await login(page, process.env.E2E_EMAIL ?? "admin@vibe.local");
  const initialHealthResponse = await page.request.get(
    "/api/v1/administration/outbox",
  );
  expect(initialHealthResponse.ok()).toBe(true);
  const initialHealth = (await initialHealthResponse.json()) as {
    deadLettered: number;
    pending: number;
  };
  const created = await page.evaluate(async (marker) => {
    const response = await fetch("/api/v1/projects", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        key: `O${marker}`,
        name: `Outbox browser ${marker}`,
      }),
    });
    return { status: response.status, body: await response.json() };
  }, suffix);
  expect(created.status).toBe(201);

  await page.goto("/projects");
  await page.getByRole("link", { name: "Administration" }).click();
  await expect(page).toHaveURL(/\/administration\/audit$/);
  await page.getByRole("link", { name: "Outbox", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Outbox delivery" }),
  ).toBeVisible();
  await expect(page.getByText("healthy", { exact: true })).toBeVisible();
  await expect
    .poll(async () => {
      const response = await page.request.get("/api/v1/administration/outbox");
      const health = (await response.json()) as {
        deadLettered: number;
        pending: number;
      };
      return (
        health.deadLettered === initialHealth.deadLettered &&
        health.pending <= initialHealth.pending
      );
    })
    .toBe(true);
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(
    page
      .getByRole("region", { name: "Outbox summary" })
      .getByRole("article")
      .filter({ hasText: "Dead-lettered" })
      .getByRole("strong"),
  ).toHaveText(String(initialHealth.deadLettered));
  await expect(
    page.getByRole("heading", { name: "Dead letters" }),
  ).toBeVisible();
  const accessibility = await new AxeBuilder({ page })
    .include(".outbox-page")
    .analyze();
  expect(
    accessibility.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);

  await logout(page);
  await login(page, process.env.E2E_MEMBER_EMAIL ?? "member@vibe.local");
  await expect(page.getByRole("link", { name: "Administration" })).toHaveCount(
    0,
  );
  const denied = await page.evaluate(async () => {
    const response = await fetch("/api/v1/administration/outbox");
    return { status: response.status, body: await response.json() };
  });
  expect(denied).toMatchObject({
    status: 403,
    body: { error: { code: "FORBIDDEN" } },
  });
});

test("organization admins filter correlated audit events and manage retention", async ({
  page,
}) => {
  const suffix = Date.now().toString(36).toUpperCase().slice(-7);
  const projectKey = `A${suffix}`;
  await login(page, process.env.E2E_EMAIL ?? "admin@vibe.local");
  const created = await page.evaluate(async (key) => {
    const response = await fetch("/api/v1/projects", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
        "x-correlation-id": crypto.randomUUID(),
      },
      body: JSON.stringify({ key, name: `Audit browser ${key}` }),
    });
    return { status: response.status, body: await response.json() };
  }, projectKey);
  expect(created).toMatchObject({ status: 201, body: { key: projectKey } });
  const projectId = (created.body as { id: string }).id;

  await page.goto("/projects");
  await page.getByRole("link", { name: "Administration" }).click();
  await expect(
    page.getByRole("heading", { name: "Audit trail" }),
  ).toBeVisible();
  await page.getByLabel("Action").fill("project.created");
  await page.getByRole("button", { name: "Apply filters" }).click();
  const projectAudit = page.getByRole("row").filter({ hasText: projectId });
  await expect(projectAudit).toContainText("project.created");

  const retention = page.getByLabel("Days");
  const currentRetention = Number(await retention.inputValue());
  const nextRetention = currentRetention === 3650 ? 3649 : currentRetention + 1;
  await retention.fill(String(nextRetention));
  await page.getByRole("button", { name: "Save retention" }).click();
  await expect(
    page.getByText(`Audit events will be retained for ${nextRetention} days.`),
  ).toBeVisible();

  const accessibility = await new AxeBuilder({ page })
    .include(".audit-page")
    .analyze();
  expect(
    accessibility.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);

  await logout(page);
  await login(page, process.env.E2E_MEMBER_EMAIL ?? "member@vibe.local");
  await expect(page.getByRole("link", { name: "Administration" })).toHaveCount(
    0,
  );
  const denied = await page.evaluate(async () => {
    const response = await fetch("/api/v1/administration/audit?limit=50");
    return { status: response.status, body: await response.json() };
  });
  expect(denied).toMatchObject({
    status: 403,
    body: { error: { code: "FORBIDDEN" } },
  });
});

test("organization admins manage users, projects, boards, and templates", async ({
  page,
}) => {
  const suffix = Date.now().toString(36).toUpperCase().slice(-7);
  const projectKey = `M${suffix}`;
  const projectName = `Admin project ${suffix}`;
  const renamedProject = `Renamed project ${suffix}`;
  const renamedBoard = `Requests ${suffix}`;
  await login(page, process.env.E2E_EMAIL ?? "admin@vibe.local");

  await page.getByLabel("Project name").fill(projectName);
  await page.getByLabel("Project key").fill(projectKey);
  await page.getByLabel("Workflow template").selectOption("SIMPLE");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/projects/${projectKey}/boards/[a-f0-9-]+$`),
  );
  const boardUrl = page.url();
  await expect(page.locator(".board-column")).toHaveCount(3);

  await page.goto("/projects");
  await page.getByRole("link", { name: "Administration" }).click();
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(
    page.getByRole("heading", { name: "Organization settings" }),
  ).toBeVisible();

  let viewerRow = page.getByRole("row").filter({ hasText: "Vibe Viewer" });
  await viewerRow
    .getByLabel("Account state for Vibe Viewer")
    .selectOption("INACTIVE");
  await viewerRow.getByRole("button", { name: "Save user" }).click();
  await expect(page.getByText("Vibe Viewer updated.")).toBeVisible();
  viewerRow = page.getByRole("row").filter({ hasText: "Vibe Viewer" });
  await expect(
    viewerRow.getByLabel("Account state for Vibe Viewer"),
  ).toHaveValue("INACTIVE");
  await viewerRow
    .getByLabel("Account state for Vibe Viewer")
    .selectOption("ACTIVE");
  await viewerRow.getByRole("button", { name: "Save user" }).click();
  await expect(page.getByText("Vibe Viewer updated.")).toBeVisible();

  let projectRow = page.getByRole("row").filter({ hasText: projectKey });
  await projectRow
    .getByLabel(`Project name for ${projectKey}`)
    .fill(renamedProject);
  await projectRow
    .getByLabel(`Board name for ${projectKey}`)
    .fill(renamedBoard);
  await projectRow.getByLabel("Archived").check();
  await projectRow.getByRole("button", { name: "Save project" }).click();
  await expect(page.getByText(`${projectKey} updated.`)).toBeVisible();
  await page.goto("/projects");
  await expect(
    page.getByRole("link", { name: new RegExp(renamedProject) }),
  ).toHaveCount(0);

  await page.getByRole("link", { name: "Administration" }).click();
  await page.getByRole("link", { name: "Settings" }).click();
  projectRow = page.getByRole("row").filter({ hasText: projectKey });
  await expect(projectRow.getByLabel("Archived")).toBeChecked();
  await projectRow.getByLabel("Archived").uncheck();
  await projectRow.getByRole("button", { name: "Save project" }).click();
  await expect(page.getByText(`${projectKey} updated.`)).toBeVisible();

  const accessibility = await new AxeBuilder({ page })
    .include(".administration-settings-page")
    .analyze();
  expect(
    accessibility.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);
  await page.goto(boardUrl);
  await expect(page.getByRole("heading", { name: renamedBoard })).toBeVisible();

  await logout(page);
  await login(page, process.env.E2E_MEMBER_EMAIL ?? "member@vibe.local");
  const denied = await page.evaluate(async () => {
    const response = await fetch("/api/v1/administration/settings");
    return { status: response.status, body: await response.json() };
  });
  expect(denied).toMatchObject({
    status: 403,
    body: { error: { code: "FORBIDDEN" } },
  });
});

test("project admins dry-run, import, and export CSV through durable jobs", async ({
  page,
}) => {
  const suffix = Date.now().toString(36).toUpperCase().slice(-7);
  const projectKey = `D${suffix}`;
  const importedSummary = `Imported browser ${suffix}`;
  await login(page, process.env.E2E_EMAIL ?? "admin@vibe.local");
  const project = await page.evaluate(async (key) => {
    const response = await fetch("/api/v1/projects", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({ key, name: `Data browser ${key}` }),
    });
    return response.json();
  }, projectKey);
  const boardUrl = `/projects/${projectKey}/boards/${project.boardId}`;
  await page.goto(boardUrl);
  await page.getByRole("link", { name: "Manage members" }).click();
  const memberRow = page.getByRole("row").filter({ hasText: "Vibe Member" });
  await memberRow
    .getByLabel("Project role for Vibe Member")
    .selectOption("MEMBER");
  await memberRow.getByRole("button", { name: "Add to project" }).click();
  await page.getByRole("link", { name: "Back to board" }).click();
  await page.getByRole("link", { name: "Import/export" }).click();
  await expect(
    page.getByRole("heading", { name: "Import and export" }),
  ).toBeVisible();

  const csv = [
    "Summary,Description,Issue Type,Priority,Labels",
    `${importedSummary},Created from browser,Bug,HIGH,import|browser`,
    "Invalid subtask,,Subtask,MEDIUM,",
  ].join("\n");
  await page.getByLabel("CSV data").fill(csv);
  await page.getByRole("button", { name: "Dry run" }).click();
  await expect(page.getByLabel("Validation report")).toContainText(
    "1 valid / 1 invalid",
  );
  await page.getByRole("button", { name: "Queue import" }).click();
  await expect(page.locator(".data-jobs-page .error-banner")).toContainText(
    "Atomic import requires every CSV row to be valid",
  );
  await page.getByLabel("Invalid-row policy").selectOption("SKIP_INVALID");
  await page.getByRole("button", { name: "Queue import" }).click();
  await expect(
    page.getByText("CSV import queued and processed by the background worker."),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/api/v1/projects/${projectKey}/data-jobs`,
      );
      const body = (await response.json()) as {
        jobs: Array<{ jobType: string; state: string }>;
      };
      return body.jobs.find((job) => job.jobType === "CSV_IMPORT")?.state;
    })
    .toBe("SUCCEEDED");
  await page.getByRole("button", { name: "Refresh" }).click();
  const importRow = page.getByRole("row").filter({ hasText: "Import" }).first();
  await expect(importRow).toContainText("succeeded");
  await expect(importRow).toContainText('"imported":1');
  await expect(importRow).toContainText('"skipped":1');

  await page.getByRole("button", { name: "Queue export" }).click();
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/api/v1/projects/${projectKey}/data-jobs`,
      );
      const body = (await response.json()) as {
        jobs: Array<{ jobType: string; state: string }>;
      };
      return body.jobs.find((job) => job.jobType === "CSV_EXPORT")?.state;
    })
    .toBe("SUCCEEDED");
  await page.getByRole("button", { name: "Refresh" }).click();
  const download = page.getByRole("link", { name: "Download CSV" });
  const downloadHref = await download.getAttribute("href");
  expect(downloadHref).toBeTruthy();
  const exported = await page.request.get(downloadHref!);
  expect(exported.headers()["content-type"]).toContain("text/csv");
  expect(await exported.text()).toContain(importedSummary);

  const accessibility = await new AxeBuilder({ page })
    .include(".data-jobs-page")
    .analyze();
  expect(
    accessibility.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);
  await page.goto(boardUrl);
  await expect(
    page.getByRole("article").filter({ hasText: importedSummary }),
  ).toBeVisible();

  await logout(page);
  await login(page, process.env.E2E_MEMBER_EMAIL ?? "member@vibe.local");
  const denied = await page.evaluate(async (key) => {
    const response = await fetch(`/api/v1/projects/${key}/data-jobs`);
    return { status: response.status, body: await response.json() };
  }, projectKey);
  expect(denied).toMatchObject({
    status: 403,
    body: { error: { code: "FORBIDDEN" } },
  });
});

test("project admins version workflow statuses, mappings, and transitions", async ({
  page,
}) => {
  const suffix = Date.now().toString(36).toUpperCase().slice(-7);
  const projectKey = `W${suffix}`;
  const firstSummary = `Workflow existing ${suffix}`;
  const secondSummary = `Workflow new ${suffix}`;
  await login(page, process.env.E2E_EMAIL ?? "admin@vibe.local");

  const setup = await page.evaluate(
    async ({ key, summary }) => {
      const projectResponse = await fetch("/api/v1/projects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({ key, name: `Workflow browser ${key}` }),
      });
      const project = await projectResponse.json();
      const issueResponse = await fetch(`/api/v1/projects/${key}/issues`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          summary,
          description: "Created before workflow configuration",
          priority: "MEDIUM",
          issueType: "TASK",
        }),
      });
      return {
        project,
        issueStatus: issueResponse.status,
        issue: await issueResponse.json(),
      };
    },
    { key: projectKey, summary: firstSummary },
  );
  expect(setup.project).toMatchObject({ key: projectKey });
  expect(setup.issueStatus).toBe(201);
  expect(setup.issue).toMatchObject({ summary: firstSummary });

  const boardUrl = `/projects/${projectKey}/boards/${setup.project.boardId}`;
  await page.goto(boardUrl);
  await page.getByRole("link", { name: "WIP limits" }).click();
  await expect(
    page.getByRole("heading", { name: "Board and workflow" }),
  ).toBeVisible();

  await page.getByLabel("Name for Backlog").fill("Intake");
  await page.getByRole("button", { name: "Add status" }).click();
  await page.getByLabel("Name for New status").fill("Blocked");
  await page.getByLabel("Category for Blocked").selectOption("IN_PROGRESS");
  await page
    .getByLabel("Board column for Blocked")
    .selectOption({ label: "In Progress" });

  const transitionCount = await page
    .locator(".workflow-transition-list > div")
    .count();
  await page.getByRole("button", { name: "Add transition" }).click();
  await page
    .getByLabel(`Transition ${transitionCount + 1} from`)
    .selectOption({ label: "In Progress" });
  await page
    .getByLabel(`Transition ${transitionCount + 1} to`)
    .selectOption({ label: "Blocked" });
  await page.getByRole("button", { name: "Save workflow" }).click();
  await expect(
    page.getByText("Workflow version 2 is now active."),
  ).toBeVisible();

  const accessibility = await new AxeBuilder({ page })
    .include(".settings-shell")
    .analyze();
  expect(
    accessibility.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);

  await page.reload();
  await expect(page.getByLabel("Name for Intake")).toHaveValue("Intake");
  await expect(page.getByLabel("Name for Blocked")).toHaveValue("Blocked");
  await expect(page.getByLabel("Category for Blocked")).toHaveValue(
    "IN_PROGRESS",
  );

  const createdAfterConfiguration = await page.evaluate(
    async ({ key, summary }) => {
      const response = await fetch(`/api/v1/projects/${key}/issues`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          summary,
          description: "Created after workflow configuration",
          priority: "LOW",
          issueType: "TASK",
        }),
      });
      return { status: response.status, body: await response.json() };
    },
    { key: projectKey, summary: secondSummary },
  );
  expect(createdAfterConfiguration).toMatchObject({
    status: 201,
    body: { summary: secondSummary },
  });

  await page.goto(boardUrl);
  const existingCard = page
    .getByRole("article")
    .filter({ hasText: firstSummary });
  await existingCard.getByRole("button", { name: firstSummary }).click();
  await expect(
    page
      .getByRole("dialog", { name: firstSummary })
      .getByText("Intake", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("article").filter({ hasText: secondSummary }),
  ).toBeVisible();
});

test("leads inspect event-derived Kanban reports and published definitions", async ({
  page,
}) => {
  const suffix = Date.now().toString(36).toUpperCase().slice(-7);
  const projectKey = `R${suffix}`;
  const completedSummary = `Completed report fixture ${suffix}`;
  const activeSummary = `Active report fixture ${suffix}`;
  await login(page, process.env.E2E_EMAIL ?? "admin@vibe.local");

  const setup = await page.evaluate(
    async ({ key, summaries }) => {
      const projectResponse = await fetch("/api/v1/projects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          key,
          name: `Reporting browser ${key}`,
          template: "SIMPLE",
        }),
      });
      const project = await projectResponse.json();
      const issues = [];
      for (const summary of summaries) {
        const issueResponse = await fetch(`/api/v1/projects/${key}/issues`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": crypto.randomUUID(),
          },
          body: JSON.stringify({
            summary,
            description: "Deterministic browser report fixture",
            priority: "MEDIUM",
            issueType: "TASK",
          }),
        });
        issues.push(await issueResponse.json());
      }
      return { project, issues };
    },
    { key: projectKey, summaries: [completedSummary, activeSummary] },
  );
  expect(setup.issues).toHaveLength(2);
  await page.goto(
    `/projects/${projectKey}/boards/${setup.project.boardId as string}`,
  );

  const completedCard = page
    .getByRole("article")
    .filter({ hasText: completedSummary });
  const completedKey = setup.issues[0].key as string;
  await completedCard
    .getByRole("button", { name: `Move ${completedKey} to next column` })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "moved to In Progress" }),
  ).toBeVisible();
  await completedCard
    .getByRole("button", { name: `Move ${completedKey} to next column` })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "moved to Done" }),
  ).toBeVisible();

  const activeCard = page
    .getByRole("article")
    .filter({ hasText: activeSummary });
  const activeKey = setup.issues[1].key as string;
  await activeCard
    .getByRole("button", { name: `Move ${activeKey} to next column` })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "moved to In Progress" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Reports" }).click();
  await expect(
    page.getByRole("heading", { name: "Kanban flow" }),
  ).toBeVisible();
  await expect(
    page.locator(".report-summary article").filter({ hasText: "Throughput" }),
  ).toContainText("1");
  await expect(
    page.locator(".report-summary article").filter({ hasText: "Aging WIP" }),
  ).toContainText("1");
  await expect(page.getByLabel("Daily throughput chart")).toBeVisible();
  await expect(page.getByLabel("Cumulative flow chart")).toBeVisible();
  await expect(page.getByRole("link", { name: activeKey })).toBeVisible();
  await page.getByRole("button", { name: "Apply period" }).click();
  await expect(
    page.locator(".report-summary article").filter({ hasText: "Throughput" }),
  ).toContainText("1");

  const accessibility = await new AxeBuilder({ page })
    .include(".reports-page")
    .analyze();
  expect(
    accessibility.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);
  await page.getByRole("link", { name: "Metric definitions" }).click();
  await expect(
    page.getByRole("heading", { name: "Kanban metric definitions" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Lead time" })).toBeVisible();

  await logout(page);
  await login(page, process.env.E2E_VIEWER_EMAIL ?? "viewer@vibe.local");
  const denied = await page.evaluate(async (key) => {
    const response = await fetch(`/api/v1/projects/${key}/reports`);
    return { status: response.status, body: await response.json() };
  }, projectKey);
  expect(denied).toMatchObject({
    status: 403,
    body: { error: { code: "FORBIDDEN" } },
  });
});

test("administrators invite, activate, and deactivate a user", async ({
  page,
}) => {
  const suffix = Date.now().toString(36).toLowerCase();
  const email = `invite-${suffix}@example.test`;
  const displayName = `Invited ${suffix}`;
  const password = `invited-${suffix}-password`;
  const securityResponse = await page.request.get("/login");
  expect(securityResponse.headers()["content-security-policy"]).toContain(
    "frame-ancestors 'none'",
  );
  expect(securityResponse.headers()["x-content-type-options"]).toBe("nosniff");
  expect(securityResponse.headers()["x-frame-options"]).toBe("DENY");
  expect(securityResponse.headers()["x-trace-id"]).toMatch(/^[a-f0-9]{32}$/);
  await login(page, process.env.E2E_EMAIL ?? "admin@vibe.local");
  await page.goto("/administration/settings");
  await page.getByLabel("Invitee name").fill(displayName);
  await page.getByLabel("Invitee email").fill(email);
  await page.getByRole("button", { name: "Create invitation" }).click();
  await expect(
    page.getByText(
      "Invitation created. Share the one-time activation link securely.",
    ),
  ).toBeVisible();
  const activationUrl = await page
    .getByLabel("One-time activation link (expires in 72 hours)")
    .inputValue();
  expect(activationUrl).toContain("/invite/");
  const invitedRow = page.getByRole("row").filter({ hasText: displayName });
  await expect(
    invitedRow.getByLabel(`Account state for ${displayName}`),
  ).toHaveValue("INVITED");

  await logout(page);
  await page.goto(activationUrl);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Activate account" }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByText(displayName)).toBeVisible();

  await logout(page);
  await login(page, process.env.E2E_EMAIL ?? "admin@vibe.local");
  await page.goto("/administration/settings");
  const activeRow = page.getByRole("row").filter({ hasText: displayName });
  await activeRow
    .getByLabel(`Account state for ${displayName}`)
    .selectOption("INACTIVE");
  await activeRow.getByRole("button", { name: "Save user" }).click();
  await expect(page.getByText(`${displayName} updated.`)).toBeVisible();

  await logout(page);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".form-error")).toContainText(
    "Email or password is incorrect",
  );
});

test("team membership grants and revokes an effective project role", async ({
  page,
}) => {
  const suffix = Date.now().toString(36).toUpperCase().slice(-7);
  const teamName = `Delivery team ${suffix}`;
  const projectKey = `T${suffix}`;
  await login(page, process.env.E2E_EMAIL ?? "admin@vibe.local");

  await page.goto("/administration/teams");
  await page.getByLabel("Name", { exact: true }).fill(teamName);
  await page.getByRole("button", { name: "Create team" }).click();
  const teamCard = page.locator(".team-card", {
    has: page.getByLabel(`Team name for ${teamName}`),
  });
  await expect(teamCard).toBeVisible();
  await teamCard.getByLabel(/Vibe Member/).check();
  await teamCard.getByRole("button", { name: "Save team" }).click();
  await expect(page.getByText("Teams updated.")).toBeVisible();
  const teamAdminAccessibility = await new AxeBuilder({ page })
    .include(".teams-page")
    .analyze();
  expect(
    teamAdminAccessibility.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);

  const project = await page.evaluate(async (key) => {
    const response = await fetch("/api/v1/projects", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        key,
        name: `Team access ${key}`,
        template: "SIMPLE",
      }),
    });
    return { status: response.status, body: await response.json() };
  }, projectKey);
  expect(project.status).toBe(201);
  const boardId = project.body.boardId as string;

  await page.goto(`/projects/${projectKey}/settings/teams`);
  const teamRow = page.getByRole("row").filter({ hasText: teamName });
  await teamRow
    .getByLabel(`Project role for team ${teamName}`)
    .selectOption("MEMBER");
  await teamRow.getByRole("button", { name: "Save team access" }).click();
  await expect(page.getByText("Project team access updated.")).toBeVisible();
  const accessibility = await new AxeBuilder({ page })
    .include(".project-teams-page")
    .analyze();
  expect(
    accessibility.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);

  await logout(page);
  await login(page, process.env.E2E_MEMBER_EMAIL ?? "member@vibe.local");
  await page.goto(`/projects/${projectKey}/boards/${boardId}`);
  await expect(
    page.getByRole("button", { name: "+ Create issue" }),
  ).toBeVisible();

  await logout(page);
  await login(page, process.env.E2E_EMAIL ?? "admin@vibe.local");
  await page.goto(`/projects/${projectKey}/settings/teams`);
  const assignedRow = page.getByRole("row").filter({ hasText: teamName });
  await assignedRow
    .getByLabel(`Project role for team ${teamName}`)
    .selectOption("");
  await assignedRow.getByRole("button", { name: "Save team access" }).click();
  await expect(page.getByText("Project team access updated.")).toBeVisible();

  await logout(page);
  await login(page, process.env.E2E_MEMBER_EMAIL ?? "member@vibe.local");
  const denied = await page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/boards/${id}/issues`);
    return { status: response.status, body: await response.json() };
  }, boardId);
  expect(denied).toMatchObject({
    status: 403,
    body: { error: { code: "FORBIDDEN" } },
  });
});
