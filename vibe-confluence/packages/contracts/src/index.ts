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
  "page:publish",
  "page:restore",
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
  currentRevisionId: string | null;
  version: number;
}

export interface PageWorkspace {
  page: PageSummary;
  space: SpaceSummary;
  draft: DraftView;
  revisions: RevisionView[];
}

export interface ApiErrorBody {
  error: { code: string; message: string; fields?: Record<string, string[]> };
  correlationId: string;
}
