import { z } from "zod";

export const organizationRoleSchema = z.enum(["ADMIN", "MEMBER"]);
export type OrganizationRole = z.infer<typeof organizationRoleSchema>;

export const spaceRoleSchema = z.enum(["ADMIN", "EDITOR", "VIEWER"]);
export type SpaceRole = z.infer<typeof spaceRoleSchema>;

export const capabilitySchema = z.enum([
  "space:create",
  "space:view",
  "space:admin",
  "page:view",
  "page:create",
  "page:edit",
  "page:archive",
  "page:move",
  "page:publish",
  "page:restore",
  "page:trash",
  "audit:read",
]);
export type Capability = z.infer<typeof capabilitySchema>;

const textNodeSchema = z.object({
  type: z.literal("text"),
  text: z.string().max(20_000),
});

const inlineContentSchema = z.array(textNodeSchema).max(500);

const headingNodeSchema = z.object({
  type: z.literal("heading"),
  attrs: z.object({
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  }),
  content: inlineContentSchema,
});

const paragraphNodeSchema = z.object({
  type: z.literal("paragraph"),
  content: inlineContentSchema,
});

export const documentNodeSchema = z
  .object({
    type: z.literal("doc"),
    schemaVersion: z.literal(1),
    content: z
      .array(z.union([headingNodeSchema, paragraphNodeSchema]))
      .min(1)
      .max(500),
  })
  .superRefine((document, context) => {
    if (JSON.stringify(document).length > 100_000) {
      context.addIssue({
        code: "custom",
        message: "Document exceeds the 100 KB structured-content limit",
      });
    }
  });
export type DocumentNode = z.infer<typeof documentNodeSchema>;
export type DocumentBlock = DocumentNode["content"][number];

export const emptyDocument: DocumentNode = {
  type: "doc",
  schemaVersion: 1,
  content: [{ type: "paragraph", content: [] }],
};

export const loginSchema = z.object({
  email: z.email().trim().toLowerCase(),
  password: z.string().min(8).max(200),
});

export const spaceKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, "Use 2-10 uppercase letters or numbers");

export const createSpaceSchema = z.object({
  key: spaceKeySchema,
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2_000).optional().default(""),
});

export const createPageSchema = z.object({
  title: z.string().trim().min(1).max(200),
  parentId: z.uuid().nullable().optional().default(null),
});

export const pageTreeQuerySchema = z
  .object({
    parentId: z.uuid().nullable().default(null),
    cursor: z.uuid().nullable().default(null),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const movePageSchema = z
  .object({
    destinationParentId: z.uuid().nullable(),
    beforePageId: z.uuid().nullable(),
    afterPageId: z.uuid().nullable(),
    expectedSourceVersion: z.number().int().positive(),
    expectedDestinationVersion: z.number().int().positive(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.beforePageId !== null &&
      input.beforePageId === input.afterPageId
    ) {
      context.addIssue({
        code: "custom",
        message: "The neighboring pages must be different",
        path: ["afterPageId"],
      });
    }
  });

export const pageLifecycleActionSchema = z
  .object({
    action: z.enum(["ARCHIVE", "TRASH", "RESTORE"]),
    expectedVersion: z.number().int().positive(),
    expectedParentVersion: z.number().int().positive(),
    destinationParentId: z.uuid().nullable().optional(),
    beforePageId: z.uuid().nullable().optional(),
    afterPageId: z.uuid().nullable().optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.beforePageId !== undefined &&
      input.beforePageId !== null &&
      input.beforePageId === input.afterPageId
    ) {
      context.addIssue({
        code: "custom",
        message: "The neighboring pages must be different",
        path: ["afterPageId"],
      });
    }
    if (
      input.action !== "RESTORE" &&
      (input.destinationParentId !== undefined ||
        input.beforePageId !== undefined ||
        input.afterPageId !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Only restore may select a destination",
        path: ["destinationParentId"],
      });
    }
  });

export const pageSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use a normalized page slug");

export const saveDraftSchema = z.object({
  title: z.string().trim().min(1).max(200),
  document: documentNodeSchema,
  baseRevisionId: z.uuid().nullable(),
  version: z.number().int().positive(),
});

export const publishPageSchema = saveDraftSchema.extend({
  summary: z.string().trim().max(500).optional().default(""),
});

export const restoreRevisionSchema = z.object({
  expectedHeadRevisionId: z.uuid().nullable(),
  summary: z.string().trim().max(500).optional().default("Restored revision"),
});

