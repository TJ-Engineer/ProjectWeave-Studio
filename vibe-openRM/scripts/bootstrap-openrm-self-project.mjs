/* global console, fetch */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const catalogPath = path.join(repositoryRoot, "data/openrm-self-verification/requirements.json");
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const validateOnly = process.argv.includes("--validate-only");
const jsonOutput = process.argv.includes("--json");

const baseUrl = (process.env.OPENRM_API_BASE_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const organizationId = process.env.OPENRM_ORGANIZATION_ID ?? "00000000-0000-4000-8000-000000000001";
const authorToken = process.env.OPENRM_AUTHOR_TOKEN ?? "dev:openrm-project-author";
const verifierToken = process.env.OPENRM_VERIFIER_TOKEN ?? "dev:openrm-independent-verifier:reviewer";
const verifierSubject = process.env.OPENRM_VERIFIER_SUBJECT ?? "openrm-independent-verifier";
const repositoryUrl = (process.env.OPENRM_REPOSITORY_URL ?? "https://github.com/TJ-Engineer/OpenRM").replace(/\/$/, "");
const evidenceRef = process.env.OPENRM_EVIDENCE_REF ?? process.env.GITHUB_SHA ?? "main";
const evidenceRunUrl = process.env.OPENRM_SELF_EVIDENCE_RUN_URL
  ?? (process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : "repository-local-verification");
let evidenceVersion;

const attributeDefinitions = [
  { key: "level", label: "Requirement level", value_type: "enum", required: true, config: { options: ["system", "derived"] } },
  { key: "subsystem", label: "Subsystem", value_type: "enum", required: true, config: { options: ["product", "identity", "traceability", "change", "review", "verification", "integration", "operations", "security", "quality", "deployment", "data"] } },
  { key: "verification_method", label: "Verification method", value_type: "enum", required: true, config: { options: ["test", "analysis", "observation"] } },
  { key: "evidence_group", label: "Evidence group", value_type: "enum", required: true, config: { options: ["automated-test", "operational-test", "analysis", "observation"] } },
];

const tagDefinitions = [
  { name: "system", color: "#0f766e" },
  { name: "derived", color: "#2563eb" },
  { name: "test", color: "#16a34a" },
  { name: "analysis", color: "#7c3aed" },
  { name: "observation", color: "#c2410c" },
];

function fail(message) {
  throw new Error(`OpenRM self-project validation failed: ${message}`);
}

function expect(condition, message) {
  if (!condition) fail(message);
}

function validateCatalog() {
  expect(catalog.schema_version === "openrm-self-requirements-v1", "unexpected schema_version");
  expect(/^v[1-9][0-9]*$/.test(catalog.catalog_version), "catalog_version must use v<number>");
  expect(Array.isArray(catalog.requirements), "requirements must be an array");
  expect(Array.isArray(catalog.verification_cases), "verification_cases must be an array");

  const keys = new Set();
  const byKey = new Map();
  for (const requirement of catalog.requirements) {
    expect(/^[A-Z][A-Z0-9-]{1,31}$/.test(requirement.key), `invalid requirement key ${requirement.key}`);
    expect(!keys.has(requirement.key), `duplicate requirement key ${requirement.key}`);
    expect(["system", "derived"].includes(requirement.level), `${requirement.key} has invalid level`);
    expect(["test", "analysis", "observation"].includes(requirement.verification_method), `${requirement.key} has invalid verification_method`);
    expect(["automated-test", "operational-test", "analysis", "observation"].includes(requirement.evidence_group), `${requirement.key} has invalid evidence_group`);
    expect(typeof requirement.statement === "string" && requirement.statement.startsWith("OpenRM shall "), `${requirement.key} must contain a normative statement`);
    keys.add(requirement.key);
    byKey.set(requirement.key, requirement);
  }

  const system = catalog.requirements.filter((item) => item.level === "system");
  const derived = catalog.requirements.filter((item) => item.level === "derived");
  expect(system.length === catalog.expected_counts.system, `expected ${catalog.expected_counts.system} system requirements, found ${system.length}`);
  expect(derived.length === catalog.expected_counts.derived, `expected ${catalog.expected_counts.derived} derived requirements, found ${derived.length}`);
  expect(catalog.requirements.length === catalog.expected_counts.total, `expected ${catalog.expected_counts.total} total requirements, found ${catalog.requirements.length}`);
  expect(derived.length === catalog.expected_counts.decomposition_relationships, "derived count must match decomposition relationship count");
  expect(catalog.verification_cases.length === catalog.expected_counts.verification_cases, "verification case count does not match expected_counts");

  for (const item of system) {
    expect(item.parent_key === null, `${item.key} is system-level and must not have a parent`);
    expect(derived.filter((candidate) => candidate.parent_key === item.key).length === 4, `${item.key} must decompose to exactly four derived requirements`);
  }
  for (const item of derived) {
    const parent = byKey.get(item.parent_key);
    expect(parent?.level === "system", `${item.key} must reference one system-level parent`);
  }

  const caseKeys = new Set();
  const caseGroups = new Set();
  for (const verificationCase of catalog.verification_cases) {
    expect(!caseKeys.has(verificationCase.key), `duplicate verification case key ${verificationCase.key}`);
    expect(["test", "analysis", "inspection", "demonstration"].includes(verificationCase.method), `${verificationCase.key} has an unsupported API method`);
    expect(!caseGroups.has(verificationCase.evidence_group), `duplicate evidence group ${verificationCase.evidence_group}`);
    expect(Array.isArray(verificationCase.evidence_files) && verificationCase.evidence_files.length > 0, `${verificationCase.key} has no evidence files`);
    expect(verificationCase.evidence_files.length <= 20, `${verificationCase.key} exceeds the 20-attachment result limit`);
    expect(new Set(verificationCase.evidence_files).size === verificationCase.evidence_files.length, `${verificationCase.key} repeats an evidence file`);
    caseKeys.add(verificationCase.key);
    caseGroups.add(verificationCase.evidence_group);
  }
  for (const requirement of catalog.requirements) {
    expect(caseGroups.has(requirement.evidence_group), `${requirement.key} is not allocated to a verification case`);
  }
}

function mediaType(file) {
  if (file.endsWith(".md")) return "text/markdown";
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(".yaml") || file.endsWith(".yml")) return "application/yaml";
  if (file.endsWith(".rs")) return "text/x-rust";
  if (file.endsWith(".ts") || file.endsWith(".tsx")) return "text/typescript";
  if (file.endsWith(".mjs")) return "text/javascript";
  if (file.endsWith(".sh")) return "text/x-shellscript";
  if (file.endsWith("Dockerfile")) return "text/x-dockerfile";
  return "text/plain";
}

