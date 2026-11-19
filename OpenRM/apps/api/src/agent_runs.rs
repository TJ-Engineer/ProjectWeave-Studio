use std::collections::HashSet;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, Timelike, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthenticatedPrincipal,
    error::ApiError,
    evidence::EvidenceSigner,
    policy::{Action, Principal},
    projects::{authorize_project, insert_audit},
};

const IDEMPOTENCY_HEADER: &str = "x-idempotency-key";
const CREATE_AGENT_RUN_COMMAND: &str = "agent_run.create";
const AGENT_RUN_SCHEMA_VERSION: &str = "openrm-agent-run-v1";

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AgentRunOutputInput {
    pub relation: String,
    #[serde(default)]
    pub artifact_id: Option<Uuid>,
    #[serde(default)]
    pub artifact_revision_id: Option<Uuid>,
    #[serde(default)]
    pub external_system: Option<String>,
    #[serde(default)]
    pub external_reference: Option<String>,
    #[serde(default)]
    pub external_uri: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CreateAgentRunRequest {
    pub external_run_id: String,
    pub model: String,
    pub prompt: String,
    #[serde(default = "empty_object")]
    pub context: Value,
    #[serde(default = "empty_array")]
    pub tool_calls: Value,
    pub output: Value,
    pub outcome: String,
    pub started_at: DateTime<Utc>,
    pub completed_at: DateTime<Utc>,
    #[serde(default)]
    pub outputs: Vec<AgentRunOutputInput>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AgentRunOutputResponse {
    pub id: Uuid,
    pub relation: String,
    pub artifact_id: Option<Uuid>,
    pub artifact_revision_id: Option<Uuid>,
    pub artifact_key: Option<String>,
    pub external_system: Option<String>,
    pub external_reference: Option<String>,
    pub external_uri: Option<String>,
    pub sha256: Option<String>,
    pub recorded_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AgentRunResponse {
    pub id: Uuid,
    pub project_id: Uuid,
    pub external_run_id: String,
    pub model: String,
    pub prompt: String,
    pub context: Value,
    pub tool_calls: Value,
    pub output: Value,
    pub outcome: String,
    pub started_at: DateTime<Utc>,
    pub completed_at: DateTime<Utc>,
    pub evidence_hash: String,
    pub signature: String,
    pub signing_algorithm: String,
    pub signing_key_id: String,
    pub recorded_by: String,
    pub recorded_at: DateTime<Utc>,
    pub signature_valid: bool,
    pub outputs: Vec<AgentRunOutputResponse>,
}

#[derive(Debug, Serialize)]
pub struct AgentRunListResponse {
    pub items: Vec<AgentRunResponse>,
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
}

#[derive(Debug, Deserialize)]
pub struct AgentRunListQuery {
    #[serde(default = "default_limit")]
    pub limit: i64,
    #[serde(default)]
    pub offset: i64,
}

#[derive(Debug, FromRow)]
struct AgentRunRecord {
    id: Uuid,
    project_id: Uuid,
    external_run_id: String,
    model: String,
    prompt: String,
    context: Value,
    tool_calls: Value,
    output: Value,
    outcome: String,
    started_at: DateTime<Utc>,
    completed_at: DateTime<Utc>,
    evidence_hash: String,
    signature: String,
    signing_algorithm: String,
    signing_key_id: String,
    recorded_by: String,
    recorded_at: DateTime<Utc>,
}

#[derive(Debug, FromRow)]
struct AgentRunOutputRecord {
    id: Uuid,
    relation: String,
    artifact_id: Option<Uuid>,
    artifact_revision_id: Option<Uuid>,
    artifact_key: Option<String>,
    external_system: Option<String>,
    external_reference: Option<String>,
    external_uri: Option<String>,
    sha256: Option<String>,
    recorded_at: DateTime<Utc>,
}

#[derive(Debug, FromRow)]
struct StoredCommand {
    request_fingerprint: String,
    response_payload: Value,
}

#[derive(Clone, Debug, Serialize)]
struct AgentRunEvidenceOutput {
    relation: String,
    artifact_id: Option<Uuid>,
    artifact_revision_id: Option<Uuid>,
    external_system: Option<String>,
    external_reference: Option<String>,
    external_uri: Option<String>,
    sha256: Option<String>,
}

#[derive(Serialize)]
struct AgentRunEvidence<'a> {
    schema_version: &'static str,
    project_id: Uuid,
    external_run_id: &'a str,
    model: &'a str,
    prompt: &'a str,
    context: &'a Value,
    tool_calls: &'a Value,
    output: &'a Value,
    outcome: &'a str,
    started_at: DateTime<Utc>,
    completed_at: DateTime<Utc>,
    recorded_by: &'a str,
    outputs: &'a [AgentRunEvidenceOutput],
}

pub async fn list_agent_runs(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
    Query(query): Query<AgentRunListQuery>,
) -> Result<Json<AgentRunListResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Read).await?;
    if !(1..=100).contains(&query.limit) || query.offset < 0 {
        return Err(ApiError::bad_request(
            "limit must be 1-100 and offset cannot be negative",
        ));
    }
    let total = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM agent_runs WHERE organization_id = $1 AND project_id = $2",
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .fetch_one(&state.db)
    .await
    .map_err(database_error)?;
    let records = sqlx::query_as::<_, AgentRunRecord>(
        r#"
        SELECT id, project_id, external_run_id, model, prompt, context,
               tool_calls, output, outcome, started_at, completed_at,
               evidence_hash, signature, signing_algorithm, signing_key_id,
               recorded_by, recorded_at
        FROM agent_runs
        WHERE organization_id = $1 AND project_id = $2
        ORDER BY recorded_at DESC, id DESC
        LIMIT $3 OFFSET $4
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(query.limit)
    .bind(query.offset)
    .fetch_all(&state.db)
    .await
    .map_err(database_error)?;
    let mut items = Vec::with_capacity(records.len());
    for record in records {
        items.push(load_response(&state, &principal, record).await?);
    }
    Ok(Json(AgentRunListResponse {
        items,
        total,
        limit: query.limit,
        offset: query.offset,
    }))
}

pub async fn get_agent_run(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path((project_id, agent_run_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<AgentRunResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Read).await?;
    let record = fetch_agent_run(&state.db, &principal, project_id, agent_run_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Agent run does not exist"))?;
    Ok(Json(load_response(&state, &principal, record).await?))
}

pub async fn create_agent_run(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<CreateAgentRunRequest>,
) -> Result<(StatusCode, Json<AgentRunResponse>), ApiError> {
    authorize_project(&state, &principal, project_id, Action::Write).await?;
    let request = validate_request(request)?;
    let idempotency_key = parse_idempotency_key(&headers)?;
    let request_fingerprint = fingerprint(&(project_id, &request))?;
    if let Some(response) =
        replay_command(&state.db, &principal, idempotency_key, &request_fingerprint).await?
    {
        return Ok((StatusCode::OK, Json(response)));
    }

    let mut transaction = state.db.begin().await.map_err(database_error)?;
    if let Some(response) = replay_command_tx(
        &mut transaction,
        &principal,
        idempotency_key,
        &request_fingerprint,
    )
    .await?
    {
        return Ok((StatusCode::OK, Json(response)));
    }
    validate_internal_outputs(&mut transaction, &principal, project_id, &request.outputs).await?;

    let evidence_outputs = request
        .outputs
        .iter()
        .map(evidence_output_from_input)
        .collect::<Vec<_>>();
    let evidence = AgentRunEvidence {
        schema_version: AGENT_RUN_SCHEMA_VERSION,
        project_id,
        external_run_id: &request.external_run_id,
        model: &request.model,
        prompt: &request.prompt,
        context: &request.context,
        tool_calls: &request.tool_calls,
        output: &request.output,
        outcome: &request.outcome,
        started_at: request.started_at,
        completed_at: request.completed_at,
        recorded_by: &principal.subject,
        outputs: &evidence_outputs,
    };
    let evidence_hash = canonical_hash(&evidence, "agent run evidence")?;
    let signature = state.evidence_signer.sign(&evidence_hash);
    let agent_run_id = Uuid::new_v4();
    let recorded_at = sqlx::query_scalar::<_, DateTime<Utc>>(
        r#"
        INSERT INTO agent_runs (
            id, organization_id, project_id, external_run_id, model, prompt,
            context, tool_calls, output, outcome, started_at, completed_at,
            evidence_hash, signature, signing_algorithm, signing_key_id, recorded_by
        )
        VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11, $12,
            $13, $14, $15, $16, $17
        )
        RETURNING recorded_at
        "#,
    )
    .bind(agent_run_id)
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(&request.external_run_id)
    .bind(&request.model)
    .bind(&request.prompt)
    .bind(&request.context)
    .bind(&request.tool_calls)
    .bind(&request.output)
    .bind(&request.outcome)
    .bind(request.started_at)
    .bind(request.completed_at)
    .bind(&evidence_hash)
    .bind(&signature)
    .bind(EvidenceSigner::ALGORITHM)
    .bind(state.evidence_signer.key_id())
    .bind(&principal.subject)
    .fetch_one(&mut *transaction)
    .await
    .map_err(conflict_database_error)?;

    let mut response_outputs = Vec::with_capacity(request.outputs.len());
    for output in &request.outputs {
        let output_id = Uuid::new_v4();
        let (recorded_at, artifact_key) = insert_output(
            &mut transaction,
            &principal,
            project_id,
            agent_run_id,
            output_id,
            output,
        )
        .await?;
        response_outputs.push(AgentRunOutputResponse {
            id: output_id,
            relation: output.relation.clone(),
            artifact_id: output.artifact_id,
            artifact_revision_id: output.artifact_revision_id,
            artifact_key,
            external_system: output.external_system.clone(),
            external_reference: output.external_reference.clone(),
            external_uri: output.external_uri.clone(),
            sha256: output.sha256.clone(),
            recorded_at,
        });
    }
    let response = AgentRunResponse {
        id: agent_run_id,
        project_id,
        external_run_id: request.external_run_id,
        model: request.model,
        prompt: request.prompt,
        context: request.context,
        tool_calls: request.tool_calls,
        output: request.output,
        outcome: request.outcome,
        started_at: request.started_at,
        completed_at: request.completed_at,
        evidence_hash,
        signature,
        signing_algorithm: EvidenceSigner::ALGORITHM.to_owned(),
        signing_key_id: state.evidence_signer.key_id().to_owned(),
        recorded_by: principal.subject.clone(),
        recorded_at,
        signature_valid: true,
        outputs: response_outputs,
    };
    insert_audit(
        &mut transaction,
        &principal,
        project_id,
        "agent_run.recorded",
        "agent_run",
        agent_run_id,
        serde_json::json!({
            "external_run_id": response.external_run_id,
            "model": response.model,
            "outcome": response.outcome,
            "evidence_hash": response.evidence_hash,
            "output_count": response.outputs.len(),
        }),
    )
    .await?;
    store_command(
        &mut transaction,
        &principal,
        idempotency_key,
        &request_fingerprint,
        agent_run_id,
        &response,
    )
    .await?;
    transaction.commit().await.map_err(database_error)?;
    Ok((StatusCode::CREATED, Json(response)))
}

async fn fetch_agent_run(
    pool: &PgPool,
    principal: &Principal,
    project_id: Uuid,
    agent_run_id: Uuid,
) -> Result<Option<AgentRunRecord>, ApiError> {
    sqlx::query_as::<_, AgentRunRecord>(
        r#"
        SELECT id, project_id, external_run_id, model, prompt, context,
               tool_calls, output, outcome, started_at, completed_at,
               evidence_hash, signature, signing_algorithm, signing_key_id,
               recorded_by, recorded_at
        FROM agent_runs
        WHERE organization_id = $1 AND project_id = $2 AND id = $3
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(agent_run_id)
    .fetch_optional(pool)
    .await
    .map_err(database_error)
}

async fn load_response(
    state: &AppState,
    principal: &Principal,
    record: AgentRunRecord,
) -> Result<AgentRunResponse, ApiError> {
    let outputs = sqlx::query_as::<_, AgentRunOutputRecord>(
        r#"
        SELECT output.id, output.relation, output.artifact_id,
               output.artifact_revision_id, artifact.key AS artifact_key,
               output.external_system, output.external_reference,
               output.external_uri, output.sha256, output.recorded_at
        FROM agent_run_outputs output
        LEFT JOIN artifacts artifact
          ON artifact.organization_id = output.organization_id
         AND artifact.project_id = output.project_id
         AND artifact.id = output.artifact_id
        WHERE output.organization_id = $1
          AND output.project_id = $2
          AND output.agent_run_id = $3
        ORDER BY output.relation, output.artifact_id NULLS LAST,
                 output.artifact_revision_id NULLS LAST,
                 output.external_system NULLS LAST,
                 output.external_reference NULLS LAST
        "#,
    )
    .bind(principal.organization_id)
    .bind(record.project_id)
    .bind(record.id)
    .fetch_all(&state.db)
    .await
    .map_err(database_error)?;
    let outputs = outputs
        .into_iter()
        .map(|output| AgentRunOutputResponse {
            id: output.id,
            relation: output.relation,
            artifact_id: output.artifact_id,
            artifact_revision_id: output.artifact_revision_id,
            artifact_key: output.artifact_key,
            external_system: output.external_system,
            external_reference: output.external_reference,
            external_uri: output.external_uri,
            sha256: output.sha256,
            recorded_at: output.recorded_at,
        })
        .collect::<Vec<_>>();
    let evidence_outputs = outputs
        .iter()
        .map(evidence_output_from_response)
        .collect::<Vec<_>>();
    let evidence = AgentRunEvidence {
        schema_version: AGENT_RUN_SCHEMA_VERSION,
        project_id: record.project_id,
        external_run_id: &record.external_run_id,
        model: &record.model,
        prompt: &record.prompt,
        context: &record.context,
        tool_calls: &record.tool_calls,
        output: &record.output,
        outcome: &record.outcome,
        started_at: record.started_at,
        completed_at: record.completed_at,
        recorded_by: &record.recorded_by,
        outputs: &evidence_outputs,
    };
    let calculated_hash = canonical_hash(&evidence, "stored agent run evidence")?;
    let signature_valid = calculated_hash == record.evidence_hash
        && record.signing_algorithm == EvidenceSigner::ALGORITHM
        && state.evidence_signer.verify_with_key_id(
            &record.signing_key_id,
            &record.evidence_hash,
            &record.signature,
        );
    Ok(AgentRunResponse {
        id: record.id,
        project_id: record.project_id,
        external_run_id: record.external_run_id,
        model: record.model,
        prompt: record.prompt,
        context: record.context,
        tool_calls: record.tool_calls,
        output: record.output,
        outcome: record.outcome,
        started_at: record.started_at,
        completed_at: record.completed_at,
        evidence_hash: record.evidence_hash,
        signature: record.signature,
        signing_algorithm: record.signing_algorithm,
        signing_key_id: record.signing_key_id,
        recorded_by: record.recorded_by,
        recorded_at: record.recorded_at,
        signature_valid,
        outputs,
    })
}

async fn validate_internal_outputs(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    project_id: Uuid,
    outputs: &[AgentRunOutputInput],
) -> Result<(), ApiError> {
    for output in outputs {
        let (Some(artifact_id), Some(revision_id)) =
            (output.artifact_id, output.artifact_revision_id)
        else {
            continue;
        };
        let exists = sqlx::query_scalar::<_, bool>(
            r#"
            SELECT EXISTS(
                SELECT 1
                FROM artifact_revisions revision
                WHERE revision.organization_id = $1
                  AND revision.project_id = $2
                  AND revision.artifact_id = $3
                  AND revision.id = $4
            )
            "#,
        )
        .bind(principal.organization_id)
        .bind(project_id)
        .bind(artifact_id)
        .bind(revision_id)
        .fetch_one(&mut **transaction)
        .await
        .map_err(database_error)?;
        if !exists {
            return Err(ApiError::bad_request(
                "Agent run output references an artifact revision outside the project",
            ));
        }
    }
    Ok(())
}

async fn insert_output(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    project_id: Uuid,
    agent_run_id: Uuid,
    output_id: Uuid,
    output: &AgentRunOutputInput,
) -> Result<(DateTime<Utc>, Option<String>), ApiError> {
    let recorded_at = sqlx::query_scalar::<_, DateTime<Utc>>(
        r#"
        INSERT INTO agent_run_outputs (
            id, organization_id, project_id, agent_run_id, relation,
            artifact_id, artifact_revision_id, external_system,
            external_reference, external_uri, sha256
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING recorded_at
        "#,
    )
    .bind(output_id)
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(agent_run_id)
    .bind(&output.relation)
    .bind(output.artifact_id)
    .bind(output.artifact_revision_id)
    .bind(&output.external_system)
    .bind(&output.external_reference)
    .bind(&output.external_uri)
    .bind(&output.sha256)
    .fetch_one(&mut **transaction)
    .await
    .map_err(conflict_database_error)?;
    let artifact_key = if let Some(artifact_id) = output.artifact_id {
        sqlx::query_scalar::<_, String>(
            "SELECT key FROM artifacts WHERE organization_id = $1 AND project_id = $2 AND id = $3",
        )
        .bind(principal.organization_id)
        .bind(project_id)
        .bind(artifact_id)
        .fetch_optional(&mut **transaction)
        .await
        .map_err(database_error)?
    } else {
        None
    };
    Ok((recorded_at, artifact_key))
}

fn validate_request(mut request: CreateAgentRunRequest) -> Result<CreateAgentRunRequest, ApiError> {
    request.external_run_id = validate_identifier(&request.external_run_id)?;
    request.model = validate_required_text(&request.model, 200, "model")?;
    if request.prompt.trim().is_empty() || request.prompt.chars().count() > 100_000 {
        return Err(ApiError::bad_request(
            "prompt must contain 1-100000 characters",
        ));
    }
    if !request.context.is_object() {
        return Err(ApiError::bad_request("context must be an object"));
    }
    let tool_calls = request
        .tool_calls
        .as_array()
        .ok_or_else(|| ApiError::bad_request("tool_calls must be an array"))?;
    if tool_calls.len() > 1_000 {
        return Err(ApiError::bad_request(
            "tool_calls must contain at most 1000 entries",
        ));
    }
    if request.output.is_null() {
        return Err(ApiError::bad_request("output cannot be null"));
    }
    if contains_sensitive_key(&request.context)
        || contains_sensitive_key(&request.tool_calls)
        || contains_sensitive_key(&request.output)
    {
        return Err(ApiError::bad_request(
            "context, tool_calls, and output cannot contain credential-bearing fields",
        ));
    }
    request.outcome = request.outcome.trim().to_ascii_lowercase();
    if !matches!(
        request.outcome.as_str(),
        "succeeded" | "failed" | "cancelled"
    ) {
        return Err(ApiError::bad_request(
            "outcome must be succeeded, failed, or cancelled",
        ));
    }
    if request.completed_at < request.started_at {
        return Err(ApiError::bad_request(
            "completed_at cannot be earlier than started_at",
        ));
    }
    request.started_at = truncate_to_microseconds(request.started_at);
    request.completed_at = truncate_to_microseconds(request.completed_at);
    if request.outputs.len() > 500 {
        return Err(ApiError::bad_request(
            "outputs must contain at most 500 links",
        ));
    }
    let mut unique_outputs = HashSet::new();
    for output in &mut request.outputs {
        validate_output(output)?;
        let identity = serde_json::to_string(output)
            .map_err(|_| ApiError::internal("Could not validate agent output link"))?;
        if !unique_outputs.insert(identity) {
            return Err(ApiError::bad_request(
                "agent run output links must be unique",
            ));
        }
    }
    request.outputs.sort_by_key(|output| {
        (
            output.relation.clone(),
            output.artifact_id,
            output.artifact_revision_id,
            output.external_system.clone(),
            output.external_reference.clone(),
        )
    });
    Ok(request)
}

fn truncate_to_microseconds(value: DateTime<Utc>) -> DateTime<Utc> {
    value
        .with_nanosecond((value.nanosecond() / 1_000) * 1_000)
        .expect("a truncated nanosecond value remains valid")
}

fn validate_output(output: &mut AgentRunOutputInput) -> Result<(), ApiError> {
    output.relation = output.relation.trim().to_ascii_lowercase();
    if !matches!(
        output.relation.as_str(),
        "created" | "updated" | "generated" | "referenced" | "verified"
    ) {
        return Err(ApiError::bad_request("agent output relation is invalid"));
    }
    let internal = output.artifact_id.is_some() || output.artifact_revision_id.is_some();
    let external = output.external_system.is_some()
        || output.external_reference.is_some()
        || output.external_uri.is_some()
        || output.sha256.is_some();
    if internal == external {
        return Err(ApiError::bad_request(
            "each agent output must be exactly one internal revision or external reference",
        ));
    }
    if internal {
        if output.artifact_id.is_none() || output.artifact_revision_id.is_none() {
            return Err(ApiError::bad_request(
                "internal outputs require artifact_id and artifact_revision_id",
            ));
        }
        return Ok(());
    }
    output.external_system = Some(validate_external_system(
        output.external_system.as_deref().unwrap_or_default(),
    )?);
    output.external_reference = Some(validate_required_text(
        output.external_reference.as_deref().unwrap_or_default(),
        500,
        "external_reference",
    )?);
    output.external_uri = output
        .external_uri
        .take()
        .map(|value| validate_external_uri(&value))
        .transpose()?;
    output.sha256 = output
        .sha256
        .take()
        .map(|value| validate_sha256(&value))
        .transpose()?;
    Ok(())
}

fn validate_identifier(value: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 200
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        })
    {
        return Err(ApiError::bad_request(
            "external_run_id must contain 1-200 safe identifier characters",
        ));
    }
    Ok(value.to_owned())
}

fn validate_external_system(value: &str) -> Result<String, ApiError> {
    let value = value.trim().to_ascii_lowercase();
    if value.is_empty()
        || value.len() > 80
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_' | b'.')
        })
    {
        return Err(ApiError::bad_request(
            "external_system must contain 1-80 lowercase identifier characters",
        ));
    }
    Ok(value)
}

