import type {
  IssueType,
  IssueView,
  Priority,
  ProjectSummary,
  UserIdentity,
} from "@vibe/contracts";
import { getPool } from "./client";
import {
  createIssue,
  getBoard,
  getBoardAccess,
  transitionIssue,
  type ProjectAccess,
} from "./repository";

type DefaultStatusName =
  "Backlog" | "Selected" | "In Progress" | "Review" | "Done";

interface DevelopmentIssueSeed {
  summary: string;
  description: string;
  priority: Priority;
  issueType: IssueType;
  targetStatus: DefaultStatusName;
  assignToAdmin: boolean;
  childOfLaunchEpic?: boolean;
}

const developmentIssueSeeds: readonly DevelopmentIssueSeed[] = [
  {
    summary: "Prepare ProjectWeave for production launch",
    description:
      "Track the deployment-specific work required after approval of the Release 1 candidate.",
    priority: "CRITICAL",
    issueType: "EPIC",
    targetStatus: "In Progress",
    assignToAdmin: true,
  },
  {
    summary: "Verify production identity and infrastructure settings",
    description:
      "Verify secrets, HTTPS and trusted-proxy behavior, OIDC claims and redirects, object storage, malware scanning, and metrics protection.",
    priority: "CRITICAL",
    issueType: "TASK",
    targetStatus: "Selected",
    assignToAdmin: true,
    childOfLaunchEpic: true,
  },
  {
    summary: "Configure production dashboards and alerts",
    description:
      "Cover readiness, database pool health, outbox age and dead letters, jobs, errors, latency, disk capacity, and backup freshness.",
    priority: "HIGH",
    issueType: "TASK",
    targetStatus: "In Progress",
    assignToAdmin: true,
    childOfLaunchEpic: true,
  },
  {
    summary: "Assign launch and support owners",
    description:
      "Name owners for administrator and member onboarding, support escalation, data retention, and invitation delivery.",
    priority: "HIGH",
    issueType: "TASK",
    targetStatus: "Backlog",
    assignToAdmin: false,
    childOfLaunchEpic: true,
  },
  {
    summary: "Approve the production target and operational budget",
    description:
      "Select the production environment and confirm that its capacity and operating budget meet the published performance envelope.",
    priority: "HIGH",
    issueType: "STORY",
    targetStatus: "Backlog",
    assignToAdmin: false,
    childOfLaunchEpic: true,
  },
  {
    summary: "Record the production activation decision",
    description:
      "Have the production owner approve deployment-specific settings, name the observation owner and window, and record the production exit decision.",
    priority: "CRITICAL",
    issueType: "TASK",
    targetStatus: "Review",
    assignToAdmin: true,
    childOfLaunchEpic: true,
  },
  {
    summary: "Publish the v0.1.0 release candidate",
    description:
      "The tagged Release 1 candidate passed its quality, migration, browser, accessibility, recovery, and container-security gates.",
    priority: "HIGH",
    issueType: "TASK",
    targetStatus: "Done",
    assignToAdmin: true,
    childOfLaunchEpic: true,
  },
] as const;

