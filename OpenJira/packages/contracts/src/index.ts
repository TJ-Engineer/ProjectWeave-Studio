import { z } from "zod";

export const prioritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export type Priority = z.infer<typeof prioritySchema>;

export const issueTypeSchema = z.enum([
  "EPIC",
  "STORY",
  "TASK",
  "BUG",
  "SUBTASK",
]);
export type IssueType = z.infer<typeof issueTypeSchema>;

export const statusCategorySchema = z.enum(["TODO", "IN_PROGRESS", "DONE"]);
export type StatusCategory = z.infer<typeof statusCategorySchema>;

export const swimlaneModeSchema = z.enum(["none", "assignee", "epic"]);
export type SwimlaneMode = z.infer<typeof swimlaneModeSchema>;

export const projectRoleSchema = z.enum(["ADMIN", "MEMBER", "VIEWER"]);
export type ProjectRole = z.infer<typeof projectRoleSchema>;

export const organizationRoleSchema = z.enum(["ADMIN", "MEMBER"]);
export type OrganizationRole = z.infer<typeof organizationRoleSchema>;

export const capabilitySchema = z.enum([
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
export type Capability = z.infer<typeof capabilitySchema>;

export const projectKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, "Use 2-10 uppercase letters or numbers");

export const issueKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^[A-Z][A-Z0-9]{1,9}-[1-9]\d*$/,
    "Use a valid issue key such as ENG-142",
  );

export const labelSchema = z.string().trim().min(1).max(50);

export const dueDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine(
    (value) =>
      new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value,
    "Use a real calendar date",
  );

export const estimatePointsSchema = z.number().int().min(0).max(1_000_000);

export const labelListSchema = z
  .array(labelSchema)
  .max(20)
  .superRefine((labels, context) => {
    const normalized = new Set<string>();
    for (const [index, label] of labels.entries()) {
      const value = label.replace(/\s+/g, " ").toLocaleLowerCase();
      if (normalized.has(value)) {
        context.addIssue({
          code: "custom",
          message: "Labels must be unique",
          path: [index],
        });
      }
      normalized.add(value);
    }
  });

export const projectTemplateSchema = z.enum(["FIVE_STATUS", "SIMPLE"]);
export type ProjectTemplate = z.infer<typeof projectTemplateSchema>;

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(100),
  key: projectKeySchema,
  template: projectTemplateSchema.optional().default("FIVE_STATUS"),
});

export const createIssueSchema = z.object({
  summary: z.string().trim().min(1).max(200),
  description: z.string().trim().max(20_000).optional().default(""),
  priority: prioritySchema.optional().default("MEDIUM"),
  issueType: issueTypeSchema.optional().default("TASK"),
  assigneeId: z.uuid().nullable().optional().default(null),
  labels: labelListSchema.optional().default([]),
  parentIssueKey: issueKeySchema.nullable().optional().default(null),
  estimatePoints: estimatePointsSchema.nullable().optional().default(null),
  dueDate: dueDateSchema.nullable().optional().default(null),
});

export const transitionIssueSchema = z
  .object({
    transitionId: z.uuid().nullable(),
    destinationColumnId: z.uuid(),
    destinationStatusId: z.uuid(),
    beforeIssueId: z.uuid().nullable(),
    afterIssueId: z.uuid().nullable(),
    version: z.number().int().positive(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.beforeIssueId !== null &&
      input.beforeIssueId === input.afterIssueId
    ) {
      context.addIssue({
        code: "custom",
        message: "The neighboring issues must be different",
        path: ["afterIssueId"],
      });
    }
  });

export const updateIssueSchema = z
  .object({
    summary: z.string().trim().min(1).max(200),
    description: z.string().trim().max(20_000),
    priority: prioritySchema,
    issueType: issueTypeSchema,
    assigneeId: z.uuid().nullable(),
    labels: labelListSchema,
    parentIssueKey: issueKeySchema.nullable(),
    estimatePoints: estimatePointsSchema.nullable().optional().default(null),
    dueDate: dueDateSchema.nullable().optional().default(null),
    version: z.number().int().positive(),
  })
  .strict();