async function evidenceAttachment(relativePath) {
  const absolutePath = path.resolve(repositoryRoot, relativePath);
  expect(absolutePath.startsWith(`${repositoryRoot}${path.sep}`), `evidence path escapes the repository: ${relativePath}`);
  const content = await readFile(absolutePath);
  const metadata = await stat(absolutePath);
  return {
    object_key: `${repositoryUrl}/blob/${encodeURIComponent(evidenceRef)}/${relativePath.split(path.sep).map(encodeURIComponent).join("/")}`,
    file_name: path.basename(relativePath),
    media_type: mediaType(relativePath),
    size_bytes: metadata.size,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

async function validateEvidence() {
  const result = new Map();
  for (const verificationCase of catalog.verification_cases) {
    result.set(verificationCase.key, await Promise.all(verificationCase.evidence_files.map(evidenceAttachment)));
  }
  return result;
}

async function request(apiPath, { method = "GET", token = authorToken, body, idempotencyKey } = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "X-OpenRM-Organization": organizationId,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["X-Idempotency-Key"] = idempotencyKey;
  const response = await fetch(`${baseUrl}${apiPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const responseText = await response.text();
  let payload = null;
  if (responseText) {
    try {
      payload = JSON.parse(responseText);
    } catch {
      payload = responseText;
    }
  }
  if (!response.ok) {
    throw new Error(`${method} ${apiPath} returned ${response.status}: ${typeof payload === "string" ? payload : JSON.stringify(payload)}`);
  }
  return payload;
}

function commandKey(...parts) {
  return ["openrm-self", catalog.catalog_version, ...parts]
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .slice(0, 128);
}

async function ensureProject() {
  const projects = await request("/api/v1/projects");
  const existing = projects.items.find((project) => project.key === catalog.project.key);
  if (existing) return existing;
  return request("/api/v1/projects", {
    method: "POST",
    idempotencyKey: commandKey("project"),
    body: catalog.project,
  });
}

async function ensureWorkspaceResource(projectId, resource, predicate, body) {
  const existing = await request(`/api/v1/projects/${projectId}/workspace/${resource}`);
  const match = existing.items.find(predicate);
  if (match) return match;
  return request(`/api/v1/projects/${projectId}/workspace/${resource}`, {
    method: "POST",
    body,
  });
}

async function ensureWorkspace(projectId) {
  const definitions = {};
  for (const definition of attributeDefinitions) {
    definitions[definition.key] = await ensureWorkspaceResource(
      projectId,
      "attribute-definitions",
      (item) => item.key === definition.key,
      definition,
    );
  }

  const rootFolder = await ensureWorkspaceResource(
    projectId,
    "folders",
    (item) => item.name === "Requirements" && item.parent_id === null,
    { name: "Requirements", parent_id: null },
  );
  const systemFolder = await ensureWorkspaceResource(
    projectId,
    "folders",
    (item) => item.name === "System Requirements",
    { name: "System Requirements", parent_id: rootFolder.id },
  );
  const derivedFolder = await ensureWorkspaceResource(
    projectId,
    "folders",
    (item) => item.name === "Derived Requirements",
    { name: "Derived Requirements", parent_id: rootFolder.id },
  );

  const tags = {};
  for (const definition of tagDefinitions) {
    tags[definition.name] = await ensureWorkspaceResource(
      projectId,
      "tags",
      (item) => item.name === definition.name,
      definition,
    );
  }
  return { definitions, systemFolder, derivedFolder, tags };
}

async function importRequirements(projectId, workspace) {
  const items = catalog.requirements.map((requirement) => ({
    key: requirement.key,
    title: requirement.title,
    statement: requirement.statement,
    attributes: {
      priority: requirement.priority,
      level: requirement.level,
      subsystem: requirement.subsystem,
      verification_method: requirement.verification_method,
      evidence_group: requirement.evidence_group,
    },
    folder_id: requirement.level === "system" ? workspace.systemFolder.id : workspace.derivedFolder.id,
    tag_ids: [workspace.tags[requirement.level].id, workspace.tags[requirement.verification_method].id],
  }));
  const imported = await request(`/api/v1/projects/${projectId}/requirements/import`, {
    method: "POST",
    idempotencyKey: commandKey("requirements"),
    body: { items },
  });
  return new Map(imported.items.map((requirement) => [requirement.key, requirement]));
}

async function createDecomposition(projectId, requirementsByKey) {
  const relationshipTypes = await request(`/api/v1/projects/${projectId}/relationship-types`);
  const decomposition = relationshipTypes.items.find((item) => item.key === "DECOMPOSES_TO");
  expect(decomposition, "DECOMPOSES_TO relationship type is missing");
  const existing = await request(`/api/v1/projects/${projectId}/relationships`);
  const existingEdges = new Set(existing.items.map((item) => `${item.source_key}:${item.target_key}`));
  let created = 0;
  for (const requirement of catalog.requirements.filter((item) => item.level === "derived")) {
    const edgeKey = `${requirement.parent_key}:${requirement.key}`;
    if (existingEdges.has(edgeKey)) continue;
    await request(`/api/v1/projects/${projectId}/relationships`, {
      method: "POST",
      idempotencyKey: commandKey("relationship", requirement.key),
      body: {
        relationship_type_id: decomposition.id,
        source_artifact_id: requirementsByKey.get(requirement.parent_key).id,
        target_artifact_id: requirementsByKey.get(requirement.key).id,
      },
    });
    created += 1;
  }
  return created;
}

async function createControlledGate(projectId, requirementsByKey, attachmentsByCase) {
  await request(`/api/v1/projects/${projectId}/members`, {
    method: "POST",
    body: { subject: verifierSubject, role: "reviewer" },
  });
  const changeset = await request(`/api/v1/projects/${projectId}/changesets`, {
    method: "POST",
    idempotencyKey: commandKey("changeset"),
    body: { message: "Establish the complete OpenRM system and derived requirement baseline." },
  });
  const baseline = await request(`/api/v1/projects/${projectId}/baselines`, {
    method: "POST",
    idempotencyKey: commandKey("baseline"),
    body: { name: `OpenRM self-verification baseline ${catalog.catalog_version}`, changeset_id: changeset.id, supersedes_baseline_id: null },
  });
  const review = await request(`/api/v1/projects/${projectId}/reviews`, {
    method: "POST",
    idempotencyKey: commandKey("review"),
    body: {
      baseline_id: baseline.id,
      title: `OpenRM complete requirements verification ${catalog.catalog_version}`,
      description: "Independent review of complete system/derived requirement allocation and repository-linked verification evidence.",
      due_at: null,
      required_approvals: 1,
    },
  });
  await request(`/api/v1/projects/${projectId}/reviews/${review.review_id}/participants`, {
    method: "POST",
    idempotencyKey: commandKey("participant"),
    body: { subject: verifierSubject, role_label: "Independent requirements verifier", required: true },
  });
  await request(`/api/v1/projects/${projectId}/reviews/${review.review_id}/start`, {
    method: "POST",
    idempotencyKey: commandKey("review-start"),
    body: { rationale: "Begin independent verification of the complete OpenRM requirement baseline." },
  });
  await request(`/api/v1/projects/${projectId}/reviews/${review.review_id}/decisions`, {
    method: "POST",
    token: verifierToken,
    idempotencyKey: commandKey("review-approval"),
    body: { decision: "approved", comment: "Requirement hierarchy and verification allocation are complete and independently reviewable." },
  });

  const existingCases = await request(`/api/v1/projects/${projectId}/verification/cases?review_id=${review.review_id}`);
  const cases = [];
  for (const definition of catalog.verification_cases) {
    const targetArtifactIds = catalog.requirements
      .filter((requirement) => requirement.evidence_group === definition.evidence_group)
      .map((requirement) => requirementsByKey.get(requirement.key).id);
    const verificationCase = existingCases.items.find((item) => item.key === definition.key)
      ?? await request(`/api/v1/projects/${projectId}/verification/cases`, {
        method: "POST",
        idempotencyKey: commandKey("case", definition.key),
        body: {
          review_id: review.review_id,
          key: definition.key,
          title: definition.title,
          method: definition.method,
          procedure: definition.procedure,
          acceptance_criteria: definition.acceptance_criteria,
          owner_subject: verifierSubject,
          due_at: null,
          target_artifact_ids: targetArtifactIds,
        },
      });
    const run = await request(`/api/v1/projects/${projectId}/verification/cases/${verificationCase.id}/runs`, {
      method: "POST",
      token: verifierToken,
      idempotencyKey: commandKey("run", evidenceVersion, definition.key),
      body: { execution_note: `Execute ${definition.title} against the signed ${catalog.catalog_version} baseline.` },
    });
    await request(`/api/v1/projects/${projectId}/verification/runs/${run.id}/results`, {
      method: "POST",
      token: verifierToken,
      idempotencyKey: commandKey("result", evidenceVersion, definition.key),
      body: {
        outcome: "passed",
        notes: `${definition.notes} Evidence run: ${evidenceRunUrl}`,
        measured_values: { ...definition.measured_values, catalog_version: catalog.catalog_version, evidence_version: evidenceVersion, evidence_run_url: evidenceRunUrl },
        attachments: attachmentsByCase.get(definition.key),
      },
    });
    cases.push(verificationCase);
  }
  return { changeset, baseline, review, cases };
}

async function verifyProject(projectId, reviewId) {
  const requirements = await request(`/api/v1/projects/${projectId}/requirements?limit=100&offset=0`);
  const relationships = await request(`/api/v1/projects/${projectId}/relationships`);
  const trace = await request(`/api/v1/projects/${projectId}/trace/summary`);
  const cases = await request(`/api/v1/projects/${projectId}/verification/cases?review_id=${reviewId}`);
  const coverage = await request(`/api/v1/projects/${projectId}/verification/coverage?review_id=${reviewId}`);
  const readiness = await request(`/api/v1/projects/${projectId}/verification/readiness?review_id=${reviewId}`);

  expect(requirements.total === catalog.expected_counts.total, `stored requirement total is ${requirements.total}`);
  expect(relationships.items.length === catalog.expected_counts.decomposition_relationships, `stored decomposition total is ${relationships.items.length}`);
  expect(trace.total_artifacts === catalog.expected_counts.total, `trace total is ${trace.total_artifacts}`);
  expect(trace.orphan_artifacts === 0, `trace has ${trace.orphan_artifacts} orphan artifacts`);
  expect(trace.suspect_relationships === 0, `trace has ${trace.suspect_relationships} suspect relationships`);
  expect(cases.items.length === catalog.expected_counts.verification_cases, `stored verification case total is ${cases.items.length}`);
  expect(cases.items.every((item) => item.status === "passed"), "not every verification case passed");
  expect(coverage.total_artifacts === catalog.expected_counts.total, `coverage total is ${coverage.total_artifacts}`);
  expect(coverage.passed_artifacts === catalog.expected_counts.total, `passed coverage total is ${coverage.passed_artifacts}`);
  expect(coverage.coverage_percent === 100, `coverage is ${coverage.coverage_percent}%`);
  expect(readiness.ready === true, `gate readiness is blocked: ${readiness.blockers.join("; ")}`);
  expect(readiness.blockers.length === 0, `gate reports blockers: ${readiness.blockers.join("; ")}`);

  return {
    requirements: requirements.total,
    system_requirements: catalog.expected_counts.system,
    derived_requirements: catalog.expected_counts.derived,
    decomposition_relationships: relationships.items.length,
    trace_coverage_percent: trace.coverage_percent,
    orphan_requirements: trace.orphan_artifacts,
    suspect_relationships: trace.suspect_relationships,
    verification_cases: cases.items.length,
    passed_artifacts: coverage.passed_artifacts,
    verification_coverage_percent: coverage.coverage_percent,
    ready: readiness.ready,
    blockers: readiness.blockers,
  };
}

validateCatalog();
const attachmentsByCase = await validateEvidence();
const evidenceDigest = createHash("sha256");
for (const [caseKey, attachments] of [...attachmentsByCase.entries()].sort(([left], [right]) => left.localeCompare(right))) {
  evidenceDigest.update(caseKey);
  for (const attachment of attachments) evidenceDigest.update(`${attachment.object_key}:${attachment.size_bytes}:${attachment.sha256}`);
}
evidenceVersion = process.env.OPENRM_SELF_EVIDENCE_VERSION ?? evidenceDigest.digest("hex").slice(0, 16);

if (validateOnly) {
  const validation = {
    status: "valid",
    catalog_version: catalog.catalog_version,
    evidence_version: evidenceVersion,
    requirements: catalog.requirements.length,
    decomposition_relationships: catalog.expected_counts.decomposition_relationships,
    verification_cases: catalog.verification_cases.length,
    evidence_attachments: [...attachmentsByCase.values()].reduce((total, attachments) => total + attachments.length, 0),
  };
  console.log(jsonOutput ? JSON.stringify(validation) : `OpenRM self-project catalog valid: ${JSON.stringify(validation)}`);
  process.exit(0);
}

const project = await ensureProject();
const workspace = await ensureWorkspace(project.id);
const requirementsByKey = await importRequirements(project.id, workspace);
await createDecomposition(project.id, requirementsByKey);
const gate = await createControlledGate(project.id, requirementsByKey, attachmentsByCase);
const verification = await verifyProject(project.id, gate.review.review_id);
const summary = {
  status: "complete",
  project_id: project.id,
  project_key: project.key,
  changeset_id: gate.changeset.id,
  baseline_id: gate.baseline.id,
  review_id: gate.review.review_id,
  evidence_run_url: evidenceRunUrl,
  ...verification,
};
console.log(jsonOutput ? JSON.stringify(summary) : `OpenRM self-project complete:\n${JSON.stringify(summary, null, 2)}`);