fn validate_external_uri(value: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if value.len() > 2_000 {
        return Err(ApiError::bad_request(
            "external_uri must not exceed 2000 characters",
        ));
    }
    let uri =
        reqwest::Url::parse(value).map_err(|_| ApiError::bad_request("external_uri is invalid"))?;
    let loopback = matches!(uri.host_str(), Some("127.0.0.1" | "localhost"));
    if (uri.scheme() != "https" && !(uri.scheme() == "http" && loopback))
        || !uri.username().is_empty()
        || uri.password().is_some()
    {
        return Err(ApiError::bad_request(
            "external_uri must use HTTPS or loopback HTTP without credentials",
        ));
    }
    Ok(uri.to_string())
}

fn validate_sha256(value: &str) -> Result<String, ApiError> {
    let value = value.trim().to_ascii_lowercase();
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ApiError::bad_request(
            "sha256 must contain 64 hexadecimal characters",
        ));
    }
    Ok(value)
}

fn validate_required_text(value: &str, max: usize, label: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max {
        return Err(ApiError::bad_request(format!(
            "{label} must contain 1-{max} characters"
        )));
    }
    Ok(value.to_owned())
}

fn contains_sensitive_key(value: &Value) -> bool {
    match value {
        Value::Object(values) => values.iter().any(|(key, value)| {
            let normalized = key
                .chars()
                .filter(|character| character.is_ascii_alphanumeric())
                .flat_map(char::to_lowercase)
                .collect::<String>();
            matches!(
                normalized.as_str(),
                "authorization"
                    | "password"
                    | "secret"
                    | "apikey"
                    | "accesstoken"
                    | "refreshtoken"
                    | "clientsecret"
            ) || contains_sensitive_key(value)
        }),
        Value::Array(values) => values.iter().any(contains_sensitive_key),
        _ => false,
    }
}

