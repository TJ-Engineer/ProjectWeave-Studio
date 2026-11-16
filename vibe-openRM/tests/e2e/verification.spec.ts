import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Dialog, type Page, type Route } from "@playwright/test";

const projectId = "00000000-0000-4000-8000-000000000101";
const reviewId = "00000000-0000-4000-8000-000000000801";
const baselineId = "00000000-0000-4000-8000-000000000602";
const caseId = "00000000-0000-4000-8000-000000000901";
const runId = "00000000-0000-4000-8000-000000000902";
const artifactIds = ["00000000-0000-4000-8000-000000000201", "00000000-0000-4000-8000-000000000202"];

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function mockVerificationApi(page: Page) {
  const review = {
    id: reviewId, project_id: projectId, sequence: 1, baseline_id: baselineId, baseline_sequence: 2,
    title: "Approved SRR", description: "Approved baseline gate", status: "approved", due_at: null,
    required_approvals: 1, current_round: 1, artifact_count: 2, participant_count: 1,
    approval_count: 1, open_comment_count: 0, blocking_comment_count: 0, created_by: "local-user",
    created_at: "2026-11-08T14:00:00Z", updated_at: "2026-11-08T14:10:00Z", participants: [], comments: [], decisions: [],
  };
  let cases: Array<Record<string, unknown>> = [];
  const dueEvents: Array<Record<string, unknown>> = [];
  const coverage = () => ({
    review_id: reviewId, baseline_id: baselineId, total_artifacts: 2,
    passed_artifacts: cases[0]?.status === "passed" ? 2 : 0,
    coverage_percent: cases[0]?.status === "passed" ? 100 : 0,
    items: artifactIds.map((artifactId, index) => ({
      artifact_id: artifactId,
      artifact_revision_id: `00000000-0000-4000-9000-00000000030${index + 1}`,
      artifact_key: `SYS-${index + 1}`,
      status: cases.length === 0 ? "unverified" : cases[0].status,
      case_count: cases.length,
    })),
  });
  const readiness = () => {
    const ready = cases[0]?.status === "passed";
    return {
      review_id: reviewId, review_status: "approved", ready,
      coverage_percent: ready ? 100 : 0, total_cases: cases.length,
      passed_cases: ready ? 1 : 0, failed_cases: 0, blocked_cases: 0,
      in_progress_cases: cases[0]?.status === "in_progress" ? 1 : 0,
      planned_cases: cases[0]?.status === "planned" ? 1 : 0,
      open_blocking_comments: 0, invalid_signatures: 0,
      contributors: ["Review status: approved", `Passed verification coverage: ${ready ? "100.00" : "0.00"}%`],
      blockers: ready ? [] : [cases.length === 0 ? "No verification cases exist" : "Verification coverage is 0.00% rather than 100%"],
    };
  };

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path.endsWith("/reviews") && method === "GET") return json(route, { items: [review] });
    if (path.endsWith(`/baselines/${baselineId}/evidence`) && method === "GET") return json(route, { baseline_id: baselineId, project_id: projectId, schema_version: "openrm-evidence-v1", manifest: { artifacts: artifactIds.map((artifact_id) => ({ artifact_id })) }, manifest_hash: "a".repeat(64), signature: "b".repeat(64), signing_algorithm: "HMAC-SHA256", signing_key_id: "test", signature_valid: true });
    if (path.endsWith("/verification/cases") && method === "GET") return json(route, { items: cases });
    if (path.endsWith("/verification/cases") && method === "POST") {
      const payload = request.postDataJSON();
      cases = [{
        id: caseId, project_id: projectId, review_id: reviewId, baseline_id: baselineId,
        sequence: 1, key: payload.key, title: payload.title, method: payload.method,
        procedure: payload.procedure, acceptance_criteria: payload.acceptance_criteria,
        owner_subject: payload.owner_subject, due_at: payload.due_at, created_by: "local-user",
        created_at: "2026-11-08T15:00:00Z", status: "planned",
        targets: artifactIds.map((artifact_id, index) => ({ id: crypto.randomUUID(), artifact_id, artifact_revision_id: `00000000-0000-4000-9000-00000000030${index + 1}`, artifact_key: `SYS-${index + 1}` })),
        runs: [],
      }];
      return json(route, cases[0], 201);
    }
    if (path.endsWith(`/verification/cases/${caseId}/runs`) && method === "POST") {
      const run = { id: runId, case_id: caseId, sequence: 1, status: "in_progress", executed_by: "local-reviewer", started_at: "2026-11-08T15:01:00Z", completed_at: null, result: null };
      cases[0].status = "in_progress";
      cases[0].runs = [run];
      return json(route, run, 201);
    }
    if (path.endsWith(`/verification/runs/${runId}/results`) && method === "POST") {
      const payload = request.postDataJSON();
      const result = { id: crypto.randomUUID(), run_id: runId, outcome: payload.outcome, notes: payload.notes, measured_values: payload.measured_values, evidence_hash: "c".repeat(64), signature: "d".repeat(64), signing_algorithm: "HMAC-SHA256", signing_key_id: "test", recorded_by: "local-reviewer", recorded_at: "2026-11-08T15:02:00Z", signature_valid: true, attachments: payload.attachments.map((attachment: Record<string, unknown>) => ({ id: crypto.randomUUID(), ...attachment, recorded_at: "2026-11-08T15:02:00Z" })) };
      cases[0].status = payload.outcome;
      const run = (cases[0].runs as Array<Record<string, unknown>>)[0];
      run.status = payload.outcome;
      run.completed_at = "2026-11-08T15:02:00Z";
      run.result = result;
      dueEvents.push({ id: crypto.randomUUID(), review_id: reviewId, case_id: caseId, case_key: "VER-001", event_type: "completed", due_at: cases[0].due_at, actor_subject: "local-reviewer", occurred_at: "2026-11-08T15:02:00Z" });
      return json(route, result, 201);
    }
    if (path.endsWith("/verification/coverage") && method === "GET") return json(route, coverage());
    if (path.endsWith("/verification/readiness") && method === "GET") return json(route, readiness());
    if (path.endsWith("/verification/due-events") && method === "GET") return json(route, { items: dueEvents });
    if (path.endsWith("/verification/due-events") && method === "POST") {
      if (cases.length && !dueEvents.some((event) => event.event_type === "due_soon")) dueEvents.push({ id: crypto.randomUUID(), review_id: reviewId, case_id: caseId, case_key: "VER-001", event_type: "due_soon", due_at: cases[0].due_at, actor_subject: "local-user", occurred_at: "2026-11-08T15:00:30Z" });
      return json(route, { items: dueEvents.filter((event) => event.event_type === "due_soon") }, 201);
    }
    if (path.endsWith(`/reviews/${reviewId}/evidence`) && method === "GET") return json(route, { review_id: reviewId, project_id: projectId, schema_version: "openrm-gate-evidence-v1", manifest: { review, verification_cases: cases, coverage: coverage(), readiness: readiness(), due_events: dueEvents }, manifest_hash: "e".repeat(64), signature: "f".repeat(64), signing_algorithm: "HMAC-SHA256", signing_key_id: "test", signature_valid: true });
    return json(route, { error: { code: "not_found", message: `Unhandled ${method} ${path}`, request_id: crypto.randomUUID() } }, 404);
  });
}

