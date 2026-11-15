import { pathToFileURL } from "node:url";
import { factoryRequest, type FactoryService } from "./software-factory-api";

type JsonRecord = Record<string, unknown>;
type JiraPriority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
type JiraIssueType = "EPIC" | "STORY" | "TASK" | "BUG" | "SUBTASK";

export interface OpenRmRequirement {
  id: string;
  projectId: string;
  key: string;
  title: string;
  statement: string;
  attributes: JsonRecord;
  revision: number;
  updatedAt: string;
}

export interface JiraIssue {
  key: string;
  summary: string;
  description: string;
  priority: JiraPriority;
  issueType: JiraIssueType;
  assigneeId: string | null;
  labels: string[];
  parentIssueKey: string | null;
  estimatePoints: number | null;
  dueDate: string | null;
  version: number;
}

interface JiraIssueInput {
  summary: string;
  description: string;
  priority: JiraPriority;
  issueType: JiraIssueType;
  assigneeId: string | null;
  labels: string[];
  parentIssueKey: string | null;
  estimatePoints: number | null;
  dueDate: string | null;
  version?: number;
}

export interface RequirementSyncPlan {
  action: "create" | "update" | "noop";
  requirement: {
    id: string;
    key: string;
    revision: number;
  };
  issueKey: string | null;
  changedFields: string[];
  input: JiraIssueInput | null;
}

interface SyncOptions {
  openrmProjectId: string;
  requirement: string;
  jiraProjectKey: string;
  apply: boolean;
}

interface BatchSyncOptions {
  openrmProjectId: string;
  jiraProjectKey: string;
  maxRequirements: number;
  apply: boolean;
}

type CommandOptions =
  | ({ scope: "requirement" } & SyncOptions)
  | ({ scope: "all" } & BatchSyncOptions);

interface Correlation {
  service: FactoryService;
  operation: string;
  id: string;
}

const startMarker = "<!-- openrm-sync:start -->";
const endMarker = "<!-- openrm-sync:end -->";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown, name: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return value as JsonRecord;
}

function stringField(value: JsonRecord, name: string): string {
  const field = value[name];
  if (typeof field !== "string") throw new Error(`${name} must be a string`);
  return field;
}

function integerField(value: JsonRecord, name: string): number {
  const field = value[name];
  if (!Number.isInteger(field)) throw new Error(`${name} must be an integer`);
  return field as number;
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string")
    throw new Error(`${name} must be a string or null`);
  return value;
}

function parseRequirement(value: unknown): OpenRmRequirement {
  const item = record(value, "OpenRM requirement");
  return {
    id: stringField(item, "id"),
    projectId: stringField(item, "project_id"),
    key: stringField(item, "key"),
    title: stringField(item, "title"),
    statement: stringField(item, "statement"),
    attributes: record(item.attributes, "attributes"),
    revision: integerField(item, "revision"),
    updatedAt: stringField(item, "updated_at"),
  };
}