fn evidence_output_from_input(output: &AgentRunOutputInput) -> AgentRunEvidenceOutput {
    AgentRunEvidenceOutput {
        relation: output.relation.clone(),
        artifact_id: output.artifact_id,
        artifact_revision_id: output.artifact_revision_id,
        external_system: output.external_system.clone(),
        external_reference: output.external_reference.clone(),
        external_uri: output.external_uri.clone(),
        sha256: output.sha256.clone(),
    }
}

fn evidence_output_from_response(output: &AgentRunOutputResponse) -> AgentRunEvidenceOutput {
    AgentRunEvidenceOutput {
        relation: output.relation.clone(),
        artifact_id: output.artifact_id,
        artifact_revision_id: output.artifact_revision_id,
        external_system: output.external_system.clone(),
        external_reference: output.external_reference.clone(),
        external_uri: output.external_uri.clone(),
        sha256: output.sha256.clone(),
    }
}

fn default_limit() -> i64 {
    50
}

fn empty_object() -> Value {
    Value::Object(Default::default())
}

fn empty_array() -> Value {
    Value::Array(Vec::new())
}

fn canonical_hash<T: Serialize>(value: &T, label: &str) -> Result<String, ApiError> {
    let bytes = serde_json::to_vec(value)
        .map_err(|_| ApiError::internal(format!("Could not serialize {label}")))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn fingerprint<T: Serialize>(value: &T) -> Result<String, ApiError> {
    serde_json::to_string(value)
        .map_err(|_| ApiError::internal("Could not fingerprint agent run command"))
}

fn parse_idempotency_key(headers: &HeaderMap) -> Result<&str, ApiError> {
    headers
        .get(IDEMPOTENCY_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| (8..=128).contains(&value.len()))
        .filter(|value| {
            value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':')
            })
        })
        .ok_or_else(|| ApiError::bad_request("X-Idempotency-Key is invalid"))
}

