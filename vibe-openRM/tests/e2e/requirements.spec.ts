import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const projectId = "00000000-0000-4000-8000-000000000101";
const requirementId = "00000000-0000-4000-8000-000000000201";
const folderId = "00000000-0000-4000-8000-000000000301";

type Requirement = {
  id: string;
  project_id: string;
  key: string;
  title: string;
  statement: string;
  attributes: Record<string, unknown>;
  folder_id: string | null;
  tag_ids: string[];
  revision: number;
  created_by: string;
  created_by_name: string;
  created_at: string;
  updated_at: string;
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function mockRequirementsApi(page: Page) {
  let requirements: Requirement[] = [{
    id: requirementId,
    project_id: projectId,
    key: "SYS-184",
    title: "Maintain attitude during failover",
    statement: "The controller shall maintain commanded attitude during failover.",
    attributes: { priority: "critical" },
    folder_id: folderId,
    tag_ids: [],
    revision: 1,
    created_by: "test-author",
    created_by_name: "T. Author",
    created_at: "2026-11-08T12:00:00Z",
    updated_at: "2026-11-08T12:00:00Z",
  }];
  let relationships: Array<Record<string, unknown>> = [];
  const currentRequirement = () => requirements.find((requirement) => requirement.id === requirementId)!;
  const revisions = () => currentRequirement().revision === 1
    ? [{ ...currentRequirement(), revision: 1 }]
    : [
        { ...currentRequirement(), id: "00000000-0000-4000-8000-000000000402", revision: 2 },
        { ...currentRequirement(), id: "00000000-0000-4000-8000-000000000401", title: "Maintain attitude during failover", revision: 1 },
      ];

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path === "/api/v1/projects" && method === "GET") {
      return json(route, { items: [{ id: projectId, key: "AURORA-2", name: "Aurora Flight Computer", requirement_prefix: "SYS", next_requirement_number: 300, description: "Test project", created_at: "2026-11-08T12:00:00Z" }] });
    }
    if (path.endsWith("/workspace/folders") && method === "GET") return json(route, { items: [{ id: folderId, name: "System requirements", parent_id: null }] });
    if (path.endsWith("/workspace/tags") && method === "GET") return json(route, { items: [{ id: "00000000-0000-4000-8000-000000000302", name: "Safety", color: "#2563eb" }] });
    if (path.endsWith("/workspace/saved-views") && method === "GET") return json(route, { items: [] });
    if (path.endsWith("/workspace/saved-views") && method === "POST") return json(route, { id: "00000000-0000-4000-8000-000000000303", ...request.postDataJSON() }, 201);
    if (path.endsWith("/requirements/export") && method === "GET") return json(route, { items: requirements, total: requirements.length, limit: requirements.length, offset: 0 });
    if (path.endsWith("/requirements/import") && method === "POST") return json(route, { items: [], imported: 1 }, 201);
    if (path.endsWith("/relationships") && method === "GET") {
      const artifactId = url.searchParams.get("artifact_id");
      const items = artifactId
        ? relationships.filter((relationship) => relationship.source_artifact_id === artifactId || relationship.target_artifact_id === artifactId)
        : relationships;
      return json(route, { items });
    }
    if (path.endsWith("/revisions") && method === "GET") return json(route, { items: revisions() });
    if (path.endsWith("/compare") && method === "GET") return json(route, { requirement_id: requirementId, from: revisions().at(-1), to: revisions()[0], changed_fields: ["title", "statement"] });
    if (path.endsWith(`/requirements/${requirementId}`) && method === "PUT") {
      const payload = request.postDataJSON();
      requirements = requirements.map((requirement) => requirement.id === requirementId
        ? { ...requirement, ...payload, revision: 2, updated_at: "2026-11-08T13:00:00Z" }
        : requirement);
      return json(route, currentRequirement());
    }
    if (path.endsWith(`/requirements/${requirementId}/derived`) && method === "POST") {
      const payload = request.postDataJSON();
      const created: Requirement = { ...payload, key: "SYS-300", id: "00000000-0000-4000-8000-000000000205", project_id: projectId, revision: 1, created_by: "test-author", created_by_name: "T. Author", created_at: "2026-11-08T13:00:00Z", updated_at: "2026-11-08T13:00:00Z" };
      const relationshipId = "00000000-0000-4000-8000-000000000601";
      requirements = [created, ...requirements];
      relationships = [{
        id: relationshipId,
        project_id: projectId,
        relationship_type_id: "00000000-0000-4000-8000-000000000501",
        relationship_type_key: "DECOMPOSES_TO",
        relationship_type_name: "Decomposes to",
        source_artifact_id: requirementId,
        source_key: "SYS-184",
        source_title: "Maintain attitude during failover",
        source_revision: 1,
        target_artifact_id: created.id,
        target_key: created.key,
        target_title: created.title,
        target_revision: 1,
        version: 1,
        suspect: false,
        suspect_reason: null,
        disposition: null,
        created_by: "test-author",
        created_at: created.created_at,
        updated_at: created.updated_at,
        version_created_by: "test-author",
        version_created_at: created.created_at,
      }];
      return json(route, { requirement: created, relationship_id: relationshipId }, 201);
    }
    if (path.endsWith("/requirements") && method === "POST") {
      const payload = request.postDataJSON();
      const created: Requirement = { ...payload, key: "SYS-300", id: "00000000-0000-4000-8000-000000000205", project_id: projectId, revision: 1, created_by: "test-author", created_by_name: "T. Author", created_at: "2026-11-08T13:00:00Z", updated_at: "2026-11-08T13:00:00Z" };
      requirements = [created, ...requirements];
      return json(route, created, 201);
    }
    if (path.endsWith("/requirements") && method === "GET") {
      const search = url.searchParams.get("search")?.toLowerCase();
      const items = search ? requirements.filter((item) => `${item.key} ${item.title} ${item.statement}`.toLowerCase().includes(search)) : requirements;
      return json(route, { items, total: items.length, limit: 25, offset: 0 });
    }
    const requirementMatch = path.match(/\/requirements\/([^/]+)$/);
    if (requirementMatch && method === "GET") {
      const requirement = requirements.find((item) => item.id === requirementMatch[1]);
      return requirement
        ? json(route, requirement)
        : json(route, { error: { code: "not_found", message: "Requirement not found", request_id: crypto.randomUUID() } }, 404);
    }
    return json(route, { error: { code: "not_found", message: `Unhandled ${method} ${path}`, request_id: crypto.randomUUID() } }, 404);
  });
}

