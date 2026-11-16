import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const projectId = "00000000-0000-4000-8000-000000000101";
const sourceId = "00000000-0000-4000-8000-000000000201";
const targetId = "00000000-0000-4000-8000-000000000202";
const relationshipId = "00000000-0000-4000-8000-000000000501";
const baseline1Id = "00000000-0000-4000-8000-000000000601";
const baseline2Id = "00000000-0000-4000-8000-000000000602";
const changeset1Id = "00000000-0000-4000-8000-000000000701";
const changeset2Id = "00000000-0000-4000-8000-000000000702";

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function mockPhase3Api(page: Page) {
  const nodes = [
    { artifact_id: sourceId, key: "SYS-184", title: "Maintain attitude during failover", revision: 3, upstream_count: 0, downstream_count: 1, suspect_count: 1, gap: false },
    { artifact_id: targetId, key: "SFT-041", title: "Fail over within 150 ms", revision: 1, upstream_count: 1, downstream_count: 0, suspect_count: 1, gap: false },
  ];
  const edge = { relationship_id: relationshipId, relationship_type_key: "DECOMPOSES_TO", source_artifact_id: sourceId, target_artifact_id: targetId, version: 2, suspect: true };
  const summary = { total_artifacts: 2, covered_artifacts: 2, orphan_artifacts: 0, relationships: 1, suspect_relationships: 1, coverage_percent: 100 };
  const relationship = {
    id: relationshipId,
    project_id: projectId,
    relationship_type_id: "00000000-0000-4000-8000-000000000511",
    relationship_type_key: "DECOMPOSES_TO",
    relationship_type_name: "Decomposes to",
    source_artifact_id: sourceId,
    source_key: "SYS-184",
    source_title: "Maintain attitude during failover",
    source_revision: 3,
    target_artifact_id: targetId,
    target_key: "SFT-041",
    target_title: "Fail over within 150 ms",
    target_revision: 1,
    version: 2,
    suspect: true,
    suspect_reason: "source_revision_changed",
    disposition: null,
    created_by: "test-author",
    created_at: "2026-11-08T12:00:00Z",
    updated_at: "2026-11-08T13:00:00Z",
    version_created_by: "system:relationship-impact",
    version_created_at: "2026-11-08T13:00:00Z",
  };
  const changesets = [
    { id: changeset2Id, project_id: projectId, sequence: 2, message: "Refresh trace evidence", parent_changeset_id: changeset1Id, manifest_hash: "b".repeat(64), added: 0, modified: 1, unchanged: 1, created_by: "test-author", created_at: "2026-11-08T14:00:00Z", entries: [] },
    { id: changeset1Id, project_id: projectId, sequence: 1, message: "Capture trace state", parent_changeset_id: null, manifest_hash: "a".repeat(64), added: 2, modified: 0, unchanged: 0, created_by: "test-author", created_at: "2026-11-08T12:00:00Z", entries: [] },
  ];
  const baselines = [
    { id: baseline2Id, project_id: projectId, sequence: 2, name: "SRR candidate", changeset_id: changeset2Id, supersedes_baseline_id: baseline1Id, artifact_count: 2, relationship_count: 1, manifest_hash: "d".repeat(64), signature: "f".repeat(64), signing_algorithm: "HMAC-SHA256", signing_key_id: "test", created_by: "test-reviewer", created_at: "2026-11-08T14:05:00Z" },
    { id: baseline1Id, project_id: projectId, sequence: 1, name: "Requirements freeze", changeset_id: changeset1Id, supersedes_baseline_id: null, artifact_count: 2, relationship_count: 1, manifest_hash: "c".repeat(64), signature: "e".repeat(64), signing_algorithm: "HMAC-SHA256", signing_key_id: "test", created_by: "test-reviewer", created_at: "2026-11-08T12:05:00Z" },
  ];

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path.endsWith("/trace/graph") && method === "GET") return json(route, { nodes, edges: [edge], summary });
    if (path.endsWith("/trace/matrix") && method === "GET") return json(route, { items: nodes });
    if (path.endsWith("/trace/summary") && method === "GET") return json(route, summary);
    if (path.endsWith("/relationships") && method === "GET") return json(route, { items: [relationship] });
    if (path.endsWith(`/relationships/${relationshipId}/resolve`) && method === "POST") {
      relationship.suspect = false;
      relationship.suspect_reason = null;
      relationship.disposition = request.postDataJSON().disposition;
      relationship.version = 3;
      edge.suspect = false;
      edge.version = 3;
      nodes.forEach((node) => { node.suspect_count = 0; });
      summary.suspect_relationships = 0;
      return json(route, relationship);
    }
    if (path.endsWith("/changesets") && method === "GET") return json(route, { items: changesets });
    if (path.endsWith("/changesets") && method === "POST") {
      const created = { ...changesets[0], id: crypto.randomUUID(), sequence: 3, parent_changeset_id: changesets[0].id, message: request.postDataJSON().message, added: 0, modified: 0, unchanged: 2 };
      changesets.unshift(created);
      return json(route, created, 201);
    }
    if (path.endsWith("/baselines") && method === "GET") return json(route, { items: baselines });
    if (path.endsWith("/baselines") && method === "POST") {
      const created = { ...baselines[0], id: crypto.randomUUID(), sequence: 3, name: request.postDataJSON().name, changeset_id: changesets[0].id, supersedes_baseline_id: baselines[0].id };
      baselines.unshift(created);
      return json(route, created, 201);
    }
    if (path.endsWith("/baselines/compare") && method === "GET") return json(route, { from_baseline_id: baseline1Id, to_baseline_id: baseline2Id, artifacts_added: [], artifacts_modified: ["SYS-184"], artifacts_removed: [], relationships_changed: 1 });
    if (path.endsWith(`/baselines/${baseline2Id}/evidence`) && method === "GET") return json(route, { baseline_id: baseline2Id, project_id: projectId, schema_version: "openrm-evidence-v1", manifest: { artifacts: nodes, relationships: [edge] }, manifest_hash: "d".repeat(64), signature: "f".repeat(64), signing_algorithm: "HMAC-SHA256", signing_key_id: "test", signature_valid: true });
    return json(route, { error: { code: "not_found", message: `Unhandled ${method} ${path}`, request_id: crypto.randomUUID() } }, 404);
  });
}