async fn find_command(
    pool: &PgPool,
    principal: &Principal,
    idempotency_key: &str,
) -> Result<Option<StoredCommand>, ApiError> {
    sqlx::query_as::<_, StoredCommand>(
        r#"
        SELECT request_fingerprint, response_payload
        FROM command_results
        WHERE organization_id = $1 AND actor_subject = $2
          AND command_name = $3 AND idempotency_key = $4
        "#,
    )
    .bind(principal.organization_id)
    .bind(&principal.subject)
    .bind(CREATE_AGENT_RUN_COMMAND)
    .bind(idempotency_key)
    .fetch_optional(pool)
    .await
    .map_err(database_error)
}

async fn find_command_tx(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    idempotency_key: &str,
) -> Result<Option<StoredCommand>, ApiError> {
    sqlx::query_as::<_, StoredCommand>(
        r#"
        SELECT request_fingerprint, response_payload
        FROM command_results
        WHERE organization_id = $1 AND actor_subject = $2
          AND command_name = $3 AND idempotency_key = $4
        "#,
    )
    .bind(principal.organization_id)
    .bind(&principal.subject)
    .bind(CREATE_AGENT_RUN_COMMAND)
    .bind(idempotency_key)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(database_error)
}

async fn replay_command(
    pool: &PgPool,
    principal: &Principal,
    idempotency_key: &str,
    request_fingerprint: &str,
) -> Result<Option<AgentRunResponse>, ApiError> {
    deserialize_command(
        find_command(pool, principal, idempotency_key).await?,
        request_fingerprint,
    )
}