test.beforeEach(async ({ page }) => {
  await mockRequirementsApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: /Requirements/ }).click();
  await expect(page.getByRole("heading", { name: "Requirements workspace" })).toBeVisible();
  await expect(page.getByText("Live controlled workspace")).toBeVisible();
});

test("creates, searches, revises, and compares a controlled requirement", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Maintain attitude during failover" })).toBeVisible();
  await expect(page.getByText("T. Author").first()).toBeVisible();
  await expect(page.getByText("test-author", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "New requirement" }).click();
  const dialog = page.getByRole("dialog", { name: "Create requirement" });
  await dialog.getByLabel("Title").fill("Preserve controlled history");
  await dialog.getByLabel("Statement").fill("The system shall preserve controlled history.");
  await dialog.getByLabel("Priority").selectOption("high");
  await dialog.getByLabel("Safety").check();
  await dialog.getByRole("button", { name: "Create requirement" }).click();
  await page.getByRole("button", { name: /SYS-300 Preserve controlled history/ }).click();
  await expect(page.getByRole("heading", { name: "Preserve controlled history" })).toBeVisible();
  const search = page.getByRole("search").getByLabel("Search requirements");
  await search.fill("SYS-184");
  await search.press("Enter");
  await expect(page.getByRole("heading", { name: "Maintain attitude during failover" })).toBeVisible();
  await page.getByRole("button", { name: "Revise requirement" }).click();
  const editDialog = page.getByRole("dialog", { name: /Revise SYS-184/ });
  await editDialog.getByLabel("Title").fill("Maintain safe attitude during failover");
  await editDialog.getByRole("button", { name: "Commit revision" }).click();
  await expect(page.getByRole("heading", { name: "Maintain safe attitude during failover" })).toBeVisible();
  await page.getByRole("button", { name: "Compare first to current" }).click();
  await expect(page.getByText("title, statement")).toBeVisible();
});

test("creates a derived requirement and navigates its child and parent links", async ({ page }) => {
  const links = page.getByLabel("Requirement links");
  await expect(links.getByText("None — this is a root requirement")).toBeVisible();

  await page.getByRole("button", { name: "Create derived requirement" }).click();
  const dialog = page.getByRole("dialog", { name: "Derive from SYS-184" });
  await dialog.getByLabel("Title").fill("Preserve safe attitude control");
  await dialog.getByLabel("Statement").fill("The derived controller shall preserve safe attitude control.");
  await dialog.getByRole("button", { name: "Create derived requirement" }).click();

  const search = page.getByRole("search").getByLabel("Search requirements");
  await search.fill("SYS-184");
  await search.press("Enter");
  await expect(page.getByRole("heading", { name: "Maintain attitude during failover" })).toBeVisible();

  const childLink = links.getByRole("button", { name: /SYS-300 Preserve safe attitude control/ });
  await expect(childLink).toBeVisible();
  await childLink.click();
  await expect(page.getByRole("heading", { name: "Preserve safe attitude control" })).toBeVisible();

  const parentLink = links.getByRole("button", { name: /SYS-184 Maintain attitude during failover/ });
  await expect(parentLink).toBeVisible();
  await parentLink.click();
  await expect(page.getByRole("heading", { name: "Maintain attitude during failover" })).toBeVisible();
});

test("has no automatically detectable WCAG A or AA violations", async ({ page }) => {
  await page.waitForTimeout(500);
  const results = await new AxeBuilder({ page })
    .include(".page-stage")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations.map((violation) => ({
    id: violation.id,
    targets: violation.nodes.flatMap((node) => node.target),
  }))).toEqual([]);
});