export const issueLifecycleSchema = z
  .object({ version: z.number().int().positive() })
  .strict();

export const loginSchema = z.object({
  email: z.email().trim().toLowerCase(),
  password: z.string().min(8).max(200),
});

export const updateProjectMemberSchema = z
  .object({ role: projectRoleSchema })
  .strict();

export const updateBoardColumnWipLimitSchema = z
  .object({
    wipLimit: z.number().int().min(1).max(10_000).nullable(),
    version: z.number().int().positive(),
  })
  .strict();

const workflowStatusInputSchema = z
  .object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(60),
    category: statusCategorySchema,
    color: z.string().regex(/^#[0-9a-f]{6}$/i, "Use a six-digit hex color"),
    columnId: z.uuid(),
  })
  .strict();

const workflowTransitionInputSchema = z
  .object({ fromStatusId: z.uuid(), toStatusId: z.uuid() })
  .strict();

export const updateWorkflowConfigurationSchema = z
  .object({
    version: z.number().int().positive(),
    statuses: z.array(workflowStatusInputSchema).min(3).max(20),
    transitions: z.array(workflowTransitionInputSchema).max(200),
    removedStatusMigrations: z
      .array(
        z.object({ fromStatusId: z.uuid(), toStatusId: z.uuid() }).strict(),
      )
      .max(20)
      .default([]),
  })
  .strict()
  .superRefine((input, context) => {
    const ids = new Set<string>();
    const names = new Set<string>();
    const categories = new Set<StatusCategory>();
    for (const [index, status] of input.statuses.entries()) {
      if (ids.has(status.id)) {
        context.addIssue({
          code: "custom",
          message: "Status IDs must be unique",
          path: ["statuses", index, "id"],
        });
      }
      ids.add(status.id);
      const name = status.name.toLocaleLowerCase();
      if (names.has(name)) {
        context.addIssue({
          code: "custom",
          message: "Status names must be unique",
          path: ["statuses", index, "name"],
        });
      }
      names.add(name);
      categories.add(status.category);
    }
    for (const category of statusCategorySchema.options) {
      if (!categories.has(category)) {
        context.addIssue({
          code: "custom",
          message: `At least one ${category} status is required`,
          path: ["statuses"],
        });
      }
    }
    const edges = new Set<string>();
    for (const [index, transition] of input.transitions.entries()) {
      if (
        !ids.has(transition.fromStatusId) ||
        !ids.has(transition.toStatusId)
      ) {
        context.addIssue({
          code: "custom",
          message: "Transitions must reference configured statuses",
          path: ["transitions", index],
        });
      }
      if (transition.fromStatusId === transition.toStatusId) {
        context.addIssue({
          code: "custom",
          message: "A transition must change status",
          path: ["transitions", index],
        });
      }
      const edge = `${transition.fromStatusId}:${transition.toStatusId}`;
      if (edges.has(edge)) {
        context.addIssue({
          code: "custom",
          message: "Transitions must be unique",
          path: ["transitions", index],
        });
      }
      edges.add(edge);
    }
    const migrations = new Set<string>();
    for (const [index, migration] of input.removedStatusMigrations.entries()) {
      if (migrations.has(migration.fromStatusId)) {
        context.addIssue({
          code: "custom",
          message: "A removed status can have only one migration target",
          path: ["removedStatusMigrations", index, "fromStatusId"],
        });
      }
      migrations.add(migration.fromStatusId);
      if (!ids.has(migration.toStatusId)) {
        context.addIssue({
          code: "custom",
          message: "Migration targets must be configured statuses",
          path: ["removedStatusMigrations", index, "toStatusId"],
        });
      }
    }
  });
export type UpdateWorkflowConfigurationInput = z.infer<
  typeof updateWorkflowConfigurationSchema
>;

export const paginationQuerySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const boardIssuesQuerySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  q: z.string().trim().max(200).optional(),
  issueType: issueTypeSchema.optional(),
  priority: prioritySchema.optional(),
  assignee: z.union([z.uuid(), z.literal("unassigned")]).optional(),
  label: labelSchema.optional(),
  epicKey: issueKeySchema.optional(),
});
export type BoardIssuesQuery = z.infer<typeof boardIssuesQuerySchema>;