async fn replay_command_tx(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    idempotency_key: &str,
    request_fingerprint: &str,
) -> Result<Option<AgentRunResponse>, ApiError> {
    deserialize_command(
        find_command_tx(transaction, principal, idempotency_key).await?,
        request_fingerprint,
    )
}

fn deserialize_command(
    stored: Option<StoredCommand>,
    request_fingerprint: &str,
) -> Result<Option<AgentRunResponse>, ApiError> {
    let Some(stored) = stored else {
        return Ok(None);
    };
    if stored.request_fingerprint != request_fingerprint {
        return Err(ApiError::conflict(
            "Idempotency key was already used with a different agent run command",
        ));
    }
    serde_json::from_value(stored.response_payload)
        .map(Some)
        .map_err(|_| ApiError::internal("Stored agent run response is invalid"))
}

async fn store_command(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    idempotency_key: &str,
    request_fingerprint: &str,
    agent_run_id: Uuid,
    response: &AgentRunResponse,
) -> Result<(), ApiError> {
    let response_payload = serde_json::to_value(response)
        .map_err(|_| ApiError::internal("Could not store agent run response"))?;
    sqlx::query(
        r#"
        INSERT INTO command_results (
            organization_id, actor_subject, command_name, idempotency_key,
            request_fingerprint, aggregate_type, aggregate_id,
            response_revision, response_payload
        )
        VALUES ($1, $2, $3, $4, $5, 'agent_run', $6, 1, $7)
        "#,
    )
    .bind(principal.organization_id)
    .bind(&principal.subject)
    .bind(CREATE_AGENT_RUN_COMMAND)
    .bind(idempotency_key)
    .bind(request_fingerprint)
    .bind(agent_run_id)
    .bind(response_payload)
    .execute(&mut **transaction)
    .await
    .map_err(database_error)?;
    Ok(())
}

