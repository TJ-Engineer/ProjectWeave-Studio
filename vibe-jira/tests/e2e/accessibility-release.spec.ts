import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

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

async function createProject(page: Page, prefix: string): Promise<string> {
  const suffix = `${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 5)}`
    .toUpperCase()
    .slice(-8);
  const projectKey = `${prefix}${suffix}`;
  await page.getByLabel("Project name").fill(`Accessibility ${suffix}`);
  await page.getByLabel("Project key").fill(projectKey);
  const createProjectButton = page.getByRole("button", {
    name: "Create project",
  });
  await createProjectButton.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(
    new RegExp(`/projects/${projectKey}/boards/[a-f0-9-]+$`),
  );
  return projectKey;
}

async function createIssue(page: Page, summary: string): Promise<void> {
  const trigger = page.getByRole("button", { name: "+ Create issue" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Create issue" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Summary")).toBeFocused();
  await page.keyboard.type(summary);
  const submit = dialog.getByRole("button", { name: "Create", exact: true });
  await submit.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("article").filter({ hasText: summary }),
  ).toBeVisible();
}

async function expectNoPageHorizontalOverflow(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const clientWidth = document.documentElement.clientWidth;
    return {
      clientWidth,
      offenders: Array.from(document.querySelectorAll<HTMLElement>("body *"))
        .flatMap((element) => {
          const rectangle = element.getBoundingClientRect();
          return rectangle.width > 0 && rectangle.right > clientWidth + 1
            ? [
                {
                  className: element.className,
                  right: Math.round(rectangle.right),
                  tagName: element.tagName,
                  width: Math.round(rectangle.width),
                },
              ]
            : [];
        })
        .slice(0, 12),
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  expect(
    result.scrollWidth,
    `Overflowing elements: ${JSON.stringify(result.offenders)}`,
  ).toBeLessThanOrEqual(result.clientWidth + 1);
}

test("keyboard focus enters, stays within, and returns from modal work", async ({
  page,
}) => {
  await page.goto("/login");
  await page.keyboard.press("Tab");
  const email = page.getByLabel("Email");
  await expect(email).toBeFocused();
  const focusIndicator = await email.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      style: style.outlineStyle,
      width: Number.parseFloat(style.outlineWidth),
    };
  });
  expect(focusIndicator.style).not.toBe("none");
  expect(focusIndicator.width).toBeGreaterThanOrEqual(2);
  await page.keyboard.type(process.env.E2E_EMAIL ?? "admin@vibe.local");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Password")).toBeFocused();
  await page.keyboard.type(demoPassword);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/projects$/);

  await createProject(page, "AK");
  const summary = `Keyboard issue ${Date.now().toString(36)}`;
  await createIssue(page, summary);
  const opener = page
    .getByRole("article")
    .filter({ hasText: summary })
    .getByRole("button", { name: summary });
  await opener.focus();
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("dialog", { name: summary });
  await expect(drawer).toBeVisible();
  await expect(
    drawer.getByRole("button", { name: "Close issue details" }),
  ).toBeFocused();

  for (let index = 0; index < 24; index += 1) {
    await page.keyboard.press("Tab");
    expect(
      await drawer.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(opener).toBeFocused();

  const createTrigger = page.getByRole("button", { name: "+ Create issue" });
  await createTrigger.focus();
  await page.keyboard.press("Enter");
  const createDialog = page.getByRole("dialog", { name: "Create issue" });
  await expect(createDialog.getByLabel("Summary")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(createDialog).toHaveCount(0);
  await expect(createTrigger).toBeFocused();

  const card = page.getByRole("article").filter({ hasText: summary });
  const moveButton = card.getByRole("button", {
    name: /Move [A-Z][A-Z0-9]+-\d+ to next column/,
  });
  await moveButton.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("status").filter({ hasText: /moved to/ }),
  ).toBeVisible();
});

test("320 CSS-pixel reflow, text spacing, display preferences, and target size pass", async ({
  browserName,
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await login(page);
  await expectNoPageHorizontalOverflow(page);
  await createProject(page, "AR");
  await expectNoPageHorizontalOverflow(page);

  const boardScroller = page.locator(".board-grid").first();
  const boardOverflow = await boardScroller.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(boardOverflow.scrollWidth).toBeGreaterThan(boardOverflow.clientWidth);

  const summary = `Reflow issue ${Date.now().toString(36)}`;
  await createIssue(page, summary);
  await expectNoPageHorizontalOverflow(page);

  const undersizedTargets = await page
    .locator("button, input, select, textarea, a[href]")
    .evaluateAll((elements) =>
      elements.flatMap((element) => {
        const rectangle = element.getBoundingClientRect();
        if (
          rectangle.width === 0 ||
          rectangle.height === 0 ||
          getComputedStyle(element).visibility === "hidden"
        ) {
          return [];
        }
        if (rectangle.width >= 24 && rectangle.height >= 24) return [];
        return [
          {
            element: element.outerHTML.slice(0, 160),
            height: rectangle.height,
            width: rectangle.width,
          },
        ];
      }),
    );
  expect(undersizedTargets).toEqual([]);

  await page.addStyleTag({
    content: `
      * { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
      p { margin-bottom: 2em !important; }
    `,
  });
  await expectNoPageHorizontalOverflow(page);
  await expect(
    page.getByRole("button", { name: "+ Create issue" }),
  ).toBeVisible();

  await page.emulateMedia({ reducedMotion: "reduce" });
  const durations = await page
    .getByRole("button", { name: "+ Create issue" })
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        animation: style.animationDuration,
        transition: style.transitionDuration,
      };
    });
  const durationInSeconds = (value: string) => {
    const firstDuration = value.split(",")[0]?.trim() ?? "0s";
    const duration = Number.parseFloat(firstDuration);
    return firstDuration.endsWith("ms") ? duration / 1000 : duration;
  };
  expect(durationInSeconds(durations.animation)).toBeLessThanOrEqual(0.001);
  expect(durationInSeconds(durations.transition)).toBeLessThanOrEqual(0.001);

  if (browserName === "chromium") {
    await page.emulateMedia({
      forcedColors: "active",
      reducedMotion: "reduce",
    });
    expect(
      await page.evaluate(() => matchMedia("(forced-colors: active)").matches),
    ).toBe(true);
    const accessibility = await new AxeBuilder({ page })
      .disableRules(["color-contrast"])
      .analyze();
    expect(
      accessibility.violations.filter(
        (violation) =>
          violation.impact === "serious" || violation.impact === "critical",
      ),
    ).toEqual([]);
  }
});
