import type { Capability } from "@vibe/contracts";
import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

export * from "./markdown";

const scrypt = promisify(scryptCallback);

export type OrganizationRole = "ADMIN" | "MEMBER";
export type ProjectRole = "ADMIN" | "MEMBER" | "VIEWER";

const organizationAdminCapabilities = new Set<Capability>([
  "project:create",
  "project:view",
  "project:admin",
  "issue:view",
  "issue:create",
  "issue:edit",
  "issue:delete",
  "issue:restore",
  "issue:transition",
  "comment:create",
  "issue:watch",
  "attachment:create",
  "attachment:delete",
  "filter:create",
  "filter:manage-shared",
  "outbox:monitor",
  "audit:read",
  "organization:admin",
  "data:manage",
]);

const roleCapabilities: Record<ProjectRole, ReadonlySet<Capability>> = {
  ADMIN: new Set([
    "project:view",
    "project:admin",
    "issue:view",
    "issue:create",
    "issue:edit",
    "issue:delete",
    "issue:restore",
    "issue:transition",
    "comment:create",
    "issue:watch",
    "attachment:create",
    "attachment:delete",
    "filter:create",
    "filter:manage-shared",
    "data:manage",
  ]),
  MEMBER: new Set([
    "project:view",
    "issue:view",
    "issue:create",
    "issue:edit",
    "issue:delete",
    "issue:transition",
    "comment:create",
    "issue:watch",
    "attachment:create",
    "attachment:delete",
    "filter:create",
  ]),
  VIEWER: new Set([
    "project:view",
    "issue:view",
    "issue:watch",
    "filter:create",
  ]),
};

export function can(
  organizationRole: OrganizationRole,
  projectRole: ProjectRole | null,
  capability: Capability,
): boolean {
  if (organizationRole === "ADMIN") {
    return organizationAdminCapabilities.has(capability);
  }
  if (capability === "project:create") {
    return false;
  }
  return projectRole ? roleCapabilities[projectRole].has(capability) : false;
}

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function assertCapability(
  organizationRole: OrganizationRole,
  projectRole: ProjectRole | null,
  capability: Capability,
): void {
  if (!can(organizationRole, projectRole, capability)) {
    throw new DomainError(
      "FORBIDDEN",
      "You do not have permission to perform this action",
      403,
    );
  }
}

export function assertVersion(expected: number, actual: number): void {
  if (expected !== actual) {
    throw new DomainError(
      "VERSION_CONFLICT",
      "This issue changed since it was loaded. Refresh and try again.",
      409,
    );
  }
}

export type MetricStatusCategory = "TODO" | "IN_PROGRESS" | "DONE";

export interface MetricTransition {
  at: Date;
  fromCategory: MetricStatusCategory;
  toCategory: MetricStatusCategory;
}

export interface MetricIssueTimeline {
  issueId: string;
  issueKey: string;
  summary: string;
  createdAt: Date;
  initialCategory: MetricStatusCategory;
  currentCategory: MetricStatusCategory;
  transitions: MetricTransition[];
}

export interface IssueFlowMetrics {
  leadTimeSeconds: number | null;
  cycleTimeSeconds: number | null;
  wipAgeSeconds: number | null;
  firstDoneAt: Date | null;
  statusSeconds: Record<MetricStatusCategory, number>;
}

function elapsedSeconds(from: Date, to: Date): number {
  return Math.max(0, (to.getTime() - from.getTime()) / 1_000);
}

export function categoryAt(
  issue: MetricIssueTimeline,
  instant: Date,
): MetricStatusCategory | null {
  if (issue.createdAt > instant) return null;
  let category = issue.initialCategory;
  for (const transition of [...issue.transitions].sort(
    (left, right) => left.at.getTime() - right.at.getTime(),
  )) {
    if (transition.at > instant) break;
    category = transition.toCategory;
  }
  return category;
}