function commaSeparated(value: unknown): unknown {
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((item) => (typeof item === "string" ? item.split(",") : []))
    .map((item) => item.trim())
    .filter(Boolean);
}

const searchList = <T extends z.ZodType>(item: T, maximum = 50) =>
  z.preprocess(commaSeparated, z.array(item).max(maximum).default([]));

const optionalSearchDate = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.iso.date().optional(),
);

const optionalSearchDirection = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.enum(["asc", "desc"]).optional(),
);

export const issueSearchSortSchema = z.enum([
  "relevance",
  "rank",
  "priority",
  "created",
  "updated",
  "key",
]);
export type IssueSearchSort = z.infer<typeof issueSearchSortSchema>;

export const issueSearchQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    q: z.string().trim().max(200).default(""),
    projects: searchList(projectKeySchema, 25),
    issueTypes: searchList(issueTypeSchema, issueTypeSchema.options.length),
    statuses: searchList(z.uuid(), 50),
    statusCategories: searchList(
      statusCategorySchema,
      statusCategorySchema.options.length,
    ),
    priorities: searchList(prioritySchema, prioritySchema.options.length),
    assignees: searchList(z.union([z.uuid(), z.literal("unassigned")]), 50),
    reporters: searchList(z.uuid(), 50),
    labels: searchList(labelSchema, 20),
    parents: searchList(issueKeySchema, 25),
    createdFrom: optionalSearchDate,
    createdTo: optionalSearchDate,
    updatedFrom: optionalSearchDate,
    updatedTo: optionalSearchDate,
    sort: issueSearchSortSchema.default("relevance"),
    direction: optionalSearchDirection,
  })
  .superRefine((value, context) => {
    for (const [from, to, path] of [
      [value.createdFrom, value.createdTo, "createdTo"],
      [value.updatedFrom, value.updatedTo, "updatedTo"],
    ] as const) {
      if (from && to && from > to) {
        context.addIssue({
          code: "custom",
          message: "The end date must be on or after the start date",
          path: [path],
        });
      }
    }
  });
export type IssueSearchQuery = z.infer<typeof issueSearchQuerySchema>;

export const savedFilterVisibilitySchema = z.enum([
  "PRIVATE",
  "PROJECT",
  "ORGANIZATION",
]);
export type SavedFilterVisibility = z.infer<typeof savedFilterVisibilitySchema>;

export const createSavedFilterSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    visibility: savedFilterVisibilitySchema,
    projectKey: projectKeySchema.nullable().optional().default(null),
    query: issueSearchQuerySchema,
    isQuick: z.boolean().optional().default(false),
  })
  .strict();
export type CreateSavedFilterInput = z.infer<typeof createSavedFilterSchema>;

export const updateSavedFilterSchema = createSavedFilterSchema
  .extend({ version: z.number().int().positive() })
  .strict();
export type UpdateSavedFilterInput = z.infer<typeof updateSavedFilterSchema>;

export const savedFiltersQuerySchema = z.object({
  projectKey: projectKeySchema.optional(),
});

export type SavedFilterQuery = Omit<IssueSearchQuery, "cursor" | "limit">;