fn conflict_database_error(error: sqlx::Error) -> ApiError {
    if matches!(&error, sqlx::Error::Database(database) if database.is_unique_violation()) {
        ApiError::conflict("Agent run conflicts with existing immutable evidence")
    } else {
        database_error(error)
    }
}

fn database_error(error: sqlx::Error) -> ApiError {
    tracing::warn!(%error, "agent run database operation failed");
    ApiError::unavailable("Agent run database operation failed")
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, Utc};
    use serde_json::json;
    use uuid::Uuid;

    use super::{
        AGENT_RUN_SCHEMA_VERSION, AgentRunEvidence, AgentRunOutputInput, CreateAgentRunRequest,
        canonical_hash, evidence_output_from_input, validate_request,
    };

    fn request(outputs: Vec<AgentRunOutputInput>) -> CreateAgentRunRequest {
        let started_at = Utc::now();
        CreateAgentRunRequest {
            external_run_id: "run:test-001".to_owned(),
            model: "test-model".to_owned(),
            prompt: "Implement the controlled change.".to_owned(),
            context: json!({"requirement": "ORM-005"}),
            tool_calls: json!([{"tool": "openrm.get_requirement", "status": "ok"}]),
            output: json!({"summary": "Implemented"}),
            outcome: "succeeded".to_owned(),
            started_at,
            completed_at: started_at + Duration::seconds(1),
            outputs,
        }
    }

    #[test]
    fn validates_and_normalizes_external_outputs() {
        let validated = validate_request(request(vec![AgentRunOutputInput {
            relation: " Generated ".to_owned(),
            artifact_id: None,
            artifact_revision_id: None,
            external_system: Some("ProjectWeave-Jira".to_owned()),
            external_reference: Some(" ORM-6 ".to_owned()),
            external_uri: Some("http://localhost:3000/projects/ORM/issues/ORM-6".to_owned()),
            sha256: None,
        }]))
        .expect("valid agent run");
        assert_eq!(validated.outputs[0].relation, "generated");
        assert_eq!(
            validated.outputs[0].external_system.as_deref(),
            Some("projectweave-jira")
        );
        assert_eq!(
            validated.outputs[0].external_reference.as_deref(),
            Some("ORM-6")
        );
    }

    #[test]
    fn rejects_mixed_internal_and_external_output_identity() {
        let error = validate_request(request(vec![AgentRunOutputInput {
            relation: "updated".to_owned(),
            artifact_id: Some(Uuid::new_v4()),
            artifact_revision_id: Some(Uuid::new_v4()),
            external_system: Some("git".to_owned()),
            external_reference: Some("abc123".to_owned()),
            external_uri: None,
            sha256: None,
        }]))
        .expect_err("mixed output must fail");
        assert!(error.message.contains("exactly one"));
    }

    #[test]
    fn rejects_structured_credentials() {
        let mut value = request(Vec::new());
        value.context = json!({"authorization": "Bearer do-not-store"});
        let error = validate_request(value).expect_err("credentials must fail");
        assert!(error.message.contains("credential-bearing"));
    }

    #[test]
    fn canonical_agent_run_hash_is_stable_after_output_sorting() {
        let internal = AgentRunOutputInput {
            relation: "updated".to_owned(),
            artifact_id: Some(Uuid::nil()),
            artifact_revision_id: Some(Uuid::from_u128(1)),
            external_system: None,
            external_reference: None,
            external_uri: None,
            sha256: None,
        };
        let external = AgentRunOutputInput {
            relation: "generated".to_owned(),
            artifact_id: None,
            artifact_revision_id: None,
            external_system: Some("git".to_owned()),
            external_reference: Some("abc123".to_owned()),
            external_uri: None,
            sha256: Some("a".repeat(64)),
        };
        let first = validate_request(request(vec![internal.clone(), external.clone()]))
            .expect("first request");
        let mut reordered = request(vec![external, internal]);
        reordered.started_at = first.started_at;
        reordered.completed_at = first.completed_at;
        let second = validate_request(reordered).expect("second request");
        let first_outputs = first
            .outputs
            .iter()
            .map(evidence_output_from_input)
            .collect::<Vec<_>>();
        let second_outputs = second
            .outputs
            .iter()
            .map(evidence_output_from_input)
            .collect::<Vec<_>>();
        let first_evidence = AgentRunEvidence {
            schema_version: AGENT_RUN_SCHEMA_VERSION,
            project_id: Uuid::nil(),
            external_run_id: &first.external_run_id,
            model: &first.model,
            prompt: &first.prompt,
            context: &first.context,
            tool_calls: &first.tool_calls,
            output: &first.output,
            outcome: &first.outcome,
            started_at: first.started_at,
            completed_at: first.completed_at,
            recorded_by: "factory-agent",
            outputs: &first_outputs,
        };
        let second_evidence = AgentRunEvidence {
            schema_version: AGENT_RUN_SCHEMA_VERSION,
            project_id: Uuid::nil(),
            external_run_id: &second.external_run_id,
            model: &second.model,
            prompt: &second.prompt,
            context: &second.context,
            tool_calls: &second.tool_calls,
            output: &second.output,
            outcome: &second.outcome,
            started_at: second.started_at,
            completed_at: second.completed_at,
            recorded_by: "factory-agent",
            outputs: &second_outputs,
        };
        assert_eq!(
            canonical_hash(&first_evidence, "first").expect("first hash"),
            canonical_hash(&second_evidence, "second").expect("second hash")
        );
    }

    #[test]
    fn timestamps_are_normalized_to_postgres_precision_before_signing() {
        let mut value = request(Vec::new());
        value.started_at = "2026-11-14T12:00:00.123456789Z".parse().expect("timestamp");
        value.completed_at = "2026-11-14T12:00:01.987654321Z".parse().expect("timestamp");
        let validated = validate_request(value).expect("valid request");
        assert_eq!(validated.started_at.timestamp_subsec_nanos(), 123_456_000);
        assert_eq!(validated.completed_at.timestamp_subsec_nanos(), 987_654_000);
    }
}
