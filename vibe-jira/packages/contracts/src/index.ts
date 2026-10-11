import { z } from "zod";

export const prioritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export type Priority = z.infer<typeof prioritySchema>;

export const statusCategorySchema = z.enum(["TODO", "IN_PROGRESS", "DONE"]);
export type StatusCategory = z.infer<typeof statusCategorySchema>;

export const capabilitySchema = z.enum([
  "project:create",
  "project:view",
  "project:admin",
  "issue:view",
  "issue:create",
  "issue:edit",
  "issue:transition",
]);
export type Capability = z.infer<typeof capabilitySchema>;

export const projectKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, "Use 2-10 uppercase letters or numbers");

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(100),
  key: projectKeySchema,
});

export const createIssueSchema = z.object({
  summary: z.string().trim().min(1).max(200),
  description: z.string().trim().max(20_000).optional().default(""),
  priority: prioritySchema.optional().default("MEDIUM"),
  issueType: z
    .enum(["EPIC", "STORY", "TASK", "BUG", "SUBTASK"])
    .optional()
    .default("TASK"),
});

export const transitionIssueSchema = z.object({
  transitionId: z.uuid(),
  destinationStatusId: z.uuid(),
  destinationRank: z.number().finite().positive(),
  version: z.number().int().positive(),
});

export const updateIssueSchema = z
  .object({
    summary: z.string().trim().min(1).max(200),
    description: z.string().trim().max(20_000),
    priority: prioritySchema,
    assigneeId: z.uuid().nullable(),
    version: z.number().int().positive(),
  })
  .strict();

export const loginSchema = z.object({
  email: z.email().trim().toLowerCase(),
  password: z.string().min(8).max(200),
});

export const paginationQuerySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    fields?: Record<string, string[]>;
    correlationId: string;
  };
}

export interface UserIdentity {
  id: string;
  organizationId: string;
  email: string;
  displayName: string;
  organizationRole: "ADMIN" | "MEMBER";
}

export interface ProjectSummary {
  id: string;
  key: string;
  name: string;
  boardId: string;
}

export interface StatusView {
  id: string;
  name: string;
  category: StatusCategory;
  color: string;
  position: number;
}

export interface TransitionView {
  id: string;
  name: string;
  fromStatusId: string;
  toStatusId: string;
}

export interface IssueView {
  id: string;
  key: string;
  summary: string;
  description: string;
  priority: Priority;
  issueType: string;
  statusId: string;
  rank: number;
  version: number;
  reporter: { id: string; displayName: string };
  assignee: { id: string; displayName: string } | null;
  updatedAt: string;
  allowedTransitions: TransitionView[];
}

export interface BoardColumnView {
  id: string;
  name: string;
  position: number;
  wipLimit: number | null;
  statusIds: string[];
}

export interface AssignableUserView {
  id: string;
  displayName: string;
}

export interface BoardView {
  id: string;
  name: string;
  project: { id: string; key: string; name: string };
  columns: BoardColumnView[];
  statuses: StatusView[];
  assignees: AssignableUserView[];
  issues: IssueView[];
}

export interface IssueEventView {
  id: string;
  eventType: "CREATED" | "TRANSITIONED" | "UPDATED";
  actorName: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface IssueDetailView extends IssueView {
  events: IssueEventView[];
}