export interface SavedFilterView {
  id: string;
  name: string;
  visibility: SavedFilterVisibility;
  owner: { id: string; displayName: string };
  project: ProjectSummary | null;
  query: SavedFilterQuery;
  isQuick: boolean;
  position: number | null;
  version: number;
  canEdit: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface QuickFilterView {
  id: string;
  name: string;
  query: {
    q: string;
    issueType: IssueType | "";
    priority: Priority | "";
    assignee: string;
    label: string;
    epicKey: string;
  };
}

export const retryOutboxEventSchema = z.object({ eventId: z.uuid() }).strict();

export interface OutboxTopicHealth {
  topic: string;
  pending: number;
  deadLettered: number;
}

export interface OutboxDeadLetterView {
  id: string;
  topic: string;
  aggregateId: string;
  attempts: number;
  lastError: string;
  createdAt: string;
  deadLetteredAt: string;
}

export interface OutboxHealthView {
  worker: {
    state: "HEALTHY" | "STALE" | "STARTING";
    instanceId: string | null;
    lastSeenAt: string | null;
    lastError: string | null;
  };
  pending: number;
  deadLettered: number;
  deliveredLastHour: number;
  oldestPendingAt: string | null;
  topics: OutboxTopicHealth[];
  deadLetters: OutboxDeadLetterView[];
}

const optionalAuditText = z.string().trim().max(100).optional();
const optionalAuditDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date in YYYY-MM-DD format")
  .optional();

export const auditEventsQuerySchema = z
  .object({
    cursor: z.string().trim().max(2_000).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    actorId: z.uuid().optional(),
    action: optionalAuditText,
    targetType: optionalAuditText,
    targetId: z.uuid().optional(),
    correlationId: z.uuid().optional(),
    from: optionalAuditDate,
    to: optionalAuditDate,
  })
  .superRefine((value, context) => {
    if (value.from && value.to && value.from > value.to) {
      context.addIssue({
        code: "custom",
        message: "The end date must be on or after the start date",
        path: ["to"],
      });
    }
  });
export type AuditEventsQuery = z.infer<typeof auditEventsQuerySchema>;

export const updateAuditRetentionSchema = z
  .object({
    days: z.number().int().min(30).max(3650),
    version: z.number().int().positive(),
  })
  .strict();

export interface AuditEventView {
  id: string;
  actor: { id: string; displayName: string; email: string };
  action: string;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown>;
  correlationId: string;
  createdAt: string;
}

export interface AuditEventsView extends Page<AuditEventView> {
  retention: { days: number; version: number };
  facets: {
    actors: Array<{ id: string; displayName: string; email: string }>;
    actions: string[];
    targetTypes: string[];
  };
}

export const updateOrganizationSettingsSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    version: z.number().int().positive(),
  })
  .strict();
export type UpdateOrganizationSettingsInput = z.infer<
  typeof updateOrganizationSettingsSchema
>;

export const updateOrganizationUserSchema = z
  .object({
    state: z.enum(["ACTIVE", "INACTIVE"]),
    organizationRole: organizationRoleSchema,
    version: z.number().int().positive(),
  })
  .strict();
export type UpdateOrganizationUserInput = z.infer<
  typeof updateOrganizationUserSchema
>;

export const inviteOrganizationUserSchema = z
  .object({
    email: z.string().trim().email().max(254),
    displayName: z.string().trim().min(1).max(100),
    organizationRole: organizationRoleSchema.default("MEMBER"),
  })
  .strict();
export type InviteOrganizationUserInput = z.infer<
  typeof inviteOrganizationUserSchema
>;

export const acceptInvitationSchema = z
  .object({
    token: z.string().min(32).max(256),
    password: z.string().min(12).max(256),
  })
  .strict();

export const updateAdminProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    boardName: z.string().trim().min(1).max(100),
    archived: z.boolean(),
    version: z.number().int().positive(),
    boardVersion: z.number().int().positive(),
  })
  .strict();
export type UpdateAdminProjectInput = z.infer<typeof updateAdminProjectSchema>;

export interface AdministrationUserView {
  id: string;
  email: string;
  displayName: string;
  state: "INVITED" | "ACTIVE" | "INACTIVE";
  organizationRole: OrganizationRole;
  version: number;
  activeAssignments: number;
}

export interface AdministrationProjectView {
  id: string;
  key: string;
  name: string;
  board: { id: string; name: string; version: number };
  version: number;
  archived: boolean;
  issueCount: number;
  memberCount: number;
}

export interface AdministrationSettingsView {
  organization: { id: string; name: string; version: number };
  users: AdministrationUserView[];
  projects: AdministrationProjectView[];
}

export interface InvitationResult {
  settings: AdministrationSettingsView;
  activationUrl: string;
  expiresAt: string;
}

export const createTeamSchema = z
  .object({ name: z.string().trim().min(1).max(100) })
  .strict();

export const updateTeamSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    memberIds: z.array(z.uuid()).max(500),
    version: z.number().int().positive(),
  })
  .strict();

export const updateProjectTeamSchema = z
  .object({ role: projectRoleSchema })
  .strict();