test.beforeEach(async ({ page }) => {
  await mockPhase3Api(page);
  await page.goto("/");
});

test("loads live trace evidence and records a reviewer disposition", async ({ page }) => {
  await page.getByRole("button", { name: /Traceability/ }).click();
  await expect(page.getByRole("heading", { name: "Traceability" })).toBeVisible();
  await expect(page.getByText("Live controlled trace • 1 relationships")).toBeVisible();
  await page.getByRole("button", { name: /SYS-184/ }).click();
  await expect(page.getByText("Impact review required")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept("Reviewed and accepted for the controlled baseline."));
  await page.getByRole("button", { name: "Resolve impact" }).click();
  await expect(page.getByRole("button", { name: "No open impact" })).toBeVisible();
});

test("shows changesets, compares baselines, and creates controlled history", async ({ page }) => {
  await page.getByRole("button", { name: /Baselines/ }).click();
  await expect(page.getByRole("heading", { name: "Baselines & changesets" })).toBeVisible();
  await expect(page.getByText("Live controlled history • 2 changesets • 2 baselines")).toBeVisible();
  await expect(page.getByText("Modified controlled artifact")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept("Capture browser-tested change"));
  await page.getByRole("button", { name: "Create changeset" }).click();
  await expect(page.getByText("Immutable changeset created")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept("Browser-tested baseline"));
  await page.getByRole("button", { name: "Create baseline" }).click();
  await expect(page.getByText("Signed immutable baseline created")).toBeVisible();
});

test("Phase 3 workspaces have no detectable WCAG A or AA violations", async ({ page }) => {
  for (const navigation of [/Traceability/, /Baselines/]) {
    await page.getByRole("button", { name: navigation }).click();
    await page.waitForTimeout(300);
    const results = await new AxeBuilder({ page })
      .include(".page-stage")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations.map((violation) => ({
      id: violation.id,
      targets: violation.nodes.flatMap((node) => node.target),
    }))).toEqual([]);
  }
});
