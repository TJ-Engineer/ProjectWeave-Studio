import type { Capability } from "@vibe/contracts";
import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

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
  "issue:transition",
]);

const roleCapabilities: Record<ProjectRole, ReadonlySet<Capability>> = {
  ADMIN: new Set([
    "project:view",
    "project:admin",
    "issue:view",
    "issue:create",
    "issue:edit",
    "issue:transition",
  ]),
  MEMBER: new Set([
    "project:view",
    "issue:view",
    "issue:create",
    "issue:edit",
    "issue:transition",
  ]),
  VIEWER: new Set(["project:view", "issue:view"]),
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