export interface TeamView {
  id: string;
  name: string;
  version: number;
  members: Array<{ id: string; displayName: string; email: string }>;
}

export interface AdministrationTeamsView {
  users: Array<{ id: string; displayName: string; email: string }>;
  teams: TeamView[];
}

export interface ProjectTeamView {
  id: string;
  name: string;
  memberCount: number;
  projectRole: ProjectRole | null;
}

export interface ProjectTeamsView {
  project: ProjectSummary;
  teams: ProjectTeamView[];
}

export const csvImportPolicySchema = z.enum(["ATOMIC", "SKIP_INVALID"]);
export type CsvImportPolicy = z.infer<typeof csvImportPolicySchema>;

export const csvDryRunSchema = z
  .object({ csv: z.string().min(1).max(1_000_000) })
  .strict();

export const createCsvImportJobSchema = csvDryRunSchema
  .extend({ invalidRowPolicy: csvImportPolicySchema })
  .strict();

export interface CsvValidationError {
  row: number;
  field: string;
  message: string;
}

export interface CsvValidationReport {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  errors: CsvValidationError[];
}

export interface DataJobView {
  id: string;
  jobType: "CSV_IMPORT" | "CSV_EXPORT";
  state: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  attempts: number;
  result: Record<string, unknown>;
  errorMessage: string | null;
  canDownload: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface DataJobsView {
  project: ProjectSummary;
  jobs: DataJobView[];
}

export const reportsQuerySchema = z
  .object({
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.from && value.to && value.from > value.to) {
      context.addIssue({
        code: "custom",
        message: "The end date must be on or after the start date",
        path: ["to"],
      });
    }
  });
export type ReportsQuery = z.infer<typeof reportsQuerySchema>;

export interface KanbanReportsView {
  project: ProjectSummary;
  period: { from: string; to: string; timezone: "UTC" };
  summary: {
    throughput: number;
    averageLeadTimeSeconds: number | null;
    averageCycleTimeSeconds: number | null;
    activeWip: number;
    averageWipAgeSeconds: number | null;
  };
  throughput: Array<{ date: string; count: number }>;
  createdResolved: Array<{ date: string; created: number; resolved: number }>;
  cumulativeFlow: Array<{
    date: string;
    todo: number;
    inProgress: number;
    done: number;
  }>;
  statusTime: Array<{
    category: StatusCategory;
    averageSeconds: number;
  }>;
  agingWip: Array<{
    issueId: string;
    issueKey: string;
    summary: string;
    ageSeconds: number;
  }>;
}

export const createCommentSchema = z
  .object({ body: z.string().trim().min(1).max(10_000) })
  .strict();

export const notificationEventClassSchema = z.enum([
  "MENTION",
  "ISSUE_COMMENTED",
]);
export type NotificationEventClass = z.infer<
  typeof notificationEventClassSchema
>;

export const notificationPreferencesSchema = z
  .object({ mentions: z.boolean(), issueComments: z.boolean() })
  .strict();
export type NotificationPreferences = z.infer<
  typeof notificationPreferencesSchema
>;

export interface NotificationView {
  id: string;
  eventClass: NotificationEventClass;
  actor: { id: string; displayName: string };
  issue: {
    id: string;
    key: string;
    summary: string;
    projectKey: string;
    boardId: string;
  };
  commentId: string;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationCenterView extends Page<NotificationView> {
  unreadCount: number;
  preferences: NotificationPreferences;
}

export interface CommentView {
  id: string;
  body: string;
  author: { id: string; displayName: string };
  mentions: Array<{ id: string; displayName: string; email: string }>;
  createdAt: string;
}

export interface IssueCollaborationView {
  comments: CommentView[];
  isWatching: boolean;
  watcherCount: number;
}

export const attachmentScanStateSchema = z.enum([
  "PENDING",
  "CLEAN",
  "REJECTED",
  "ERROR",
]);
export type AttachmentScanState = z.infer<typeof attachmentScanStateSchema>;

export interface AttachmentView {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  scanState: AttachmentScanState;
  uploader: { id: string; displayName: string };
  createdAt: string;
  downloadUrl: string | null;
  canDelete: boolean;
}

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
  organizationRole: OrganizationRole;
}

