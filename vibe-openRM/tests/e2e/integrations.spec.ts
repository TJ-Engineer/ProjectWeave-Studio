import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Dialog, type Page, type Route } from "@playwright/test";

const projectId = "00000000-0000-4000-8000-000000000101";
const connectorId = "00000000-0000-4000-8000-000000001001";
const deadLetterId = "00000000-0000-4000-8000-000000001002";

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function mockConnectorApi(page: Page) {
  let configuration = {
    id: connectorId,
    project_id: projectId,
    mode: "dry_run",
    base_url: "https://jira.example.com",
    remote_project_key: "OPENRM",
    secret_ref: "env:JIRA_API_TOKEN",
    field_mapping: { requirement_key: "labels" },
    max_attempts: 5,
    version: 1,
    created_by: "local-user",
    created_at: "2026-11-08T18:00:00Z",
    updated_by: "local-user",
    updated_at: "2026-11-08T18:00:00Z",
  };
  const history: Array<Record<string, unknown>> = [{ ...configuration, actor_subject: "local-user", occurred_at: configuration.created_at }];
  let deliveries: Array<Record<string, unknown>> = [{
    id: deadLetterId,
    connector_id: connectorId,
    event_key: "revision:failed:1",
    operation: "comment_revision",
    external_issue_key: "OPENRM-7",
    payload: { body: "failed delivery" },
    payload_hash: "a".repeat(64),
    status: "dead_letter",
    attempts: 5,
    available_at: "2026-11-08T18:01:00Z",
    delivered_at: null,
    last_error: "Jira delivery failed with HTTP 503",
    created_by: "local-user",
    created_at: "2026-11-08T18:01:00Z",
    attempt_history: [{ id: crypto.randomUUID(), attempt: 5, outcome: "dead_letter", response_status: 503, retry_after_seconds: null, error: "Jira delivery failed with HTTP 503", occurred_at: "2026-11-08T18:01:01Z" }],
  }];
  const connectorResponse = () => ({
    configuration,
    configuration_history: history,
    pending: deliveries.filter((item) => item.status === "pending").length,
    retrying: deliveries.filter((item) => item.status === "retry").length,
    delivered: deliveries.filter((item) => item.status === "delivered").length,
    dead_letters: deliveries.filter((item) => item.status === "dead_letter").length,
  });

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path.endsWith("/connectors/jira") && method === "GET") return json(route, connectorResponse());
    if (path.endsWith("/connectors/jira") && method === "PUT") {
      const payload = request.postDataJSON();
      configuration = { ...configuration, ...payload, version: configuration.version + 1, updated_at: "2026-11-08T18:02:00Z" };
      history.push({ ...configuration, actor_subject: "local-user", occurred_at: configuration.updated_at });
      return json(route, configuration);
    }
    if (path.endsWith("/connectors/jira/deliveries") && method === "GET") return json(route, { items: deliveries });
    if (path.endsWith("/connectors/jira/deliveries") && method === "POST") {
      const payload = request.postDataJSON();
      const delivery = {
        id: crypto.randomUUID(), connector_id: connectorId, ...payload, payload_hash: "b".repeat(64),
        status: "delivered", attempts: 1, available_at: "2026-11-08T18:03:00Z",
        delivered_at: "2026-11-08T18:03:01Z", last_error: null, created_by: "local-user",
        created_at: "2026-11-08T18:03:00Z", attempt_history: [{ id: crypto.randomUUID(), attempt: 1, outcome: "delivered", response_status: 204, retry_after_seconds: null, error: null, occurred_at: "2026-11-08T18:03:01Z" }],
      };
      deliveries = [delivery, ...deliveries];
      return json(route, delivery, 201);
    }
    if (path.endsWith(`/deliveries/${deadLetterId}/replay`) && method === "POST") {
      deliveries = deliveries.map((item) => item.id === deadLetterId
        ? { ...item, status: "delivered", attempts: 6, delivered_at: "2026-11-08T18:04:00Z", last_error: null }
        : item);
      return json(route, deliveries.find((item) => item.id === deadLetterId));
    }
    return json(route, { error: { code: "not_found", message: `Unhandled ${method} ${path}`, request_id: crypto.randomUUID() } }, 404);
  });
}

test.beforeEach(async ({ page }) => {
  await mockConnectorApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: /Integrations/ }).click();
  await expect(page.getByRole("heading", { name: "Jira connector operations" })).toBeVisible();
  await expect(page.getByText("Live connector queue • dry_run")).toBeVisible();
});

test("configures, delivers, and replays governed Jira work", async ({ page }) => {
  const configurationAnswers = ["dry_run", "https://jira.example.com", "OPENRM", "env:JIRA_API_TOKEN"];
  const configureDialog = async (dialog: Dialog) => dialog.accept(configurationAnswers.shift());
  page.on("dialog", configureDialog);
  await page.getByRole("button", { name: "Configure" }).click();
  page.off("dialog", configureDialog);
  await expect(page.getByText("OPENRM • v2")).toBeVisible();

  const deliveryAnswers = ["OPENRM-42", "OpenRM baseline 12 is ready."];
  const deliveryDialog = async (dialog: Dialog) => dialog.accept(deliveryAnswers.shift());
  page.on("dialog", deliveryDialog);
  await page.getByRole("button", { name: "Queue Jira update" }).click();
  page.off("dialog", deliveryDialog);
  await expect(page.getByText("OPENRM-42")).toBeVisible();
  await expect(page.getByText("DELIVERED").first()).toBeVisible();

  await page.getByRole("button", { name: "Replay" }).click();
  const replayedRow = page.locator(".connector-delivery-row").filter({ hasText: "revision:failed:1" });
  await expect(replayedRow.getByText("revision:failed:1", { exact: true })).toBeVisible();
  await expect(replayedRow.locator("strong").nth(1)).toHaveText("6");
});

test("Jira connector workspace has no detectable WCAG A or AA violations", async ({ page }) => {
  await page.waitForTimeout(300);
  const results = await new AxeBuilder({ page })
    .include(".page-stage")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations.map((violation) => ({
    id: violation.id,
    targets: violation.nodes.flatMap((node) => node.target),
  }))).toEqual([]);
});