function parseIssue(value: unknown): JiraIssue {
  const item = record(value, "Jira issue");
  const labels = item.labels;
  if (
    !Array.isArray(labels) ||
    labels.some((label) => typeof label !== "string")
  ) {
    throw new Error("labels must be an array of strings");
  }
  const priority = stringField(item, "priority");
  if (!["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(priority)) {
    throw new Error(`Unsupported Jira priority: ${priority}`);
  }
  const issueType = stringField(item, "issueType");
  if (!["EPIC", "STORY", "TASK", "BUG", "SUBTASK"].includes(issueType)) {
    throw new Error(`Unsupported Jira issue type: ${issueType}`);
  }
  const assignee =
    item.assignee === null ? null : record(item.assignee, "assignee");
  const parent = item.parent === null ? null : record(item.parent, "parent");
  const estimatePoints = item.estimatePoints;
  if (estimatePoints !== null && !Number.isInteger(estimatePoints)) {
    throw new Error("estimatePoints must be an integer or null");
  }
  return {
    key: stringField(item, "key"),
    summary: stringField(item, "summary"),
    description: stringField(item, "description"),
    priority: priority as JiraPriority,
    issueType: issueType as JiraIssueType,
    assigneeId: assignee ? stringField(assignee, "id") : null,
    labels: labels as string[],
    parentIssueKey: parent ? stringField(parent, "key") : null,
    estimatePoints: estimatePoints as number | null,
    dueDate: nullableString(item.dueDate, "dueDate"),
    version: integerField(item, "version"),
  };
}

export function jiraPriority(requirement: OpenRmRequirement): JiraPriority {
  const value = requirement.attributes.priority;
  if (typeof value !== "string") return "MEDIUM";
  const normalized = value.trim().toUpperCase();
  return ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(normalized)
    ? (normalized as JiraPriority)
    : "MEDIUM";
}

function safeManagedText(value: string): string {
  return value
    .replaceAll(startMarker, "[openrm-sync start marker removed]")
    .replaceAll(endMarker, "[openrm-sync end marker removed]");
}

export function requirementSummary(requirement: OpenRmRequirement): string {
  const summary = `[${requirement.key}] ${requirement.title}`.trim();
  return summary.length <= 200 ? summary : `${summary.slice(0, 199)}…`;
}

export function managedRequirementBlock(
  requirement: OpenRmRequirement,
): string {
  return [
    startMarker,
    `OpenRM requirement: ${requirement.key}`,
    `OpenRM requirement ID: ${requirement.id}`,
    `OpenRM project ID: ${requirement.projectId}`,
    `OpenRM revision: ${requirement.revision}`,
    `OpenRM updated: ${requirement.updatedAt}`,
    "",
    safeManagedText(requirement.title),
    "",
    safeManagedText(requirement.statement),
    endMarker,
  ].join("\n");
}

export function mergeManagedDescription(
  existing: string,
  managedBlock: string,
): string {
  const start = existing.indexOf(startMarker);
  const end = existing.indexOf(endMarker);
  if (start >= 0 !== end >= 0 || (start >= 0 && end < start)) {
    throw new Error("The Jira issue has a malformed OpenRM managed block");
  }
  const merged =
    start >= 0
      ? `${existing.slice(0, start)}${managedBlock}${existing.slice(end + endMarker.length)}`
      : existing.trim()
        ? `${managedBlock}\n\n${existing.trim()}`
        : managedBlock;
  if (merged.length > 20_000) {
    throw new Error(
      "The synchronized Jira description would exceed 20,000 characters",
    );
  }
  return merged;
}

function normalizedLabels(labels: string[]): string[] {
  return labels
    .map((label) => label.replace(/\s+/g, " ").trim().toLowerCase())
    .sort();
}

export function mergeManagedLabels(
  labels: string[],
  requirement: OpenRmRequirement,
): string[] {
  const managedRevision = /^openrm-rev-[1-9][0-9]*$/i;
  const retained = labels.filter(
    (label) =>
      label.toLowerCase() !== "openrm" &&
      label.toLowerCase() !== requirement.key.toLowerCase() &&
      !managedRevision.test(label),
  );
  const merged = [
    ...retained,
    "openrm",
    requirement.key,
    `openrm-rev-${requirement.revision}`,
  ];
  if (merged.length > 20) {
    throw new Error("The synchronized Jira issue would exceed 20 labels");
  }
  return merged;
}

export function planRequirementSync(
  requirement: OpenRmRequirement,
  issue: JiraIssue | null,
): RequirementSyncPlan {
  const description = mergeManagedDescription(
    issue?.description ?? "",
    managedRequirementBlock(requirement),
  );
  const input: JiraIssueInput = {
    summary: requirementSummary(requirement),
    description,
    priority: jiraPriority(requirement),
    issueType: "TASK",
    assigneeId: issue?.assigneeId ?? null,
    labels: mergeManagedLabels(issue?.labels ?? [], requirement),
    parentIssueKey: issue?.parentIssueKey ?? null,
    estimatePoints: issue?.estimatePoints ?? null,
    dueDate: issue?.dueDate ?? null,
    ...(issue ? { version: issue.version } : {}),
  };
  if (!issue) {
    return {
      action: "create",
      requirement: {
        id: requirement.id,
        key: requirement.key,
        revision: requirement.revision,
      },
      issueKey: null,
      changedFields: [
        "summary",
        "description",
        "priority",
        "issueType",
        "labels",
      ],
      input,
    };
  }
  const changedFields = [
    issue.summary === input.summary ? null : "summary",
    issue.description === input.description ? null : "description",
    issue.priority === input.priority ? null : "priority",
    issue.issueType === input.issueType ? null : "issueType",
    normalizedLabels(issue.labels).join("\0") ===
    normalizedLabels(input.labels).join("\0")
      ? null
      : "labels",
  ].filter((field): field is string => field !== null);
  return {
    action: changedFields.length > 0 ? "update" : "noop",
    requirement: {
      id: requirement.id,
      key: requirement.key,
      revision: requirement.revision,
    },
    issueKey: issue.key,
    changedFields,
    input: changedFields.length > 0 ? input : null,
  };
}

export function summarizeSyncPlans(plans: RequirementSyncPlan[]): {
  total: number;
  create: number;
  update: number;
  noop: number;
} {
  return {
    total: plans.length,
    create: plans.filter((plan) => plan.action === "create").length,
    update: plans.filter((plan) => plan.action === "update").length,
    noop: plans.filter((plan) => plan.action === "noop").length,
  };
}

async function apiJson(
  service: FactoryService,
  method: string,
  path: string,
  operation: string,
  correlations: Correlation[],
  data?: unknown,
  idempotencyKey?: string,
): Promise<unknown> {
  const response = await factoryRequest({
    service,
    method,
    path,
    ...(data === undefined ? {} : { data }),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
  correlations.push({ service, operation, id: response.correlationId });
  if (!response.ok) {
    throw new Error(
      `${service} ${operation} failed with HTTP ${response.status}: ${JSON.stringify(response.body)}`,
    );
  }
  return response.body;
}

async function loadRequirement(
  options: SyncOptions,
  correlations: Correlation[],
): Promise<OpenRmRequirement> {
  let requirementId = options.requirement;
  if (!uuidPattern.test(requirementId)) {
    const query = new URLSearchParams({
      search: options.requirement,
      limit: "100",
      offset: "0",
    });
    const result = record(
      await apiJson(
        "openrm",
        "GET",
        `/api/v1/projects/${options.openrmProjectId}/requirements?${query}`,
        "requirement.search",
        correlations,
      ),
      "OpenRM requirement search",
    );
    if (!Array.isArray(result.items))
      throw new Error("OpenRM search items must be an array");
    const matches = result.items
      .map(parseRequirement)
      .filter(
        (item) => item.key.toLowerCase() === options.requirement.toLowerCase(),
      );
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `OpenRM requirement ${options.requirement} was not found`
          : `OpenRM requirement key ${options.requirement} is ambiguous`,
      );
    }
    requirementId = matches[0]!.id;
  }
  return parseRequirement(
    await apiJson(
      "openrm",
      "GET",
      `/api/v1/projects/${options.openrmProjectId}/requirements/${requirementId}`,
      "requirement.read",
      correlations,
    ),
  );
}

async function loadProjectRequirements(
  options: BatchSyncOptions,
  correlations: Correlation[],
): Promise<OpenRmRequirement[]> {
  const requirements: OpenRmRequirement[] = [];
  let total: number | null = null;
  while (total === null || requirements.length < total) {
    const query = new URLSearchParams({
      limit: "100",
      offset: String(requirements.length),
    });
    const page = record(
      await apiJson(
        "openrm",
        "GET",
        `/api/v1/projects/${options.openrmProjectId}/requirements?${query}`,
        "requirement.list",
        correlations,
      ),
      "OpenRM requirement page",
    );
    if (!Array.isArray(page.items)) {
      throw new Error("OpenRM requirement page items must be an array");
    }
    const pageTotal = integerField(page, "total");
    if (total !== null && total !== pageTotal) {
      throw new Error(
        "OpenRM requirement count changed during batch preflight",
      );
    }
    total = pageTotal;
    if (total > options.maxRequirements) {
      throw new Error(
        `OpenRM project contains ${total} requirements, exceeding --max ${options.maxRequirements}`,
      );
    }
    if (page.items.length === 0 && requirements.length < total) {
      throw new Error(
        "OpenRM requirement pagination ended before the reported total",
      );
    }
    requirements.push(...page.items.map(parseRequirement));
  }
  const keys = new Set<string>();
  for (const requirement of requirements) {
    if (requirement.projectId !== options.openrmProjectId) {
      throw new Error("OpenRM returned a requirement from a different project");
    }
    const key = requirement.key.toLowerCase();
    if (keys.has(key)) {
      throw new Error(
        `OpenRM returned duplicate requirement key ${requirement.key}`,
      );
    }
    keys.add(key);
  }
  return requirements.sort((left, right) =>
    left.key.localeCompare(right.key, "en", { numeric: true }),
  );
}

async function loadJiraIssue(
  jiraProjectKey: string,
  requirementKey: string,
  correlations: Correlation[],
): Promise<JiraIssue | null> {
  const query = new URLSearchParams({
    projects: jiraProjectKey,
    labels: requirementKey,
    limit: "10",
  });
  const search = record(
    await apiJson(
      "jira",
      "GET",
      `/api/v1/search/issues?${query}`,
      "issue.search",
      correlations,
    ),
    "Jira issue search",
  );
  if (!Array.isArray(search.items))
    throw new Error("Jira search items must be an array");
  const keys = search.items.map((item) =>
    stringField(record(item, "Jira search item"), "key"),
  );
  if (keys.length > 1) {
    throw new Error(
      `Multiple Jira issues have requirement label ${requirementKey}: ${keys.join(", ")}`,
    );
  }
  const key = keys[0];
  if (!key) return null;
  return parseIssue(
    await apiJson(
      "jira",
      "GET",
      `/api/v1/issues/${key}`,
      "issue.read",
      correlations,
    ),
  );
}

function creationIdempotencyKey(requirement: OpenRmRequirement): string {
  return `agent:openrm:${requirement.projectId}:${requirement.id}:jira:create`;
}

async function applyPlan(
  jiraProjectKey: string,
  requirement: OpenRmRequirement,
  plan: RequirementSyncPlan,
  correlations: Correlation[],
): Promise<unknown> {
  if (plan.action === "create" && plan.input) {
    return apiJson(
      "jira",
      "POST",
      `/api/v1/projects/${jiraProjectKey}/issues`,
      "issue.create",
      correlations,
      plan.input,
      creationIdempotencyKey(requirement),
    );
  }
  if (plan.action === "update" && plan.input && plan.issueKey) {
    return apiJson(
      "jira",
      "PATCH",
      `/api/v1/issues/${plan.issueKey}`,
      "issue.update",
      correlations,
      plan.input,
    );
  }
  return null;
}

function mutationSummary(value: unknown): JsonRecord | null {
  if (value === null) return null;
  const issue = record(value, "Jira mutation response");
  return {
    id: stringField(issue, "id"),
    key: stringField(issue, "key"),
    version: integerField(issue, "version"),
  };
}

export async function synchronizeRequirement(
  options: SyncOptions,
): Promise<unknown> {
  const correlations: Correlation[] = [];
  const requirement = await loadRequirement(options, correlations);
  if (requirement.projectId !== options.openrmProjectId) {
    throw new Error("OpenRM returned a requirement from a different project");
  }
  const issue = await loadJiraIssue(
    options.jiraProjectKey,
    requirement.key,
    correlations,
  );
  const plan = planRequirementSync(requirement, issue);
  const result = options.apply
    ? await applyPlan(options.jiraProjectKey, requirement, plan, correlations)
    : null;
  return {
    mode: options.apply ? "apply" : "dry-run",
    plan,
    applied: options.apply && plan.action !== "noop",
    result,
    correlations,
  };
}

export async function synchronizeProjectRequirements(
  options: BatchSyncOptions,
): Promise<unknown> {
  const correlations: Correlation[] = [];
  const requirements = await loadProjectRequirements(options, correlations);
  const preflight: Array<{
    requirement: OpenRmRequirement;
    plan: RequirementSyncPlan;
  }> = [];
  for (const requirement of requirements) {
    const issue = await loadJiraIssue(
      options.jiraProjectKey,
      requirement.key,
      correlations,
    );
    preflight.push({
      requirement,
      plan: planRequirementSync(requirement, issue),
    });
  }
  const results: Array<{
    requirementKey: string;
    action: RequirementSyncPlan["action"];
    issue: JsonRecord | null;
  }> = [];
  if (options.apply) {
    for (const item of preflight) {
      const result = await applyPlan(
        options.jiraProjectKey,
        item.requirement,
        item.plan,
        correlations,
      );
      results.push({
        requirementKey: item.requirement.key,
        action: item.plan.action,
        issue: mutationSummary(result),
      });
    }
  }
  return {
    mode: options.apply ? "apply" : "dry-run",
    preflightComplete: true,
    summary: summarizeSyncPlans(preflight.map((item) => item.plan)),
    plans: preflight.map((item) => item.plan),
    applied: options.apply,
    results,
    correlations,
  };
}

const usageText = `Usage:
  npm run factory:sync -- --openrm-project UUID --requirement KEY_OR_UUID --jira-project KEY [--apply]
  npm run factory:sync -- --openrm-project UUID --all --jira-project KEY [--max 100] [--apply]

The command is dry-run by default. --apply creates or updates mapped Jira issues.
Project-wide sync completes a read-only preflight before its first write.`;

export function parseSyncOptions(values: string[]): CommandOptions {
  const options = new Map<string, string>();
  const flags = new Set<string>();
  let apply = false;
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    if (option === "--apply") {
      if (apply) throw new Error("Duplicate option: --apply");
      apply = true;
      continue;
    }
    if (option === "--all") {
      if (flags.has(option)) throw new Error("Duplicate option: --all");
      flags.add(option);
      continue;
    }
    const value = values[index + 1];
    if (!option?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(usageText);
    }
    if (options.has(option)) throw new Error(`Duplicate option: ${option}`);
    options.set(option, value);
    index += 1;
  }
  const openrmProjectId = options.get("--openrm-project")?.trim();
  const requirement = options.get("--requirement")?.trim();
  const jiraProjectKey = options.get("--jira-project")?.trim().toUpperCase();
  const all = flags.has("--all");
  if (
    !openrmProjectId ||
    !uuidPattern.test(openrmProjectId) ||
    Boolean(requirement) === all ||
    !jiraProjectKey ||
    !/^[A-Z][A-Z0-9]{1,9}$/.test(jiraProjectKey)
  ) {
    throw new Error(usageText);
  }
  for (const option of options.keys()) {
    if (
      ![
        "--openrm-project",
        "--requirement",
        "--jira-project",
        "--max",
      ].includes(option)
    ) {
      throw new Error(`Unknown option: ${option}`);
    }
  }
  if (all) {
    const maxRequirements = Number(options.get("--max") ?? "100");
    if (
      !Number.isInteger(maxRequirements) ||
      maxRequirements < 1 ||
      maxRequirements > 1_000
    ) {
      throw new Error("--max must be an integer between 1 and 1000");
    }
    return {
      scope: "all",
      openrmProjectId,
      jiraProjectKey,
      maxRequirements,
      apply,
    };
  }
  if (options.has("--max")) {
    throw new Error("--max can be used only with --all");
  }
  return {
    scope: "requirement",
    openrmProjectId,
    requirement: requirement!,
    jiraProjectKey,
    apply,
  };
}

async function main(): Promise<void> {
  if (process.argv[2] === "--help" || process.argv[2] === "-h") {
    process.stdout.write(`${usageText}\n`);
    return;
  }
  const options = parseSyncOptions(process.argv.slice(2));
  const result =
    options.scope === "all"
      ? await synchronizeProjectRequirements(options)
      : await synchronizeRequirement(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