export const spaceMemberPageQuerySchema = z
  .object({
    kind: z.enum(["members", "candidates"]).default("members"),
    query: z.string().trim().max(100).default(""),
    cursor: z.uuid().nullable().default(null),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

export const upsertSpaceMemberSchema = z
  .object({
    role: spaceRoleSchema,
    expectedMembershipVersion: z.number().int().positive(),
  })
  .strict();

export const removeSpaceMemberSchema = z
  .object({
    expectedMembershipVersion: z.number().int().positive(),
  })
  .strict();

export const updatePageRestrictionSchema = z
  .object({
    restricted: z.boolean(),
    memberIds: z.array(z.uuid()).max(100),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((input, context) => {
    if (new Set(input.memberIds).size !== input.memberIds.length) {
      context.addIssue({
        code: "custom",
        message: "Restriction members must be unique",
        path: ["memberIds"],
      });
    }
    if (!input.restricted && input.memberIds.length) {
      context.addIssue({
        code: "custom",
        message: "An unrestricted page cannot retain allowlist members",
        path: ["memberIds"],
      });
    }
  });

export interface UserIdentity {
  id: string;
  organizationId: string;
  email: string;
  displayName: string;
  organizationRole: OrganizationRole;
}

export interface SpaceSummary {
  id: string;
  key: string;
  name: string;
  description: string;
  role: SpaceRole;
  version: number;
}

export interface DraftView {
  id: string;
  title: string;
  document: DocumentNode;
  baseRevisionId: string | null;
  version: number;
  savedAt: string;
}

export interface RevisionView {
  id: string;
  number: number;
  title: string;
  document: DocumentNode;
  plainText: string;
  summary: string;
  authorName: string;
  createdAt: string;
}

export interface PageSummary {
  id: string;
  spaceId: string;
  parentId: string | null;
  title: string;
  slug: string;
  state: "ACTIVE" | "ARCHIVED" | "TRASHED";
  currentRevisionId: string | null;
  version: number;
}

export interface PageTreeNode extends PageSummary {
  hasChildren: boolean;
}

export interface PageBreadcrumb {
  id: string;
  title: string;
  slug: string;
}

export interface PageTreePage {
  space: SpaceSummary;
  parentId: string | null;
  parentVersion: number;
  breadcrumbs: PageBreadcrumb[];
  items: PageTreeNode[];
  nextCursor: string | null;
}

export interface MovePageResult {
  page: PageSummary;
  sourceParentId: string | null;
  destinationParentId: string | null;
  sourceVersion: number;
  destinationVersion: number;
  restrictionMaterialized: boolean;
}

export interface PageAliasResolution {
  pageId: string;
  canonicalSlug: string;
  state: "ACTIVE" | "ARCHIVED";
  canonicalPath: string;
}

export interface PageLifecycleResult {
  page: PageSummary;
  action: "ARCHIVE" | "TRASH" | "RESTORE";
  affectedPageCount: number;
  parentVersion: number;
  restrictionMaterialized: boolean;
  restoredToFallback: boolean;
}

export interface PageWorkspace {
  page: PageSummary;
  space: SpaceSummary;
  draft: DraftView;
  revisions: RevisionView[];
}

export interface PublishedPageView {
  page: PageSummary;
  space: SpaceSummary;
  revision: RevisionView;
  canEdit: boolean;
  readOnly: true;
}

export interface SpaceMemberView {
  userId: string;
  displayName: string;
  email: string;
  role: SpaceRole;
  unpublishedPageCount: number;
  pageGrantCount: number;
}

export interface OrganizationMemberCandidate {
  userId: string;
  displayName: string;
  email: string;
}

export interface SpaceMemberPage {
  space: SpaceSummary;
  membershipVersion: number;
  kind: "members" | "candidates";
  items: SpaceMemberView[] | OrganizationMemberCandidate[];
  nextCursor: string | null;
}

export interface MembershipMutationResult {
  membershipVersion: number;
  member: SpaceMemberView | null;
  affectedPageGrantCount: number;
}

export interface PageRestrictionAdministration {
  page: PageSummary;
  space: SpaceSummary;
  restricted: boolean;
  version: number;
  memberIds: string[];
}

export interface ApiErrorBody {
  error: { code: string; message: string; fields?: Record<string, string[]> };
  correlationId: string;
}