async function moveIssueToStatus(
  identity: UserIdentity,
  access: ProjectAccess,
  project: ProjectSummary,
  issue: IssueView,
  targetStatusName: DefaultStatusName,
): Promise<void> {
  const initialBoard = await getBoard(project.boardId, access);
  if (!initialBoard) {
    throw new Error("Seeded development board could not be loaded");
  }

  const statusPath = [
    "Backlog",
    "Selected",
    "In Progress",
    "Review",
    "Done",
  ].filter((name) =>
    initialBoard.statuses.some((status) => status.name === name),
  );
  const targetIndex = statusPath.indexOf(targetStatusName);
  let current = issue;
  let currentIndex = statusPath.findIndex(
    (name) =>
      initialBoard.statuses.find((status) => status.name === name)?.id ===
      current.statusId,
  );
  if (targetIndex < 0 || currentIndex < 0 || targetIndex < currentIndex) {
    throw new Error(`Cannot seed issue into status ${targetStatusName}`);
  }

  while (currentIndex < targetIndex) {
    const board = await getBoard(project.boardId, access);
    if (!board) {
      throw new Error("Seeded development board could not be refreshed");
    }
    const nextStatusName = statusPath[currentIndex + 1];
    const nextStatus = board.statuses.find(
      (status) => status.name === nextStatusName,
    );
    if (!nextStatus) {
      throw new Error(`Seed status ${nextStatusName ?? "unknown"} is missing`);
    }
    const destinationColumn = board.columns.find((column) =>
      column.statusIds.includes(nextStatus.id),
    );
    const transition = current.allowedTransitions.find(
      (candidate) => candidate.toStatusId === nextStatus.id,
    );
    if (!destinationColumn || !transition) {
      throw new Error(
        `Seed transition to ${nextStatus.name} is not configured`,
      );
    }
    const destinationIssues = board.issues.filter(
      (candidate) =>
        candidate.id !== current.id &&
        destinationColumn.statusIds.includes(candidate.statusId),
    );
    current = await transitionIssue(identity, access, current.key, {
      transitionId: transition.id,
      destinationColumnId: destinationColumn.id,
      destinationStatusId: nextStatus.id,
      beforeIssueId: destinationIssues.at(-1)?.id ?? null,
      afterIssueId: null,
      version: current.version,
    });
    currentIndex += 1;
  }
}

export async function seedDevelopmentBoard(
  identity: UserIdentity,
  project: ProjectSummary,
): Promise<number> {
  const markerOperation = "development.board.seed";
  const markerKey = `v1:${project.id}`;
  const completed = await getPool().query<{ completed: boolean }>(
    `SELECT response_body IS NOT NULL AS completed
       FROM idempotency_records
      WHERE organization_id = $1 AND actor_id = $2
        AND operation = $3 AND idempotency_key = $4`,
    [identity.organizationId, identity.id, markerOperation, markerKey],
  );
  if (completed.rows[0]?.completed) return 0;

  const access = await getBoardAccess(identity.id, project.boardId);
  if (!access) throw new Error("Seeded development board access is missing");

  const board = await getBoard(project.boardId, access);
  if (!board) throw new Error("Seeded development board could not be loaded");
  const seedSummaries = new Set(
    developmentIssueSeeds.map((seed) => seed.summary),
  );
  const existingSeeds = board.issues.filter(
    (issue) =>
      seedSummaries.has(issue.summary) &&
      issue.labels.includes("development") &&
      issue.labels.includes("release-1"),
  );
  if (board.issues.length > 0 && existingSeeds.length === 0) return 0;

  let launchEpicKey: string | null = null;
  let createdCount = 0;
  for (const seed of developmentIssueSeeds) {
    let issue = existingSeeds.find(
      (candidate) => candidate.summary === seed.summary,
    );
    if (!issue) {
      issue = await createIssue(identity, access, {
        summary: seed.summary,
        description: seed.description,
        priority: seed.priority,
        issueType: seed.issueType,
        assigneeId: seed.assignToAdmin ? identity.id : null,
        labels: ["development", "release-1"],
        parentIssueKey: seed.childOfLaunchEpic ? launchEpicKey : null,
      });
      createdCount += 1;
    }
    if (seed.issueType === "EPIC") launchEpicKey = issue.key;
    await moveIssueToStatus(
      identity,
      access,
      project,
      issue,
      seed.targetStatus,
    );
  }
  await getPool().query(
    `INSERT INTO idempotency_records
      (organization_id, actor_id, operation, idempotency_key, request_hash,
       response_body)
     VALUES ($1, $2, $3, $4, 'development-board-v1', $5)
     ON CONFLICT (organization_id, actor_id, operation, idempotency_key)
     DO UPDATE SET response_body = EXCLUDED.response_body`,
    [
      identity.organizationId,
      identity.id,
      markerOperation,
      markerKey,
      JSON.stringify({ issueCount: developmentIssueSeeds.length }),
    ],
  );
  return createdCount;
}
