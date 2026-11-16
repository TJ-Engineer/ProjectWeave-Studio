use std::collections::{HashMap, HashSet};

use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, Utc};
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
const CREATE_CASE_COMMAND: &str = "verification.case.create";
const START_RUN_COMMAND: &str = "verification.run.start";
const RECORD_RESULT_COMMAND: &str = "verification.result.record";
const RESULT_SCHEMA_VERSION: &str = "openrm-verification-result-v1";
const GATE_EVIDENCE_SCHEMA_VERSION: &str = "openrm-gate-evidence-v1";

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CreateVerificationCaseRequest {
    pub review_id: Uuid,
    pub key: String,
    pub title: String,
    pub method: String,
    pub procedure: String,
    pub acceptance_criteria: String,
    pub owner_subject: String,
    pub due_at: Option<DateTime<Utc>>,
    pub target_artifact_ids: Vec<Uuid>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StartVerificationRunRequest {
    #[serde(default)]
    pub execution_note: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct VerificationAttachmentInput {
    pub object_key: String,
    pub file_name: String,
    pub media_type: String,
    pub size_bytes: i64,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RecordVerificationResultRequest {
    pub outcome: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default = "empty_object")]
    pub measured_values: Value,
    #[serde(default)]
    pub attachments: Vec<VerificationAttachmentInput>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GenerateDueEventsRequest {
    pub review_id: Uuid,
}

#[derive(Debug, Deserialize)]
pub struct ReviewQuery {
    pub review_id: Uuid,
}

#[derive(Clone, Debug, Deserialize, FromRow, Serialize)]
pub struct VerificationTargetResponse {
    pub id: Uuid,
    pub artifact_id: Uuid,
    pub artifact_revision_id: Uuid,
    pub artifact_key: String,
}

#[derive(Clone, Debug, Deserialize, FromRow, Serialize)]
pub struct VerificationAttachmentResponse {
    pub id: Uuid,
    pub object_key: String,
    pub file_name: String,
    pub media_type: String,
    pub size_bytes: i64,
    pub sha256: String,
    pub recorded_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct VerificationResultResponse {
    pub id: Uuid,
    pub run_id: Uuid,
    pub outcome: String,
    pub notes: String,
    pub measured_values: Value,
    pub evidence_hash: String,
    pub signature: String,
    pub signing_algorithm: String,
    pub signing_key_id: String,
    pub recorded_by: String,
    pub recorded_at: DateTime<Utc>,
    pub signature_valid: bool,
    pub attachments: Vec<VerificationAttachmentResponse>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct VerificationRunResponse {
    pub id: Uuid,
    pub case_id: Uuid,
    pub sequence: i32,
    pub status: String,
    pub executed_by: String,
    pub started_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    pub result: Option<VerificationResultResponse>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct VerificationCaseResponse {
    pub id: Uuid,
    pub project_id: Uuid,
    pub review_id: Uuid,
    pub baseline_id: Uuid,
    pub sequence: i32,
    pub key: String,
    pub title: String,
    pub method: String,
    pub procedure: String,
    pub acceptance_criteria: String,
    pub owner_subject: String,
    pub due_at: Option<DateTime<Utc>>,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
    pub status: String,
    pub targets: Vec<VerificationTargetResponse>,
    pub runs: Vec<VerificationRunResponse>,
}

#[derive(Debug, Serialize)]
pub struct VerificationCaseListResponse {
    pub items: Vec<VerificationCaseResponse>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct VerificationCoverageItem {
    pub artifact_id: Uuid,
    pub artifact_revision_id: Uuid,
    pub artifact_key: String,
    pub status: String,
    pub case_count: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct VerificationCoverageResponse {
    pub review_id: Uuid,
    pub baseline_id: Uuid,
    pub total_artifacts: i64,
    pub passed_artifacts: i64,
    pub coverage_percent: f64,
    pub items: Vec<VerificationCoverageItem>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GateReadinessResponse {
    pub review_id: Uuid,
    pub review_status: String,
    pub ready: bool,
    pub coverage_percent: f64,
    pub total_cases: i64,
    pub passed_cases: i64,
    pub failed_cases: i64,
    pub blocked_cases: i64,
    pub in_progress_cases: i64,
    pub planned_cases: i64,
    pub open_blocking_comments: i64,
    pub invalid_signatures: i64,
    pub contributors: Vec<String>,
    pub blockers: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, FromRow, Serialize)]
pub struct VerificationDueEventResponse {
    pub id: Uuid,
    pub review_id: Uuid,
    pub case_id: Uuid,
    pub case_key: String,
    pub event_type: String,
    pub due_at: Option<DateTime<Utc>>,
    pub actor_subject: String,
    pub occurred_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct VerificationDueEventListResponse {
    pub items: Vec<VerificationDueEventResponse>,
}

#[derive(Debug, Serialize)]
pub struct GateEvidenceExport {
    pub review_id: Uuid,
    pub project_id: Uuid,
    pub schema_version: &'static str,
    pub manifest: Value,
    pub manifest_hash: String,
    pub signature: String,
    pub signing_algorithm: &'static str,
    pub signing_key_id: String,
    pub signature_valid: bool,
}

#[derive(Debug, FromRow)]
struct ReviewScope {
    id: Uuid,
    baseline_id: Uuid,
    status: String,
    created_by: String,
    baseline_created_by: String,
}

#[derive(Debug, FromRow)]
struct CaseRecord {
    id: Uuid,
    project_id: Uuid,
    review_id: Uuid,
    baseline_id: Uuid,
    sequence: i32,
    key: String,
    title: String,
    method: String,
    procedure: String,
    acceptance_criteria: String,
    owner_subject: String,
    due_at: Option<DateTime<Utc>>,
    created_by: String,
    created_at: DateTime<Utc>,
}

#[derive(Debug, FromRow)]
struct RunRecord {
    id: Uuid,
    case_id: Uuid,
    sequence: i32,
    status: String,
    executed_by: String,
    started_at: DateTime<Utc>,
    completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, FromRow)]
struct ResultRecord {
    id: Uuid,
    run_id: Uuid,
    outcome: String,
    notes: String,
    measured_values: Value,
    evidence_hash: String,
    signature: String,
    signing_algorithm: String,
    signing_key_id: String,
    recorded_by: String,
    recorded_at: DateTime<Utc>,
}

#[derive(Debug, FromRow)]
struct BaselineArtifactRecord {
    artifact_id: Uuid,
    artifact_revision_id: Uuid,
    artifact_key: String,
}

#[derive(Debug, FromRow, Serialize)]
struct DecisionEvidenceRecord {
    id: Uuid,
    participant_id: Uuid,
    round: i32,
    decision: String,
    comment: String,
    evidence_hash: String,
    signature: String,
    signing_algorithm: String,
    signing_key_id: String,
    decided_by: String,
    decided_at: DateTime<Utc>,
    signature_valid: bool,
}

#[derive(Debug, FromRow)]
struct StoredCommand {
    request_fingerprint: String,
    response_payload: Value,
}

#[derive(Serialize)]
struct ResultEvidence<'a> {
    schema_version: &'static str,
    result_id: Uuid,
    run_id: Uuid,
    case_id: Uuid,
    review_id: Uuid,
    baseline_id: Uuid,
    outcome: &'a str,
    notes: &'a str,
    measured_values: &'a Value,
    attachments: &'a [VerificationAttachmentInput],
    recorded_by: &'a str,
}

pub async fn list_cases(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
    Query(query): Query<ReviewQuery>,
) -> Result<Json<VerificationCaseListResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Read).await?;
    fetch_review_scope(&state.db, &principal, project_id, query.review_id).await?;
    let items = load_cases(&state, &principal, project_id, query.review_id).await?;
    Ok(Json(VerificationCaseListResponse { items }))
}

pub async fn create_case(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<CreateVerificationCaseRequest>,
) -> Result<(StatusCode, Json<VerificationCaseResponse>), ApiError> {
    authorize_project(&state, &principal, project_id, Action::Write).await?;
    let request = validate_case_request(request)?;
    let idempotency_key = parse_idempotency_key(&headers)?;
    let fingerprint = fingerprint(&(project_id, &request))?;
    if let Some(response) = replay_command::<VerificationCaseResponse>(
        &state.db,
        &principal,
        CREATE_CASE_COMMAND,
        idempotency_key,
        &fingerprint,
    )
    .await?
    {
        return Ok((StatusCode::OK, Json(response)));
    }

    let mut transaction = state.db.begin().await.map_err(database_error)?;
    let review =
        lock_review_scope(&mut transaction, &principal, project_id, request.review_id).await?;
    if review.status != "approved" {
        return Err(ApiError::conflict(
            "Verification cases require an approved review package",
        ));
    }
    if let Some(response) = replay_command_tx::<VerificationCaseResponse>(
        &mut transaction,
        &principal,
        CREATE_CASE_COMMAND,
        idempotency_key,
        &fingerprint,
    )
    .await?
    {
        return Ok((StatusCode::OK, Json(response)));
    }
    require_verification_owner(
        &mut transaction,
        &principal,
        project_id,
        &request.owner_subject,
    )
    .await?;
    let targets = load_and_validate_targets(
        &mut transaction,
        &principal,
        project_id,
        review.baseline_id,
        &request.target_artifact_ids,
    )
    .await?;
    let sequence = sqlx::query_scalar::<_, Option<i32>>(
        "SELECT max(sequence) FROM verification_cases WHERE organization_id = $1 AND project_id = $2 AND review_id = $3",
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review.id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?
    .unwrap_or(0)
        + 1;
    let case_id = Uuid::new_v4();
    let created_at = sqlx::query_scalar::<_, DateTime<Utc>>(
        r#"
        INSERT INTO verification_cases (
            id, organization_id, project_id, review_id, sequence, key, title,
            method, procedure, acceptance_criteria, owner_subject, due_at, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING created_at
        "#,
    )
    .bind(case_id)
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review.id)
    .bind(sequence)
    .bind(&request.key)
    .bind(&request.title)
    .bind(&request.method)
    .bind(&request.procedure)
    .bind(&request.acceptance_criteria)
    .bind(&request.owner_subject)
    .bind(request.due_at)
    .bind(&principal.subject)
    .fetch_one(&mut *transaction)
    .await
    .map_err(conflict_database_error)?;
    let mut response_targets = Vec::with_capacity(targets.len());
    for target in targets {
        let target_id = Uuid::new_v4();
        sqlx::query(
            r#"
            INSERT INTO verification_case_targets (
                id, organization_id, project_id, review_id, case_id,
                artifact_id, artifact_revision_id, artifact_key
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            "#,
        )
        .bind(target_id)
        .bind(principal.organization_id)
        .bind(project_id)
        .bind(review.id)
        .bind(case_id)
        .bind(target.artifact_id)
        .bind(target.artifact_revision_id)
        .bind(&target.artifact_key)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        response_targets.push(VerificationTargetResponse {
            id: target_id,
            artifact_id: target.artifact_id,
            artifact_revision_id: target.artifact_revision_id,
            artifact_key: target.artifact_key,
        });
    }
    let response = VerificationCaseResponse {
        id: case_id,
        project_id,
        review_id: review.id,
        baseline_id: review.baseline_id,
        sequence,
        key: request.key,
        title: request.title,
        method: request.method,
        procedure: request.procedure,
        acceptance_criteria: request.acceptance_criteria,
        owner_subject: request.owner_subject,
        due_at: request.due_at,
        created_by: principal.subject.clone(),
        created_at,
        status: "planned".to_owned(),
        targets: response_targets,
        runs: Vec::new(),
    };
    insert_audit(
        &mut transaction,
        &principal,
        project_id,
        "verification.case_created",
        "verification_case",
        case_id,
        serde_json::json!({
            "review_id": review.id,
            "baseline_id": review.baseline_id,
            "key": response.key,
            "target_count": response.targets.len()
        }),
    )
    .await?;
    store_command(
        &mut transaction,
        &principal,
        CREATE_CASE_COMMAND,
        idempotency_key,
        &fingerprint,
        "verification_case",
        case_id,
        1,
        &response,
    )
    .await?;
    transaction.commit().await.map_err(database_error)?;
    Ok((StatusCode::CREATED, Json(response)))
}

pub async fn start_run(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path((project_id, case_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(request): Json<StartVerificationRunRequest>,
) -> Result<(StatusCode, Json<VerificationRunResponse>), ApiError> {
    authorize_project(&state, &principal, project_id, Action::Review).await?;
    let execution_note = validate_optional_text(&request.execution_note, 8_000, "execution note")?;
    let idempotency_key = parse_idempotency_key(&headers)?;
    let fingerprint = fingerprint(&(project_id, case_id, &execution_note))?;
    if let Some(response) = replay_command::<VerificationRunResponse>(
        &state.db,
        &principal,
        START_RUN_COMMAND,
        idempotency_key,
        &fingerprint,
    )
    .await?
    {
        return Ok((StatusCode::OK, Json(response)));
    }
    let mut transaction = state.db.begin().await.map_err(database_error)?;
    let (case, review) = lock_case_scope(&mut transaction, &principal, project_id, case_id).await?;
    if review.status != "approved" {
        return Err(ApiError::conflict(
            "Verification runs require an approved review package",
        ));
    }
    require_independent_executor(&mut transaction, &principal, project_id, &case, &review).await?;
    if let Some(response) = replay_command_tx::<VerificationRunResponse>(
        &mut transaction,
        &principal,
        START_RUN_COMMAND,
        idempotency_key,
        &fingerprint,
    )
    .await?
    {
        return Ok((StatusCode::OK, Json(response)));
    }
    let active = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM verification_runs WHERE organization_id = $1 AND project_id = $2 AND case_id = $3 AND status = 'in_progress')",
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(case_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?;
    if active {
        return Err(ApiError::conflict(
            "Verification case already has an active execution",
        ));
    }
    let sequence = sqlx::query_scalar::<_, Option<i32>>(
        "SELECT max(sequence) FROM verification_runs WHERE organization_id = $1 AND project_id = $2 AND case_id = $3",
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(case_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?
    .unwrap_or(0)
        + 1;
    let run_id = Uuid::new_v4();
    let started_at = sqlx::query_scalar::<_, DateTime<Utc>>(
        r#"
        INSERT INTO verification_runs (
            id, organization_id, project_id, review_id, case_id,
            sequence, status, executed_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'in_progress', $7)
        RETURNING started_at
        "#,
    )
    .bind(run_id)
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review.id)
    .bind(case_id)
    .bind(sequence)
    .bind(&principal.subject)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?;
    insert_run_event(
        &mut transaction,
        &principal,
        project_id,
        review.id,
        run_id,
        1,
        "started",
        "in_progress",
        &execution_note,
    )
    .await?;
    let response = VerificationRunResponse {
        id: run_id,
        case_id,
        sequence,
        status: "in_progress".to_owned(),
        executed_by: principal.subject.clone(),
        started_at,
        completed_at: None,
        result: None,
    };
    insert_audit(
        &mut transaction,
        &principal,
        project_id,
        "verification.run_started",
        "verification_run",
        run_id,
        serde_json::json!({ "review_id": review.id, "case_id": case_id, "sequence": sequence }),
    )
    .await?;
    store_command(
        &mut transaction,
        &principal,
        START_RUN_COMMAND,
        idempotency_key,
        &fingerprint,
        "verification_run",
        run_id,
        1,
        &response,
    )
    .await?;
    transaction.commit().await.map_err(database_error)?;
    Ok((StatusCode::CREATED, Json(response)))
}

pub async fn record_result(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path((project_id, run_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(request): Json<RecordVerificationResultRequest>,
) -> Result<(StatusCode, Json<VerificationResultResponse>), ApiError> {
    authorize_project(&state, &principal, project_id, Action::Review).await?;
    let request = validate_result_request(request)?;
    let idempotency_key = parse_idempotency_key(&headers)?;
    let fingerprint = fingerprint(&(project_id, run_id, &request))?;
    if let Some(response) = replay_command::<VerificationResultResponse>(
        &state.db,
        &principal,
        RECORD_RESULT_COMMAND,
        idempotency_key,
        &fingerprint,
    )
    .await?
    {
        return Ok((StatusCode::OK, Json(response)));
    }
    let mut transaction = state.db.begin().await.map_err(database_error)?;
    let (run, case, review) =
        lock_run_scope(&mut transaction, &principal, project_id, run_id).await?;
    if run.status != "in_progress" {
        return Err(ApiError::conflict(
            "Only active verification runs can record a result",
        ));
    }
    if run.executed_by != principal.subject {
        return Err(ApiError::forbidden(
            "Only the attributable run executor can record its result",
        ));
    }
    if let Some(response) = replay_command_tx::<VerificationResultResponse>(
        &mut transaction,
        &principal,
        RECORD_RESULT_COMMAND,
        idempotency_key,
        &fingerprint,
    )
    .await?
    {
        return Ok((StatusCode::OK, Json(response)));
    }
    let result_id = Uuid::new_v4();
    let evidence = ResultEvidence {
        schema_version: RESULT_SCHEMA_VERSION,
        result_id,
        run_id,
        case_id: case.id,
        review_id: review.id,
        baseline_id: review.baseline_id,
        outcome: &request.outcome,
        notes: &request.notes,
        measured_values: &request.measured_values,
        attachments: &request.attachments,
        recorded_by: &principal.subject,
    };
    let evidence_hash = canonical_hash(&evidence, "verification result")?;
    let signature = state.evidence_signer.sign(&evidence_hash);
    let recorded_at = sqlx::query_scalar::<_, DateTime<Utc>>(
        r#"
        INSERT INTO verification_results (
            id, organization_id, project_id, review_id, run_id, outcome,
            notes, measured_values, evidence_hash, signature,
            signing_algorithm, signing_key_id, recorded_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING recorded_at
        "#,
    )
    .bind(result_id)
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review.id)
    .bind(run_id)
    .bind(&request.outcome)
    .bind(&request.notes)
    .bind(&request.measured_values)
    .bind(&evidence_hash)
    .bind(&signature)
    .bind(EvidenceSigner::ALGORITHM)
    .bind(state.evidence_signer.key_id())
    .bind(&principal.subject)
    .fetch_one(&mut *transaction)
    .await
    .map_err(conflict_database_error)?;
    let mut attachments = Vec::with_capacity(request.attachments.len());
    for attachment in &request.attachments {
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(&attachment.object_key)
            .execute(&mut *transaction)
            .await
            .map_err(database_error)?;
        let attachment_id = Uuid::new_v4();
        let recorded_at = sqlx::query_scalar::<_, DateTime<Utc>>(
            r#"
            INSERT INTO verification_attachments (
                id, organization_id, project_id, review_id, result_id,
                object_key, file_name, media_type, size_bytes, sha256
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING recorded_at
            "#,
        )
        .bind(attachment_id)
        .bind(principal.organization_id)
        .bind(project_id)
        .bind(review.id)
        .bind(result_id)
        .bind(&attachment.object_key)
        .bind(&attachment.file_name)
        .bind(&attachment.media_type)
        .bind(attachment.size_bytes)
        .bind(&attachment.sha256)
        .fetch_one(&mut *transaction)
        .await
        .map_err(conflict_database_error)?;
        attachments.push(VerificationAttachmentResponse {
            id: attachment_id,
            object_key: attachment.object_key.clone(),
            file_name: attachment.file_name.clone(),
            media_type: attachment.media_type.clone(),
            size_bytes: attachment.size_bytes,
            sha256: attachment.sha256.clone(),
            recorded_at,
        });
    }
    let completed_at = sqlx::query_scalar::<_, DateTime<Utc>>(
        r#"
        UPDATE verification_runs
        SET status = $4, completed_at = now()
        WHERE organization_id = $1 AND project_id = $2 AND id = $3
        RETURNING completed_at
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(run_id)
    .bind(&request.outcome)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?;
    insert_run_event(
        &mut transaction,
        &principal,
        project_id,
        review.id,
        run_id,
        2,
        "completed",
        &request.outcome,
        &request.notes,
    )
    .await?;
    sqlx::query(
        r#"
        INSERT INTO verification_due_events (
            id, organization_id, project_id, review_id, case_id,
            event_type, due_at, actor_subject
        )
        VALUES ($1, $2, $3, $4, $5, 'completed', $6, $7)
        ON CONFLICT (organization_id, project_id, review_id, case_id, event_type) DO NOTHING
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review.id)
    .bind(case.id)
    .bind(case.due_at)
    .bind(&principal.subject)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    let response = VerificationResultResponse {
        id: result_id,
        run_id,
        outcome: request.outcome,
        notes: request.notes,
        measured_values: request.measured_values,
        evidence_hash,
        signature,
        signing_algorithm: EvidenceSigner::ALGORITHM.to_owned(),
        signing_key_id: state.evidence_signer.key_id().to_owned(),
        recorded_by: principal.subject.clone(),
        recorded_at,
        signature_valid: true,
        attachments,
    };
    insert_audit(
        &mut transaction,
        &principal,
        project_id,
        "verification.result_recorded",
        "verification_result",
        result_id,
        serde_json::json!({
            "review_id": review.id,
            "case_id": case.id,
            "run_id": run_id,
            "outcome": response.outcome,
            "evidence_hash": response.evidence_hash,
            "signature": response.signature,
            "attachment_count": response.attachments.len(),
            "completed_at": completed_at
        }),
    )
    .await?;
    store_command(
        &mut transaction,
        &principal,
        RECORD_RESULT_COMMAND,
        idempotency_key,
        &fingerprint,
        "verification_result",
        result_id,
        1,
        &response,
    )
    .await?;
    transaction.commit().await.map_err(database_error)?;
    Ok((StatusCode::CREATED, Json(response)))
}

pub async fn get_coverage(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
    Query(query): Query<ReviewQuery>,
) -> Result<Json<VerificationCoverageResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Read).await?;
    Ok(Json(
        calculate_coverage(&state, &principal, project_id, query.review_id).await?,
    ))
}

pub async fn get_readiness(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
    Query(query): Query<ReviewQuery>,
) -> Result<Json<GateReadinessResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Read).await?;
    Ok(Json(
        calculate_readiness(&state, &principal, project_id, query.review_id).await?,
    ))
}

pub async fn list_due_events(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
    Query(query): Query<ReviewQuery>,
) -> Result<Json<VerificationDueEventListResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Read).await?;
    fetch_review_scope(&state.db, &principal, project_id, query.review_id).await?;
    Ok(Json(VerificationDueEventListResponse {
        items: load_due_events(&state.db, &principal, project_id, query.review_id).await?,
    }))
}

pub async fn generate_due_events(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
    Json(request): Json<GenerateDueEventsRequest>,
) -> Result<(StatusCode, Json<VerificationDueEventListResponse>), ApiError> {
    authorize_project(&state, &principal, project_id, Action::Write).await?;
    fetch_review_scope(&state.db, &principal, project_id, request.review_id).await?;
    let mut transaction = state.db.begin().await.map_err(database_error)?;
    let inserted = sqlx::query_as::<_, VerificationDueEventResponse>(
        r#"
        WITH candidates AS (
            SELECT c.id AS case_id, c.key AS case_key, c.review_id, c.due_at,
                   CASE
                       WHEN c.due_at < now() THEN 'overdue'
                       ELSE 'due_soon'
                   END AS event_type
            FROM verification_cases c
            WHERE c.organization_id = $1 AND c.project_id = $2 AND c.review_id = $3
              AND c.due_at IS NOT NULL
              AND c.due_at <= now() + interval '7 days'
              AND NOT EXISTS (
                  SELECT 1
                  FROM verification_runs run
                  JOIN verification_results result
                    ON result.organization_id = run.organization_id
                   AND result.project_id = run.project_id
                   AND result.review_id = run.review_id
                   AND result.run_id = run.id
                  WHERE run.organization_id = c.organization_id
                    AND run.project_id = c.project_id
                    AND run.review_id = c.review_id
                    AND run.case_id = c.id
                    AND result.outcome = 'passed'
              )
        ), inserted AS (
            INSERT INTO verification_due_events (
                id, organization_id, project_id, review_id, case_id,
                event_type, due_at, actor_subject
            )
            SELECT gen_random_uuid(), $1, $2, candidate.review_id,
                   candidate.case_id, candidate.event_type, candidate.due_at, $4
            FROM candidates candidate
            ON CONFLICT (organization_id, project_id, review_id, case_id, event_type) DO NOTHING
            RETURNING id, review_id, case_id, event_type, due_at, actor_subject, occurred_at
        )
        SELECT inserted.id, inserted.review_id, inserted.case_id, candidate.case_key,
               inserted.event_type, inserted.due_at, inserted.actor_subject, inserted.occurred_at
        FROM inserted
        JOIN candidates candidate ON candidate.case_id = inserted.case_id
        ORDER BY inserted.occurred_at, inserted.id
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(request.review_id)
    .bind(&principal.subject)
    .fetch_all(&mut *transaction)
    .await
    .map_err(database_error)?;
    for event in &inserted {
        insert_audit(
            &mut transaction,
            &principal,
            project_id,
            "verification.due_event_emitted",
            "verification_due_event",
            event.id,
            serde_json::json!({
                "review_id": event.review_id,
                "case_id": event.case_id,
                "event_type": event.event_type,
                "due_at": event.due_at
            }),
        )
        .await?;
    }
    transaction.commit().await.map_err(database_error)?;
    Ok((
        StatusCode::CREATED,
        Json(VerificationDueEventListResponse { items: inserted }),
    ))
}

pub async fn export_gate_evidence(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path((project_id, review_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<GateEvidenceExport>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Read).await?;
    let review = fetch_review_scope(&state.db, &principal, project_id, review_id).await?;
    let cases = load_cases(&state, &principal, project_id, review_id).await?;
    let coverage = calculate_coverage(&state, &principal, project_id, review_id).await?;
    let readiness = calculate_readiness(&state, &principal, project_id, review_id).await?;
    let due_events = load_due_events(&state.db, &principal, project_id, review_id).await?;
    let mut decisions = sqlx::query_as::<_, DecisionEvidenceRecord>(
        r#"
        SELECT d.id, d.participant_id, d.round, d.decision, d.comment,
               d.evidence_hash, d.signature, d.signing_algorithm, d.signing_key_id,
               d.decided_by, d.decided_at, false AS signature_valid
        FROM review_decisions d
        WHERE d.organization_id = $1 AND d.project_id = $2 AND d.review_id = $3
        ORDER BY d.round, d.decided_at, d.id
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review_id)
    .fetch_all(&state.db)
    .await
    .map_err(database_error)?;
    for decision in &mut decisions {
        decision.signature_valid = state.evidence_signer.verify_with_key_id(
            &decision.signing_key_id,
            &decision.evidence_hash,
            &decision.signature,
        );
    }
    let review_participants = sqlx::query_scalar::<_, Value>(
        r#"
        SELECT jsonb_build_object(
            'id', participant.id,
            'subject', participant.subject,
            'role_label', participant.role_label,
            'required', participant.required,
            'assigned_by', participant.assigned_by,
            'created_at', participant.created_at
        )
        FROM review_participants participant
        WHERE participant.organization_id = $1 AND participant.project_id = $2
          AND participant.review_id = $3
        ORDER BY participant.created_at, participant.id
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review_id)
    .fetch_all(&state.db)
    .await
    .map_err(database_error)?;
    let review_comments = sqlx::query_scalar::<_, Value>(
        r#"
        SELECT jsonb_build_object(
            'id', comment.id,
            'target_artifact_id', comment.target_artifact_id,
            'target_revision_id', comment.target_revision_id,
            'body', comment.body,
            'blocking', comment.blocking,
            'created_by', comment.created_by,
            'created_at', comment.created_at,
            'resolution', CASE WHEN resolution.id IS NULL THEN NULL ELSE jsonb_build_object(
                'id', resolution.id,
                'resolution', resolution.resolution,
                'resolved_by', resolution.resolved_by,
                'resolved_at', resolution.resolved_at
            ) END
        )
        FROM review_comments comment
        LEFT JOIN review_comment_resolutions resolution
          ON resolution.organization_id = comment.organization_id
         AND resolution.project_id = comment.project_id
         AND resolution.review_id = comment.review_id
         AND resolution.comment_id = comment.id
        WHERE comment.organization_id = $1 AND comment.project_id = $2
          AND comment.review_id = $3
        ORDER BY comment.created_at, comment.id
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review_id)
    .fetch_all(&state.db)
    .await
    .map_err(database_error)?;
    let review_events = sqlx::query_scalar::<_, Value>(
        r#"
        SELECT jsonb_build_object(
            'id', event.id,
            'version', event.version,
            'round', event.round,
            'event_type', event.event_type,
            'status', event.status,
            'rationale', event.rationale,
            'actor_subject', event.actor_subject,
            'occurred_at', event.occurred_at
        )
        FROM review_package_events event
        WHERE event.organization_id = $1 AND event.project_id = $2
          AND event.review_id = $3
        ORDER BY event.version, event.id
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review_id)
    .fetch_all(&state.db)
    .await
    .map_err(database_error)?;
    let manifest = serde_json::json!({
        "review": {
            "id": review.id,
            "baseline_id": review.baseline_id,
            "status": review.status,
            "created_by": review.created_by,
            "baseline_created_by": review.baseline_created_by,
            "participants": review_participants,
            "comments": review_comments,
            "events": review_events,
        },
        "decisions": decisions,
        "verification_cases": cases,
        "coverage": coverage,
        "readiness": readiness,
        "due_events": due_events,
    });
    let manifest_hash = canonical_hash(&manifest, "gate evidence manifest")?;
    let signature = state.evidence_signer.sign(&manifest_hash);
    Ok(Json(GateEvidenceExport {
        review_id,
        project_id,
        schema_version: GATE_EVIDENCE_SCHEMA_VERSION,
        manifest,
        manifest_hash: manifest_hash.clone(),
        signature: signature.clone(),
        signing_algorithm: EvidenceSigner::ALGORITHM,
        signing_key_id: state.evidence_signer.key_id().to_owned(),
        signature_valid: state.evidence_signer.verify(&manifest_hash, &signature),
    }))
}

async fn load_cases(
    state: &AppState,
    principal: &Principal,
    project_id: Uuid,
    review_id: Uuid,
) -> Result<Vec<VerificationCaseResponse>, ApiError> {
    let records = sqlx::query_as::<_, CaseRecord>(
        r#"
        SELECT c.id, c.project_id, c.review_id, rp.baseline_id, c.sequence,
               c.key, c.title, c.method, c.procedure, c.acceptance_criteria,
               c.owner_subject, c.due_at, c.created_by, c.created_at
        FROM verification_cases c
        JOIN review_packages rp
          ON rp.organization_id = c.organization_id
         AND rp.project_id = c.project_id
         AND rp.id = c.review_id
        WHERE c.organization_id = $1 AND c.project_id = $2 AND c.review_id = $3
        ORDER BY c.sequence, c.id
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review_id)
    .fetch_all(&state.db)
    .await
    .map_err(database_error)?;
    let mut items = Vec::with_capacity(records.len());
    for record in records {
        items.push(load_case_response(state, principal, record).await?);
    }
    Ok(items)
}

async fn load_case_response(
    state: &AppState,
    principal: &Principal,
    record: CaseRecord,
) -> Result<VerificationCaseResponse, ApiError> {
    let targets = sqlx::query_as::<_, VerificationTargetResponse>(
        r#"
        SELECT id, artifact_id, artifact_revision_id, artifact_key
        FROM verification_case_targets
        WHERE organization_id = $1 AND project_id = $2 AND review_id = $3 AND case_id = $4
        ORDER BY artifact_key, artifact_id
        "#,
    )
    .bind(principal.organization_id)
    .bind(record.project_id)
    .bind(record.review_id)
    .bind(record.id)
    .fetch_all(&state.db)
    .await
    .map_err(database_error)?;
    let run_records = sqlx::query_as::<_, RunRecord>(
        r#"
        SELECT id, case_id, sequence, status, executed_by, started_at, completed_at
        FROM verification_runs
        WHERE organization_id = $1 AND project_id = $2 AND review_id = $3 AND case_id = $4
        ORDER BY sequence DESC, id
        "#,
    )
    .bind(principal.organization_id)
    .bind(record.project_id)
    .bind(record.review_id)
    .bind(record.id)
    .fetch_all(&state.db)
    .await
    .map_err(database_error)?;
    let mut runs = Vec::with_capacity(run_records.len());
    for run in run_records {
        let result = load_result(
            state,
            principal,
            record.project_id,
            record.review_id,
            run.id,
        )
        .await?;
        runs.push(VerificationRunResponse {
            id: run.id,
            case_id: run.case_id,
            sequence: run.sequence,
            status: run.status,
            executed_by: run.executed_by,
            started_at: run.started_at,
            completed_at: run.completed_at,
            result,
        });
    }
    let status = runs
        .first()
        .map(|run| run.status.clone())
        .unwrap_or_else(|| "planned".to_owned());
    Ok(VerificationCaseResponse {
        id: record.id,
        project_id: record.project_id,
        review_id: record.review_id,
        baseline_id: record.baseline_id,
        sequence: record.sequence,
        key: record.key,
        title: record.title,
        method: record.method,
        procedure: record.procedure,
        acceptance_criteria: record.acceptance_criteria,
        owner_subject: record.owner_subject,
        due_at: record.due_at,
        created_by: record.created_by,
        created_at: record.created_at,
        status,
        targets,
        runs,
    })
}

async fn load_result(
    state: &AppState,
    principal: &Principal,
    project_id: Uuid,
    review_id: Uuid,
    run_id: Uuid,
) -> Result<Option<VerificationResultResponse>, ApiError> {
    let record = sqlx::query_as::<_, ResultRecord>(
        r#"
        SELECT id, run_id, outcome, notes, measured_values, evidence_hash,
               signature, signing_algorithm, signing_key_id, recorded_by, recorded_at
        FROM verification_results
        WHERE organization_id = $1 AND project_id = $2 AND review_id = $3 AND run_id = $4
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review_id)
    .bind(run_id)
    .fetch_optional(&state.db)
    .await
    .map_err(database_error)?;
    let Some(record) = record else {
        return Ok(None);
    };
    let attachments = sqlx::query_as::<_, VerificationAttachmentResponse>(
        r#"
        SELECT id, object_key, file_name, media_type, size_bytes, sha256, recorded_at
        FROM verification_attachments
        WHERE organization_id = $1 AND project_id = $2 AND review_id = $3 AND result_id = $4
        ORDER BY object_key, id
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review_id)
    .bind(record.id)
    .fetch_all(&state.db)
    .await
    .map_err(database_error)?;
    let signature_valid = state.evidence_signer.verify_with_key_id(
        &record.signing_key_id,
        &record.evidence_hash,
        &record.signature,
    );
    Ok(Some(VerificationResultResponse {
        id: record.id,
        run_id: record.run_id,
        outcome: record.outcome,
        notes: record.notes,
        measured_values: record.measured_values,
        evidence_hash: record.evidence_hash.clone(),
        signature: record.signature.clone(),
        signing_algorithm: record.signing_algorithm,
        signing_key_id: record.signing_key_id,
        recorded_by: record.recorded_by,
        recorded_at: record.recorded_at,
        signature_valid,
        attachments,
    }))
}

async fn calculate_coverage(
    state: &AppState,
    principal: &Principal,
    project_id: Uuid,
    review_id: Uuid,
) -> Result<VerificationCoverageResponse, ApiError> {
    let review = fetch_review_scope(&state.db, principal, project_id, review_id).await?;
    let artifacts = sqlx::query_as::<_, BaselineArtifactRecord>(
        r#"
        SELECT artifact_id, artifact_revision_id, artifact_key
        FROM baseline_artifacts
        WHERE organization_id = $1 AND project_id = $2 AND baseline_id = $3
        ORDER BY artifact_key, artifact_id
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review.baseline_id)
    .fetch_all(&state.db)
    .await
    .map_err(database_error)?;
    let cases = load_cases(state, principal, project_id, review_id).await?;
    let mut case_statuses: HashMap<Uuid, Vec<String>> = HashMap::new();
    for case in &cases {
        for target in &case.targets {
            case_statuses
                .entry(target.artifact_id)
                .or_default()
                .push(case.status.clone());
        }
    }
    let mut passed_artifacts = 0_i64;
    let items = artifacts
        .into_iter()
        .map(|artifact| {
            let statuses = case_statuses
                .remove(&artifact.artifact_id)
                .unwrap_or_default();
            let status = aggregate_status(&statuses);
            if status == "passed" {
                passed_artifacts += 1;
            }
            VerificationCoverageItem {
                artifact_id: artifact.artifact_id,
                artifact_revision_id: artifact.artifact_revision_id,
                artifact_key: artifact.artifact_key,
                status,
                case_count: statuses.len() as i64,
            }
        })
        .collect::<Vec<_>>();
    let total_artifacts = items.len() as i64;
    let coverage_percent = if total_artifacts == 0 {
        0.0
    } else {
        ((passed_artifacts as f64 / total_artifacts as f64) * 10_000.0).round() / 100.0
    };
    Ok(VerificationCoverageResponse {
        review_id,
        baseline_id: review.baseline_id,
        total_artifacts,
        passed_artifacts,
        coverage_percent,
        items,
    })
}

async fn calculate_readiness(
    state: &AppState,
    principal: &Principal,
    project_id: Uuid,
    review_id: Uuid,
) -> Result<GateReadinessResponse, ApiError> {
    let review = fetch_review_scope(&state.db, principal, project_id, review_id).await?;
    let coverage = calculate_coverage(state, principal, project_id, review_id).await?;
    let cases = load_cases(state, principal, project_id, review_id).await?;
    let open_blocking_comments = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT count(*)
        FROM review_comments comment
        LEFT JOIN review_comment_resolutions resolution
          ON resolution.organization_id = comment.organization_id
         AND resolution.project_id = comment.project_id
         AND resolution.review_id = comment.review_id
         AND resolution.comment_id = comment.id
        WHERE comment.organization_id = $1 AND comment.project_id = $2
          AND comment.review_id = $3 AND comment.blocking AND resolution.id IS NULL
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review_id)
    .fetch_one(&state.db)
    .await
    .map_err(database_error)?;
    let invalid_review_signatures = sqlx::query_as::<_, (String, String, String)>(
        r#"
        SELECT signing_key_id, evidence_hash, signature FROM review_decisions
        WHERE organization_id = $1 AND project_id = $2 AND review_id = $3
        ORDER BY id
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review_id)
    .fetch_all(&state.db)
    .await
    .map_err(database_error)?
    .into_iter()
    .filter(|(key_id, hash, signature)| {
        !state
            .evidence_signer
            .verify_with_key_id(key_id, hash, signature)
    })
    .count() as i64;
    let invalid_result_signatures = cases
        .iter()
        .flat_map(|case| &case.runs)
        .filter_map(|run| run.result.as_ref())
        .filter(|result| !result.signature_valid)
        .count() as i64;
    let invalid_signatures = invalid_review_signatures + invalid_result_signatures;
    let status_count =
        |status: &str| cases.iter().filter(|case| case.status == status).count() as i64;
    let total_cases = cases.len() as i64;
    let passed_cases = status_count("passed");
    let failed_cases = status_count("failed");
    let blocked_cases = status_count("blocked");
    let in_progress_cases = status_count("in_progress");
    let planned_cases = status_count("planned");
    let mut contributors = vec![
        format!("Review status: {}", review.status),
        format!(
            "Passed verification coverage: {:.2}%",
            coverage.coverage_percent
        ),
        format!("Verification cases: {passed_cases}/{total_cases} passed"),
        format!("Open blocking review comments: {open_blocking_comments}"),
        format!("Invalid evidence signatures: {invalid_signatures}"),
    ];
    contributors.sort();
    let mut blockers = Vec::new();
    if review.status != "approved" {
        blockers.push("Review package is not approved".to_owned());
    }
    if total_cases == 0 {
        blockers.push("No verification cases exist".to_owned());
    }
    if coverage.coverage_percent < 100.0 {
        blockers.push(format!(
            "Verification coverage is {:.2}% rather than 100%",
            coverage.coverage_percent
        ));
    }
    if failed_cases > 0 {
        blockers.push(format!("{failed_cases} verification cases failed"));
    }
    if blocked_cases > 0 {
        blockers.push(format!("{blocked_cases} verification cases are blocked"));
    }
    if in_progress_cases > 0 {
        blockers.push(format!(
            "{in_progress_cases} verification cases are in progress"
        ));
    }
    if planned_cases > 0 {
        blockers.push(format!(
            "{planned_cases} verification cases are not executed"
        ));
    }
    if open_blocking_comments > 0 {
        blockers.push(format!(
            "{open_blocking_comments} blocking review comments remain open"
        ));
    }
    if invalid_signatures > 0 {
        blockers.push(format!(
            "{invalid_signatures} evidence signatures are invalid"
        ));
    }
    blockers.sort();
    Ok(GateReadinessResponse {
        review_id,
        review_status: review.status,
        ready: blockers.is_empty(),
        coverage_percent: coverage.coverage_percent,
        total_cases,
        passed_cases,
        failed_cases,
        blocked_cases,
        in_progress_cases,
        planned_cases,
        open_blocking_comments,
        invalid_signatures,
        contributors,
        blockers,
    })
}

fn aggregate_status(statuses: &[String]) -> String {
    for status in ["failed", "blocked", "in_progress", "planned", "passed"] {
        if statuses.iter().any(|candidate| candidate == status) {
            return status.to_owned();
        }
    }
    "unverified".to_owned()
}

async fn load_due_events(
    pool: &PgPool,
    principal: &Principal,
    project_id: Uuid,
    review_id: Uuid,
) -> Result<Vec<VerificationDueEventResponse>, ApiError> {
    sqlx::query_as::<_, VerificationDueEventResponse>(
        r#"
        SELECT event.id, event.review_id, event.case_id, case_record.key AS case_key,
               event.event_type, event.due_at, event.actor_subject, event.occurred_at
        FROM verification_due_events event
        JOIN verification_cases case_record
          ON case_record.organization_id = event.organization_id
         AND case_record.project_id = event.project_id
         AND case_record.review_id = event.review_id
         AND case_record.id = event.case_id
        WHERE event.organization_id = $1 AND event.project_id = $2 AND event.review_id = $3
        ORDER BY event.occurred_at, event.id
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review_id)
    .fetch_all(pool)
    .await
    .map_err(database_error)
}

async fn fetch_review_scope(
    pool: &PgPool,
    principal: &Principal,
    project_id: Uuid,
    review_id: Uuid,
) -> Result<ReviewScope, ApiError> {
    sqlx::query_as::<_, ReviewScope>(review_scope_sql(false))
        .bind(principal.organization_id)
        .bind(project_id)
        .bind(review_id)
        .fetch_optional(pool)
        .await
        .map_err(database_error)?
        .ok_or_else(|| ApiError::not_found("Review package does not exist"))
}

async fn lock_review_scope(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    project_id: Uuid,
    review_id: Uuid,
) -> Result<ReviewScope, ApiError> {
    sqlx::query_as::<_, ReviewScope>(review_scope_sql(true))
        .bind(principal.organization_id)
        .bind(project_id)
        .bind(review_id)
        .fetch_optional(&mut **transaction)
        .await
        .map_err(database_error)?
        .ok_or_else(|| ApiError::not_found("Review package does not exist"))
}

fn review_scope_sql(lock: bool) -> &'static str {
    if lock {
        r#"
        SELECT rp.id, rp.baseline_id, rp.status, rp.created_by,
               baseline.created_by AS baseline_created_by
        FROM review_packages rp
        JOIN baselines baseline
          ON baseline.organization_id = rp.organization_id
         AND baseline.project_id = rp.project_id
         AND baseline.id = rp.baseline_id
        WHERE rp.organization_id = $1 AND rp.project_id = $2 AND rp.id = $3
        FOR UPDATE OF rp
        "#
    } else {
        r#"
        SELECT rp.id, rp.baseline_id, rp.status, rp.created_by,
               baseline.created_by AS baseline_created_by
        FROM review_packages rp
        JOIN baselines baseline
          ON baseline.organization_id = rp.organization_id
         AND baseline.project_id = rp.project_id
         AND baseline.id = rp.baseline_id
        WHERE rp.organization_id = $1 AND rp.project_id = $2 AND rp.id = $3
        "#
    }
}

async fn lock_case_scope(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    project_id: Uuid,
    case_id: Uuid,
) -> Result<(CaseRecord, ReviewScope), ApiError> {
    let case = sqlx::query_as::<_, CaseRecord>(
        r#"
        SELECT c.id, c.project_id, c.review_id, rp.baseline_id, c.sequence,
               c.key, c.title, c.method, c.procedure, c.acceptance_criteria,
               c.owner_subject, c.due_at, c.created_by, c.created_at
        FROM verification_cases c
        JOIN review_packages rp
          ON rp.organization_id = c.organization_id
         AND rp.project_id = c.project_id
         AND rp.id = c.review_id
        WHERE c.organization_id = $1 AND c.project_id = $2 AND c.id = $3
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(case_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(database_error)?
    .ok_or_else(|| ApiError::not_found("Verification case does not exist"))?;
    let review = lock_review_scope(transaction, principal, project_id, case.review_id).await?;
    Ok((case, review))
}

async fn lock_run_scope(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    project_id: Uuid,
    run_id: Uuid,
) -> Result<(RunRecord, CaseRecord, ReviewScope), ApiError> {
    let run = sqlx::query_as::<_, RunRecord>(
        r#"
        SELECT id, case_id, sequence, status, executed_by, started_at, completed_at
        FROM verification_runs
        WHERE organization_id = $1 AND project_id = $2 AND id = $3
        FOR UPDATE
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(run_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(database_error)?
    .ok_or_else(|| ApiError::not_found("Verification run does not exist"))?;
    let (case, review) = lock_case_scope(transaction, principal, project_id, run.case_id).await?;
    Ok((run, case, review))
}

async fn require_verification_owner(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    project_id: Uuid,
    owner_subject: &str,
) -> Result<(), ApiError> {
    let role = sqlx::query_scalar::<_, String>(
        r#"
        SELECT role FROM project_memberships
        WHERE organization_id = $1 AND project_id = $2 AND subject = $3
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(owner_subject)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(database_error)?
    .ok_or_else(|| ApiError::bad_request("Verification owner is not a project member"))?;
    if !matches!(role.as_str(), "reviewer" | "administrator") {
        return Err(ApiError::bad_request(
            "Verification owners must have reviewer or administrator project role",
        ));
    }
    Ok(())
}

async fn require_independent_executor(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    project_id: Uuid,
    case: &CaseRecord,
    review: &ReviewScope,
) -> Result<(), ApiError> {
    if principal.subject != case.owner_subject {
        return Err(ApiError::forbidden(
            "Only the assigned verification owner can execute this case",
        ));
    }
    if principal.subject == review.created_by || principal.subject == review.baseline_created_by {
        return Err(ApiError::forbidden(
            "Segregation of duties prevents review or baseline authors from executing verification",
        ));
    }
    let assigned = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM review_participants
            WHERE organization_id = $1 AND project_id = $2
              AND review_id = $3 AND subject = $4
        )
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review.id)
    .bind(&principal.subject)
    .fetch_one(&mut **transaction)
    .await
    .map_err(database_error)?;
    if !assigned {
        return Err(ApiError::forbidden(
            "Verification executor must be assigned to the source review package",
        ));
    }
    Ok(())
}

async fn load_and_validate_targets(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    project_id: Uuid,
    baseline_id: Uuid,
    target_artifact_ids: &[Uuid],
) -> Result<Vec<BaselineArtifactRecord>, ApiError> {
    let targets = sqlx::query_as::<_, BaselineArtifactRecord>(
        r#"
        SELECT artifact_id, artifact_revision_id, artifact_key
        FROM baseline_artifacts
        WHERE organization_id = $1 AND project_id = $2 AND baseline_id = $3
          AND artifact_id = ANY($4)
        ORDER BY artifact_key, artifact_id
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(baseline_id)
    .bind(target_artifact_ids)
    .fetch_all(&mut **transaction)
    .await
    .map_err(database_error)?;
    if targets.len() != target_artifact_ids.len() {
        return Err(ApiError::bad_request(
            "Every verification target must exist in the review baseline",
        ));
    }
    Ok(targets)
}

#[allow(clippy::too_many_arguments)]
async fn insert_run_event(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    project_id: Uuid,
    review_id: Uuid,
    run_id: Uuid,
    version: i32,
    event_type: &str,
    status: &str,
    note: &str,
) -> Result<(), ApiError> {
    sqlx::query(
        r#"
        INSERT INTO verification_run_events (
            id, organization_id, project_id, review_id, run_id,
            version, event_type, status, note, actor_subject
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review_id)
    .bind(run_id)
    .bind(version)
    .bind(event_type)
    .bind(status)
    .bind(note)
    .bind(&principal.subject)
    .execute(&mut **transaction)
    .await
    .map_err(database_error)?;
    Ok(())
}

fn validate_case_request(
    mut request: CreateVerificationCaseRequest,
) -> Result<CreateVerificationCaseRequest, ApiError> {
    request.key = request.key.trim().to_ascii_uppercase();
    if request.key.len() < 2
        || request.key.len() > 64
        || !request
            .key
            .starts_with(|character: char| character.is_ascii_uppercase())
        || !request.key.bytes().all(|byte| {
            byte.is_ascii_uppercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
    {
        return Err(ApiError::bad_request("verification case key is invalid"));
    }
    request.title = validate_required_text(&request.title, 200, "verification title")?;
    request.method = request.method.trim().to_ascii_lowercase();
    if !matches!(
        request.method.as_str(),
        "analysis" | "inspection" | "demonstration" | "test"
    ) {
        return Err(ApiError::bad_request("verification method is invalid"));
    }
    request.procedure = validate_required_text(&request.procedure, 8_000, "procedure")?;
    request.acceptance_criteria =
        validate_required_text(&request.acceptance_criteria, 4_000, "acceptance criteria")?;
    request.owner_subject =
        validate_required_text(&request.owner_subject, 200, "verification owner")?;
    request.target_artifact_ids.sort();
    request.target_artifact_ids.dedup();
    if request.target_artifact_ids.is_empty() || request.target_artifact_ids.len() > 500 {
        return Err(ApiError::bad_request(
            "target_artifact_ids must contain 1-500 unique baseline artifacts",
        ));
    }
    Ok(request)
}

fn validate_result_request(
    mut request: RecordVerificationResultRequest,
) -> Result<RecordVerificationResultRequest, ApiError> {
    request.outcome = request.outcome.trim().to_ascii_lowercase();
    if !matches!(request.outcome.as_str(), "passed" | "failed" | "blocked") {
        return Err(ApiError::bad_request(
            "verification outcome must be passed, failed, or blocked",
        ));
    }
    request.notes = validate_optional_text(&request.notes, 8_000, "result notes")?;
    if request.outcome != "passed" && request.notes.is_empty() {
        return Err(ApiError::bad_request(
            "failed or blocked results require explanatory notes",
        ));
    }
    if !request.measured_values.is_object() {
        return Err(ApiError::bad_request("measured_values must be an object"));
    }
    if request.attachments.len() > 20 {
        return Err(ApiError::bad_request(
            "verification results support at most 20 attachments",
        ));
    }
    let mut object_keys = HashSet::new();
    for attachment in &mut request.attachments {
        attachment.object_key =
            validate_required_text(&attachment.object_key, 512, "attachment object key")?;
        attachment.file_name =
            validate_required_text(&attachment.file_name, 255, "attachment file name")?;
        attachment.media_type =
            validate_required_text(&attachment.media_type, 127, "attachment media type")?;
        attachment.sha256 = attachment.sha256.trim().to_ascii_lowercase();
        if attachment.size_bytes < 0 {
            return Err(ApiError::bad_request(
                "attachment size_bytes cannot be negative",
            ));
        }
        if attachment.sha256.len() != 64
            || !attachment
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(ApiError::bad_request(
                "attachment sha256 must be 64 hexadecimal characters",
            ));
        }
        if !object_keys.insert(attachment.object_key.clone()) {
            return Err(ApiError::bad_request(
                "attachment object keys must be unique within a result",
            ));
        }
    }
    request
        .attachments
        .sort_by(|left, right| left.object_key.cmp(&right.object_key));
    Ok(request)
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

fn validate_optional_text(value: &str, max: usize, label: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if value.chars().count() > max {
        return Err(ApiError::bad_request(format!(
            "{label} must not exceed {max} characters"
        )));
    }
    Ok(value.to_owned())
}

fn empty_object() -> Value {
    Value::Object(Default::default())
}

fn canonical_hash<T: Serialize>(value: &T, label: &str) -> Result<String, ApiError> {
    let bytes = serde_json::to_vec(value)
        .map_err(|_| ApiError::internal(format!("Could not serialize {label}")))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn fingerprint<T: Serialize>(value: &T) -> Result<String, ApiError> {
    serde_json::to_string(value)
        .map_err(|_| ApiError::internal("Could not fingerprint verification command"))
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
    command_name: &str,
    idempotency_key: &str,
) -> Result<Option<StoredCommand>, ApiError> {
    sqlx::query_as::<_, StoredCommand>(
        r#"
        SELECT request_fingerprint, response_payload FROM command_results
        WHERE organization_id = $1 AND actor_subject = $2
          AND command_name = $3 AND idempotency_key = $4
        "#,
    )
    .bind(principal.organization_id)
    .bind(&principal.subject)
    .bind(command_name)
    .bind(idempotency_key)
    .fetch_optional(pool)
    .await
    .map_err(database_error)
}

async fn find_command_tx(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    command_name: &str,
    idempotency_key: &str,
) -> Result<Option<StoredCommand>, ApiError> {
    sqlx::query_as::<_, StoredCommand>(
        r#"
        SELECT request_fingerprint, response_payload FROM command_results
        WHERE organization_id = $1 AND actor_subject = $2
          AND command_name = $3 AND idempotency_key = $4
        "#,
    )
    .bind(principal.organization_id)
    .bind(&principal.subject)
    .bind(command_name)
    .bind(idempotency_key)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(database_error)
}

async fn replay_command<T: for<'de> Deserialize<'de>>(
    pool: &PgPool,
    principal: &Principal,
    command_name: &str,
    idempotency_key: &str,
    request_fingerprint: &str,
) -> Result<Option<T>, ApiError> {
    deserialize_stored(
        find_command(pool, principal, command_name, idempotency_key).await?,
        request_fingerprint,
    )
}

async fn replay_command_tx<T: for<'de> Deserialize<'de>>(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    command_name: &str,
    idempotency_key: &str,
    request_fingerprint: &str,
) -> Result<Option<T>, ApiError> {
    deserialize_stored(
        find_command_tx(transaction, principal, command_name, idempotency_key).await?,
        request_fingerprint,
    )
}

fn deserialize_stored<T: for<'de> Deserialize<'de>>(
    stored: Option<StoredCommand>,
    request_fingerprint: &str,
) -> Result<Option<T>, ApiError> {
    let Some(stored) = stored else {
        return Ok(None);
    };
    if stored.request_fingerprint != request_fingerprint {
        return Err(ApiError::conflict(
            "Idempotency key was already used with a different verification command",
        ));
    }
    serde_json::from_value(stored.response_payload)
        .map(Some)
        .map_err(|_| ApiError::internal("Stored verification command response is invalid"))
}

#[allow(clippy::too_many_arguments)]
async fn store_command<T: Serialize>(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    command_name: &str,
    idempotency_key: &str,
    request_fingerprint: &str,
    aggregate_type: &str,
    aggregate_id: Uuid,
    response_revision: i32,
    response: &T,
) -> Result<(), ApiError> {
    let response_payload = serde_json::to_value(response)
        .map_err(|_| ApiError::internal("Could not store verification command response"))?;
    sqlx::query(
        r#"
        INSERT INTO command_results (
            organization_id, actor_subject, command_name, idempotency_key,
            request_fingerprint, aggregate_type, aggregate_id,
            response_revision, response_payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        "#,
    )
    .bind(principal.organization_id)
    .bind(&principal.subject)
    .bind(command_name)
    .bind(idempotency_key)
    .bind(request_fingerprint)
    .bind(aggregate_type)
    .bind(aggregate_id)
    .bind(response_revision)
    .bind(response_payload)
    .execute(&mut **transaction)
    .await
    .map_err(database_error)?;
    Ok(())
}

fn conflict_database_error(error: sqlx::Error) -> ApiError {
    if matches!(&error, sqlx::Error::Database(database) if database.is_unique_violation()) {
        ApiError::conflict("Verification command conflicts with existing controlled evidence")
    } else {
        database_error(error)
    }
}

fn database_error(error: sqlx::Error) -> ApiError {
    tracing::warn!(%error, "verification database operation failed");
    ApiError::unavailable("Verification database operation failed")
}

#[cfg(test)]
mod tests {
    use super::{
        RecordVerificationResultRequest, VerificationAttachmentInput, aggregate_status,
        canonical_hash, empty_object, validate_result_request,
    };

    #[test]
    fn coverage_status_is_conservative() {
        assert_eq!(aggregate_status(&["passed".to_owned()]), "passed");
        assert_eq!(
            aggregate_status(&["passed".to_owned(), "planned".to_owned()]),
            "planned"
        );
        assert_eq!(
            aggregate_status(&["passed".to_owned(), "failed".to_owned()]),
            "failed"
        );
        assert_eq!(aggregate_status(&[]), "unverified");
    }

    #[test]
    fn result_evidence_hashes_are_stable() {
        let value = serde_json::json!({"outcome":"passed","measurement":147});
        assert_eq!(
            canonical_hash(&value, "test").unwrap(),
            canonical_hash(&value, "test").unwrap()
        );
        assert_eq!(canonical_hash(&value, "test").unwrap().len(), 64);
    }

    #[test]
    fn attachment_hashes_are_validated() {
        let request = RecordVerificationResultRequest {
            outcome: "passed".to_owned(),
            notes: String::new(),
            measured_values: empty_object(),
            attachments: vec![VerificationAttachmentInput {
                object_key: "results/run.json".to_owned(),
                file_name: "run.json".to_owned(),
                media_type: "application/json".to_owned(),
                size_bytes: 12,
                sha256: "x".repeat(64),
            }],
        };
        assert!(validate_result_request(request).is_err());
    }
}