export function computeIssueFlowMetrics(
  issue: MetricIssueTimeline,
  asOf: Date,
): IssueFlowMetrics {
  const transitions = [...issue.transitions]
    .filter(
      (transition) => transition.at >= issue.createdAt && transition.at <= asOf,
    )
    .sort((left, right) => left.at.getTime() - right.at.getTime());
  let category = issue.initialCategory;
  let intervalStart = issue.createdAt;
  let firstProgressAt: Date | null =
    category === "IN_PROGRESS" ? issue.createdAt : null;
  let latestProgressAt: Date | null = firstProgressAt;
  let firstDoneAt: Date | null = category === "DONE" ? issue.createdAt : null;
  const statusSeconds: Record<MetricStatusCategory, number> = {
    TODO: 0,
    IN_PROGRESS: 0,
    DONE: 0,
  };
  for (const transition of transitions) {
    statusSeconds[category] += elapsedSeconds(intervalStart, transition.at);
    category = transition.toCategory;
    intervalStart = transition.at;
    if (category === "IN_PROGRESS") {
      firstProgressAt ??= transition.at;
      latestProgressAt = transition.at;
    }
    if (category === "DONE") firstDoneAt ??= transition.at;
  }
  if (intervalStart < asOf) {
    statusSeconds[category] += elapsedSeconds(intervalStart, asOf);
  }
  const leadTimeSeconds = firstDoneAt
    ? elapsedSeconds(issue.createdAt, firstDoneAt)
    : null;
  const cycleTimeSeconds =
    firstProgressAt && firstDoneAt && firstDoneAt >= firstProgressAt
      ? elapsedSeconds(firstProgressAt, firstDoneAt)
      : null;
  return {
    leadTimeSeconds,
    cycleTimeSeconds,
    wipAgeSeconds:
      category === "IN_PROGRESS" && latestProgressAt
        ? elapsedSeconds(latestProgressAt, asOf)
        : null,
    firstDoneAt,
    statusSeconds,
  };
}

export function assertTransition(
  transition: { fromStatusId: string; toStatusId: string } | null,
  currentStatusId: string,
  requestedStatusId: string,
): asserts transition is { fromStatusId: string; toStatusId: string } {
  if (
    !transition ||
    transition.fromStatusId !== currentStatusId ||
    transition.toStatusId !== requestedStatusId
  ) {
    throw new DomainError(
      "INVALID_TRANSITION",
      "That workflow transition is not allowed",
      422,
    );
  }
}

export type IssueHierarchyLevel = -1 | 0 | 1;

export function canParentIssue(
  parentLevel: IssueHierarchyLevel,
  childLevel: IssueHierarchyLevel,
): boolean {
  return (
    (parentLevel === 1 && childLevel === 0) ||
    (parentLevel === 0 && childLevel === -1)
  );
}

export function assertIssueParent(
  childLevel: IssueHierarchyLevel,
  parentLevel: IssueHierarchyLevel | null,
): void {
  if (childLevel === -1 && parentLevel === null) {
    throw new DomainError(
      "PARENT_REQUIRED",
      "A subtask must have a Story, Task, or Bug parent",
      422,
    );
  }
  if (parentLevel !== null && !canParentIssue(parentLevel, childLevel)) {
    throw new DomainError(
      "INVALID_PARENT_HIERARCHY",
      "The selected parent is not valid for this issue type",
      422,
    );
  }
}

export function assertChildrenCompatible(
  parentLevel: IssueHierarchyLevel,
  childLevels: IssueHierarchyLevel[],
): void {
  if (
    childLevels.some((childLevel) => !canParentIssue(parentLevel, childLevel))
  ) {
    throw new DomainError(
      "INCOMPATIBLE_CHILD_HIERARCHY",
      "Change or remove this issue's children before changing its type",
      409,
    );
  }
}

export function parseMentionEmails(body: string): string[] {
  const emails = new Set<string>();
  const pattern =
    /(^|\s)@([a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,})\b/gi;
  for (const match of body.matchAll(pattern)) {
    if (match[2]) emails.add(match[2].toLowerCase());
  }
  return [...emails];
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt.toString("base64")}:${derivedKey.toString("base64")}`;
}

export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const [algorithm, saltValue, hashValue] = encoded.split(":");
  if (algorithm !== "scrypt" || !saltValue || !hashValue) {
    return false;
  }

  const expected = Buffer.from(hashValue, "base64");
  const actual = (await scrypt(
    password,
    Buffer.from(saltValue, "base64"),
    expected.length,
  )) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
