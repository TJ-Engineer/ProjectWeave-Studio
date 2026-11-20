import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Dialog, type Page, type Route } from "@playwright/test";

const projectId = "00000000-0000-4000-8000-000000000101";
const baselineId = "00000000-0000-4000-8000-000000000602";
const reviewId = "00000000-0000-4000-8000-000000000801";
const participantId = "00000000-0000-4000-8000-000000000802";
const commentId = "00000000-0000-4000-8000-000000000803";

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function mockReviewApi(page: Page) {
  const baseline = {
    id: baselineId,
    project_id: projectId,
    sequence: 2,
    name: "SRR candidate",
    changeset_id: "00000000-0000-4000-8000-000000000702",
    supersedes_baseline_id: null,
    artifact_count: 3,
    relationship_count: 1,
    manifest_hash: "d".repeat(64),
    signature: "f".repeat(64),
    signing_algorithm: "HMAC-SHA256",
    signing_key_id: "test",
    created_by: "baseline-author",
    created_at: "2026-11-08T14:05:00Z",
  };
  const members = [
    { subject: "local-user", role: "administrator", created_at: "2026-11-08T12:00:00Z" },
    { subject: "local-reviewer", role: "reviewer", created_at: "2026-11-08T12:01:00Z" },
  ];
  let reviews: Array<Record<string, unknown>> = [];
  const current = () => reviews[0];

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path.endsWith("/baselines") && method === "GET") return json(route, { items: [baseline] });
    if (path.endsWith("/members") && method === "GET") return json(route, { items: members });
    if (path.endsWith("/reviews") && method === "GET") return json(route, { items: reviews });
    if (path.endsWith("/reviews") && method === "POST") {
      const payload = request.postDataJSON();
      reviews = [{
        id: reviewId,
        project_id: projectId,
        sequence: 1,
        baseline_id: baselineId,
        baseline_sequence: 2,
        title: payload.title,
        description: payload.description,
        status: "draft",
        due_at: null,
        required_approvals: 1,
        current_round: 0,
        artifact_count: 3,
        participant_count: 0,
        approval_count: 0,
        open_comment_count: 0,
        blocking_comment_count: 0,
        created_by: "local-user",
        created_at: "2026-11-08T15:00:00Z",
        updated_at: "2026-11-08T15:00:00Z",
        participants: [],
        comments: [],
        decisions: [],
      }];
      return json(route, { review_id: reviewId, status: "draft", current_round: 0 }, 201);
    }
    if (path.endsWith(`/reviews/${reviewId}/participants`) && method === "POST") {
      const payload = request.postDataJSON();
      const participant = { id: participantId, subject: payload.subject, role_label: payload.role_label, required: true, assigned_by: "local-user", created_at: "2026-11-08T15:01:00Z", current_decision: null, decision_comment: null, decided_at: null };
      (current().participants as unknown[]).push(participant);
      current().participant_count = 1;
      return json(route, participant, 201);
    }
    if (path.endsWith(`/reviews/${reviewId}/start`) && method === "POST") {
      current().status = "in_review";
      current().current_round = 1;
      return json(route, { review_id: reviewId, status: "in_review", current_round: 1 });
    }
    if (path.endsWith(`/reviews/${reviewId}/comments`) && method === "POST") {
      const payload = request.postDataJSON();
      const comment = { id: commentId, target_artifact_id: null, target_revision_id: null, target_key: null, body: payload.body, blocking: payload.blocking, created_by: "local-reviewer", created_at: "2026-11-08T15:02:00Z", resolved: false, resolution: null, resolved_by: null, resolved_at: null };
      (current().comments as unknown[]).push(comment);
      current().open_comment_count = 1;
      current().blocking_comment_count = 1;
      return json(route, comment, 201);
    }
    if (path.endsWith(`/reviews/${reviewId}/decisions`) && method === "POST") {
      const participant = (current().participants as Array<Record<string, unknown>>)[0];
      participant.current_decision = "approved";
      participant.decision_comment = request.postDataJSON().comment;
      participant.decided_at = "2026-11-08T15:03:00Z";
      const decision = { id: "00000000-0000-4000-8000-000000000804", participant_id: participantId, subject: "local-reviewer", round: 1, decision: "approved", comment: request.postDataJSON().comment, evidence_hash: "a".repeat(64), signature: "b".repeat(64), signing_algorithm: "HMAC-SHA256", signing_key_id: "test", decided_by: "local-reviewer", decided_at: "2026-11-08T15:03:00Z", signature_valid: true, package_status: "in_review" };
      (current().decisions as unknown[]).push(decision);
      current().approval_count = 1;
      return json(route, decision, 201);
    }
    if (path.endsWith(`/reviews/${reviewId}/comments/${commentId}/resolve`) && method === "POST") {
      const comment = (current().comments as Array<Record<string, unknown>>)[0];
      comment.resolved = true;
      comment.resolution = request.postDataJSON().resolution;
      comment.resolved_by = "local-user";
      comment.resolved_at = "2026-11-08T15:04:00Z";
      current().open_comment_count = 0;
      current().blocking_comment_count = 0;
      current().status = "approved";
      return json(route, { id: crypto.randomUUID(), review_id: reviewId, comment_id: commentId, resolution: comment.resolution, resolved_by: "local-user", resolved_at: comment.resolved_at, package_status: "approved" }, 201);
    }
    return json(route, { error: { code: "not_found", message: `Unhandled ${method} ${path}`, request_id: crypto.randomUUID() } }, 404);
  });
}

test.beforeEach(async ({ page }) => {
  await mockReviewApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: /Reviews/ }).click();
  await expect(page.getByRole("heading", { name: "Review room" })).toBeVisible();
  await expect(page.getByText("Live review evidence • 0 packages • 1 signed baselines")).toBeVisible();
});

test("creates a package and completes the signed approval gate after blocker resolution", async ({ page }) => {
  page.once("dialog", (dialog) => dialog.accept("SRR controlled review"));
  await page.getByRole("button", { name: "Create review package" }).click();
  await expect(page.getByRole("heading", { name: "SRR controlled review" })).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept("local-reviewer"));
  await page.getByRole("button", { name: "Assign reviewer" }).click();
  await expect(page.getByText("local-reviewer", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start round" }).click();

  const commentDialogs = ["Provide independent safety analysis.", "accept"];
  const handleCommentDialog = async (dialog: Dialog) => {
    const response = commentDialogs.shift();
    if (response === "accept") await dialog.accept();
    else await dialog.accept(response);
  };
  page.on("dialog", handleCommentDialog);
  await page.getByRole("button", { name: "Add reviewer comment" }).click();
  page.off("dialog", handleCommentDialog);
  await expect(page.getByText("Blocks approval")).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept("Reviewed against the exact baseline."));
  await page.getByRole("button", { name: "Record approval" }).click();
  await expect(page.getByText("SIGNATURE VALID")).toBeVisible();
  await expect(page.getByText("IN REVIEW").first()).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept("Safety analysis attached and accepted."));
  await page.getByRole("button", { name: "Resolve" }).click();
  await expect(page.getByText("Approval complete")).toBeVisible();
  await expect(page.getByText("Policy threshold satisfied")).toBeVisible();
});

test("Review Room has no detectable WCAG A or AA violations", async ({ page }) => {
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