test.beforeEach(async ({ page }) => {
  await mockVerificationApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: /Verification/ }).click();
  await expect(page.getByRole("heading", { name: "Verification & gate readiness" })).toBeVisible();
  await expect(page.getByText("Live verification evidence • 0 cases • 0/2 revisions passed")).toBeVisible();
});

test("plans, executes, signs, rolls up, and exports verification evidence", async ({ page }) => {
  page.once("dialog", (dialog) => dialog.accept("Approved baseline qualification"));
  await page.getByRole("button", { name: "Create verification case" }).click();
  await expect(page.getByText("Approved baseline qualification")).toBeVisible();
  await page.getByRole("button", { name: "Evaluate due dates" }).click();
  await expect(page.getByText("1").filter({ visible: true })).toBeTruthy();
  await page.getByRole("button", { name: "Execute" }).click();

  const answers = ["passed", "Acceptance criteria satisfied with 147 ms latency.", `verification/${runId}/result.json`];
  const handleDialog = async (dialog: Dialog) => dialog.accept(answers.shift());
  page.on("dialog", handleDialog);
  await page.getByRole("button", { name: "Record result" }).click();
  page.off("dialog", handleDialog);

  await expect(page.getByRole("heading", { name: "Ready to proceed" })).toBeVisible();
  await expect(page.getByText("100%").first()).toBeVisible();
  await expect(page.getByText(/Signature valid • 1 attachments/)).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export gate evidence" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain("openrm-gate-");
  await expect(page.getByText("Verified gate evidence exported")).toBeVisible();
});

test("Verification workspace has no detectable WCAG A or AA violations", async ({ page }) => {
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