export interface ProjectMemberView {
  id: string;
  email: string;
  displayName: string;
  state: "ACTIVE" | "INACTIVE";
  organizationRole: OrganizationRole;
  projectRole: ProjectRole | null;
}

export interface ProjectMembersView {
  project: ProjectSummary;
  members: ProjectMemberView[];
}

export interface ProjectSummary {
  id: string;
  key: string;
  name: string;
  boardId: string;
}

export interface DeletedIssueView {
  id: string;
  key: string;
  summary: string;
  issueType: IssueType;
  version: number;
  deletedAt: string;
  deletedBy: { id: string; displayName: string } | null;
}

export interface DeletedIssuesView {
  project: ProjectSummary;
  issues: DeletedIssueView[];
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
  issueType: IssueType;
  statusId: string;
  rank: string;
  version: number;
  reporter: { id: string; displayName: string };
  assignee: { id: string; displayName: string } | null;
  labels: string[];
  estimatePoints: number | null;
  dueDate: string | null;
  parent: {
    id: string;
    key: string;
    summary: string;
    issueType: IssueType;
  } | null;
  epic: { id: string; key: string; summary: string } | null;
  updatedAt: string;
  allowedTransitions: TransitionView[];
}

export interface IssueSearchItem {
  id: string;
  key: string;
  summary: string;
  description: string;
  priority: Priority;
  issueType: IssueType;
  project: ProjectSummary;
  status: StatusView;
  reporter: { id: string; displayName: string };
  assignee: { id: string; displayName: string } | null;
  labels: string[];
  parent: { id: string; key: string; summary: string } | null;
  rank: string;
  createdAt: string;
  updatedAt: string;
  relevance: number;
}

export interface IssueSearchFacets {
  projects: ProjectSummary[];
  statuses: Array<StatusView & { projectId: string; projectKey: string }>;
  users: Array<{ id: string; displayName: string; email: string }>;
}

export interface IssueSearchPage extends Page<IssueSearchItem> {
  facets: IssueSearchFacets;
}

export interface BoardColumnView {
  id: string;
  name: string;
  position: number;
  wipLimit: number | null;
  version: number;
  statusIds: string[];
  issueCount: number;
  tailIssueId: string | null;
  penultimateIssueId: string | null;
}

export interface BoardSettingsView {
  project: ProjectSummary;
  board: { id: string; name: string };
  columns: BoardColumnView[];
}

export interface WorkflowStatusView extends StatusView {
  columnId: string;
  issueCount: number;
}

export interface WorkflowSettingsView {
  project: ProjectSummary;
  board: { id: string; name: string };
  workflow: { id: string; name: string; version: number };
  columns: Array<{
    id: string;
    name: string;
    position: number;
    version: number;
  }>;
  statuses: WorkflowStatusView[];
  transitions: TransitionView[];
}

export const boardChangeEventSchema = z
  .object({
    projectId: z.uuid(),
    entity: z.enum(["issue", "board_column"]),
    entityId: z.uuid(),
    version: z.number().int().positive(),
    operation: z.enum(["INSERT", "UPDATE", "DELETE"]),
  })
  .strict();
export type BoardChangeEvent = z.infer<typeof boardChangeEventSchema>;

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
  epics: Array<{ id: string; key: string; summary: string }>;
  issues: IssueView[];
  issueNeighbors: Record<
    string,
    { previousIssueId: string | null; nextIssueId: string | null }
  >;
  columnPages: Array<{
    columnId: string;
    total: number;
    nextCursor: string | null;
  }>;
}

export interface BoardIssuePage extends Page<IssueView> {
  columnId: string;
  total: number;
  issueNeighbors: BoardView["issueNeighbors"];
}

export interface IssueEventView {
  id: string;
  eventType:
    | "CREATED"
    | "TRANSITIONED"
    | "REORDERED"
    | "UPDATED"
    | "DELETED"
    | "RESTORED"
    | "COMMENTED"
    | "ATTACHMENT_ADDED"
    | "ATTACHMENT_REMOVED";
  actorName: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface IssueDetailView extends IssueView {
  events: IssueEventView[];
}
