import type {
  Capability,
  DocumentBlock,
  DocumentNode,
  OrganizationRole,
  SpaceRole,
} from "@knowledge/contracts";
import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

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

const allCapabilities = new Set<Capability>([
  "space:create",
  "space:view",
  "space:admin",
  "page:view",
  "page:create",
  "page:edit",
  "page:publish",
  "page:restore",
  "audit:read",
]);

const roleCapabilities: Record<SpaceRole, ReadonlySet<Capability>> = {
  ADMIN: new Set([
    "space:view",
    "space:admin",
    "page:view",
    "page:create",
    "page:edit",
    "page:publish",
    "page:restore",
  ]),
  EDITOR: new Set([
    "space:view",
    "page:view",
    "page:create",
    "page:edit",
    "page:publish",
    "page:restore",
  ]),
  VIEWER: new Set(["space:view", "page:view"]),
};

export function can(
  organizationRole: OrganizationRole,
  spaceRole: SpaceRole | null,
  capability: Capability,
): boolean {
  if (organizationRole === "ADMIN") return allCapabilities.has(capability);
  if (capability === "space:create" || capability === "audit:read")
    return false;
  return spaceRole ? roleCapabilities[spaceRole].has(capability) : false;
}

export function assertCapability(
  organizationRole: OrganizationRole,
  spaceRole: SpaceRole | null,
  capability: Capability,
): void {
  if (!can(organizationRole, spaceRole, capability)) {
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
      "This draft changed since it was loaded. Refresh and try again.",
      409,
    );
  }
}

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return slug || "page";
}

function blockText(block: DocumentBlock): string {
  return block.content.map((node) => node.text).join("");
}

export function documentToPlainText(document: DocumentNode): string {
  return document.content.map(blockText).join("\n");
}

export interface DocumentDiffLine {
  kind: "unchanged" | "added" | "removed";
  text: string;
}

export function diffDocuments(
  before: DocumentNode,
  after: DocumentNode,
): DocumentDiffLine[] {
  const left = documentToPlainText(before).split("\n");
  const right = documentToPlainText(after).split("\n");
  const common = Array.from({ length: left.length + 1 }, () =>
    Array<number>(right.length + 1).fill(0),
  );
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      common[i]![j] =
        left[i] === right[j]
          ? 1 + common[i + 1]![j + 1]!
          : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
    }
  }
  const result: DocumentDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      result.push({ kind: "unchanged", text: left[i]! });
      i += 1;
      j += 1;
    } else if (
      j < right.length &&
      (i === left.length || common[i]![j + 1]! > common[i + 1]![j]!)
    ) {
      result.push({ kind: "added", text: right[j]! });
      j += 1;
    } else {
      result.push({ kind: "removed", text: left[i]! });
      i += 1;
    }
  }
  return result;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt.toString("base64url")}:${derived.toString("base64url")}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [algorithm, saltValue, hashValue] = stored.split(":");
  if (algorithm !== "scrypt" || !saltValue || !hashValue) return false;
  const expected = Buffer.from(hashValue, "base64url");
  const actual = (await scrypt(
    password,
    Buffer.from(saltValue, "base64url"),
    expected.length,
  )) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
