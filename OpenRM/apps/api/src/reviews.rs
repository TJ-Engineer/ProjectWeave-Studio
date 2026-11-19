use axum::{
    Json,
    extract::{Path, State},
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
const CREATE_REVIEW_COMMAND: &str = "review.create";
const ADD_PARTICIPANT_COMMAND: &str = "review.participant.add";
const START_REVIEW_COMMAND: &str = "review.start";
const ADD_COMMENT_COMMAND: &str = "review.comment.add";
const RESOLVE_COMMENT_COMMAND: &str = "review.comment.resolve";
const RECORD_DECISION_COMMAND: &str = "review.decision.record";
const DECISION_SCHEMA_VERSION: &str = "openrm-review-decision-v1";

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CreateReviewRequest {
    pub baseline_id: Uuid,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub due_at: Option<DateTime<Utc>>,
    pub required_approvals: i32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AddParticipantRequest {
    pub subject: String,
    pub role_label: String,
    #[serde(default = "default_true")]
    pub required: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StartReviewRequest {
    #[serde(default)]
    pub rationale: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AddReviewCommentRequest {
    pub target_artifact_id: Option<Uuid>,
    pub body: String,
    #[serde(default)]
    pub blocking: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ResolveReviewCommentRequest {
    pub resolution: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RecordReviewDecisionRequest {
    pub decision: String,
    #[serde(default)]
    pub comment: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ReviewCommandResponse {
    pub review_id: Uuid,
    pub status: String,
    pub current_round: i32,
}

#[derive(Debug, Deserialize, FromRow, Serialize)]
pub struct ReviewParticipantResponse {
    pub id: Uuid,
    pub subject: String,
    pub role_label: String,
    pub required: bool,
    pub assigned_by: String,
    pub created_at: DateTime<Utc>,
    pub current_decision: Option<String>,
    pub decision_comment: Option<String>,
    pub decided_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize, FromRow, Serialize)]
pub struct ReviewCommentResponse {
    pub id: Uuid,
    pub target_artifact_id: Option<Uuid>,
    pub target_revision_id: Option<Uuid>,
    pub target_key: Option<String>,
    pub body: String,
    pub blocking: bool,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
    pub resolved: bool,
    pub resolution: Option<String>,
    pub resolved_by: Option<String>,
    pub resolved_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize, FromRow, Serialize)]
pub struct ReviewCommentResolutionResponse {
    pub id: Uuid,
    pub review_id: Uuid,
    pub comment_id: Uuid,
    pub resolution: String,
    pub resolved_by: String,
    pub resolved_at: DateTime<Utc>,
    pub package_status: String,
}

#[derive(Debug, Deserialize, FromRow, Serialize)]
pub struct ReviewDecisionResponse {
    pub id: Uuid,
    pub participant_id: Uuid,
    pub subject: String,
    pub round: i32,
    pub decision: String,
    pub comment: String,
    pub evidence_hash: String,
    pub signature: String,
    pub signing_algorithm: String,
    pub signing_key_id: String,
    pub decided_by: String,
    pub decided_at: DateTime<Utc>,
    #[sqlx(skip)]
    pub signature_valid: bool,
    #[sqlx(skip)]
    pub package_status: String,
}

#[derive(Debug, Serialize)]
pub struct ReviewPackageResponse {
    pub id: Uuid,
    pub project_id: Uuid,
    pub sequence: i32,
    pub baseline_id: Uuid,
    pub baseline_sequence: i32,
    pub title: String,
    pub description: String,
    pub status: String,
    pub due_at: Option<DateTime<Utc>>,
    pub required_approvals: i32,
    pub current_round: i32,
    pub artifact_count: i64,
    pub participant_count: i64,
    pub approval_count: i64,
    pub open_comment_count: i64,
    pub blocking_comment_count: i64,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub participants: Vec<ReviewParticipantResponse>,
    pub comments: Vec<ReviewCommentResponse>,
    pub decisions: Vec<ReviewDecisionResponse>,
}

#[derive(Debug, Serialize)]
pub struct ReviewPackageListResponse {
    pub items: Vec<ReviewPackageResponse>,
}

#[derive(Debug, FromRow)]
struct ReviewRecord {
    id: Uuid,
    project_id: Uuid,
    sequence: i32,
    baseline_id: Uuid,
    baseline_sequence: i32,
    title: String,
    description: String,
    status: String,
    due_at: Option<DateTime<Utc>>,
    required_approvals: i32,
    current_round: i32,
    artifact_count: i64,
    created_by: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, FromRow)]
struct ReviewLock {
    id: Uuid,
    baseline_id: Uuid,
    baseline_created_by: String,
    status: String,
    current_round: i32,
    required_approvals: i32,
    created_by: String,
}

#[derive(Debug, FromRow)]
struct StoredCommand {
    request_fingerprint: String,
    response_payload: Value,
}

#[derive(Serialize)]
struct DecisionEvidence<'a> {
    schema_version: &'static str,
    decision_id: Uuid,
    review_id: Uuid,
    baseline_id: Uuid,
    participant_id: Uuid,
    round: i32,
    decision: &'a str,
    comment: &'a str,
    decided_by: &'a str,
}

pub async fn list_reviews(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
) -> Result<Json<ReviewPackageListResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Read).await?;
    let records = load_review_records(&state.db, &principal, project_id).await?;
    let mut items = Vec::with_capacity(records.len());
    for record in records {
        items.push(load_review_response(&state, &principal, record).await?);
    }
    Ok(Json(ReviewPackageListResponse { items }))
}

pub async fn get_review(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path((project_id, review_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<ReviewPackageResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Read).await?;
    let record = fetch_review_record(&state.db, &principal, project_id, review_id).await?;
    Ok(Json(
        load_review_response(&state, &principal, record).await?,
    ))
}

pub async fn create_review(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<CreateReviewRequest>,
) -> Result<(StatusCode, Json<ReviewCommandResponse>), ApiError> {
    authorize_project(&state, &principal, project_id, Action::Write).await?;
    let request = validate_create_review(request)?;
    let idempotency_key = parse_idempotency_key(&headers)?;
    let fingerprint = fingerprint(&(project_id, &request))?;
    if let Some(response) = replay_command::<ReviewCommandResponse>(
        &state.db,
        &principal,
        CREATE_REVIEW_COMMAND,
        idempotency_key,
        &fingerprint,
    )
    .await?
    {
        return Ok((StatusCode::OK, Json(response)));
    }

    let mut transaction = state.db.begin().await.map_err(database_error)?;
    lock_project(&mut transaction, &principal, project_id).await?;
    if let Some(response) = replay_command_tx::<ReviewCommandResponse>(
        &mut transaction,
        &principal,
        CREATE_REVIEW_COMMAND,
        idempotency_key,
        &fingerprint,
    )
    .await?
    {
        return Ok((StatusCode::OK, Json(response)));
    }
    let baseline_exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM baselines WHERE organization_id = $1 AND project_id = $2 AND id = $3)",
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(request.baseline_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?;
    if !baseline_exists {
        return Err(ApiError::not_found("Baseline does not exist"));
    }
    let sequence = sqlx::query_scalar::<_, Option<i32>>(
        "SELECT max(sequence) FROM review_packages WHERE organization_id = $1 AND project_id = $2",
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?
    .unwrap_or(0)
        + 1;
    let review_id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO review_packages (
            id, organization_id, project_id, sequence, baseline_id, title,
            description, status, due_at, required_approvals, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8, $9, $10)
        "#,
    )
    .bind(review_id)
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(sequence)
    .bind(request.baseline_id)
    .bind(&request.title)
    .bind(&request.description)
    .bind(request.due_at)
    .bind(request.required_approvals)
    .bind(&principal.subject)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    insert_review_event(
        &mut transaction,
        &principal,
        project_id,
        review_id,
        1,
        0,
        "created",
        "draft",
        Some("Review package created"),
    )
    .await?;
    insert_audit(
        &mut transaction,
        &principal,
        project_id,
        "review.created",
        "review_package",
        review_id,
        serde_json::json!({
            "sequence": sequence,
            "baseline_id": request.baseline_id,
            "required_approvals": request.required_approvals
        }),
    )
    .await?;
    let response = ReviewCommandResponse {
        review_id,
        status: "draft".to_owned(),
        current_round: 0,
    };
    store_command(
        &mut transaction,
        &principal,
        CREATE_REVIEW_COMMAND,
        idempotency_key,
        &fingerprint,
        "review_package",
        review_id,
        1,
        &response,
    )
    .await?;
    transaction.commit().await.map_err(database_error)?;
    Ok((StatusCode::CREATED, Json(response)))
}

pub async fn add_participant(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path((project_id, review_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(request): Json<AddParticipantRequest>,
) -> Result<(StatusCode, Json<ReviewParticipantResponse>), ApiError> {
    authorize_project(&state, &principal, project_id, Action::Write).await?;
    let request = validate_participant(request)?;
    let idempotency_key = parse_idempotency_key(&headers)?;
    let fingerprint = fingerprint(&(project_id, review_id, &request))?;
    if let Some(response) = replay_command::<ReviewParticipantResponse>(
        &state.db,
        &principal,
        ADD_PARTICIPANT_COMMAND,
        idempotency_key,
        &fingerprint,
    )
    .await?
    {
        return Ok((StatusCode::OK, Json(response)));
    }
    let mut transaction = state.db.begin().await.map_err(database_error)?;
    let review = lock_review(&mut transaction, &principal, project_id, review_id).await?;
    if review.status != "draft" {
        return Err(ApiError::conflict(
            "Participants can only be assigned while the review is draft",
        ));
    }
    if let Some(response) = replay_command_tx::<ReviewParticipantResponse>(
        &mut transaction,
        &principal,
        ADD_PARTICIPANT_COMMAND,
        idempotency_key,
        &fingerprint,
    )
    .await?
    {
        return Ok((StatusCode::OK, Json(response)));
    }
    let role = sqlx::query_scalar::<_, String>(
        r#"
        SELECT role FROM project_memberships
        WHERE organization_id = $1 AND project_id = $2 AND subject = $3
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(&request.subject)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?
    .ok_or_else(|| ApiError::bad_request("Participant is not a project member"))?;
    if !matches!(role.as_str(), "reviewer" | "administrator") {
        return Err(ApiError::bad_request(
            "Review participants must have reviewer or administrator project role",
        ));
    }
    let participant_id = Uuid::new_v4();
    let response = sqlx::query_as::<_, ReviewParticipantResponse>(
        r#"
        INSERT INTO review_participants (
            id, organization_id, project_id, review_id, subject,
            role_label, required, assigned_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, subject, role_label, required, assigned_by, created_at,
                  NULL::text AS current_decision,
                  NULL::text AS decision_comment,
                  NULL::timestamptz AS decided_at
        "#,
    )
    .bind(participant_id)
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review_id)
    .bind(&request.subject)
    .bind(&request.role_label)
    .bind(request.required)
    .bind(&principal.subject)
    .fetch_one(&mut *transaction)
    .await
    .map_err(conflict_database_error)?;
    insert_audit(
        &mut transaction,
        &principal,
        project_id,
        "review.participant_added",
        "review_package",
        review_id,
        serde_json::json!({
            "participant_id": participant_id,
            "subject": request.subject,
            "required": request.required
        }),
    )
    .await?;
    store_command(
        &mut transaction,
        &principal,
        ADD_PARTICIPANT_COMMAND,
        idempotency_key,
        &fingerprint,
        "review_participant",
        participant_id,
        1,
        &response,
    )
    .await?;
    transaction.commit().await.map_err(database_error)?;
    Ok((StatusCode::CREATED, Json(response)))
}

pub async fn start_review(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path((project_id, review_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(request): Json<StartReviewRequest>,
) -> Result<(StatusCode, Json<ReviewCommandResponse>), ApiError> {
    authorize_project(&state, &principal, project_id, Action::Write).await?;
    let rationale = validate_optional_text(&request.rationale, 2_000, "rationale")?;
    let idempotency_key = parse_idempotency_key(&headers)?;
    let fingerprint = fingerprint(&(project_id, review_id, &rationale))?;
    if let Some(response) = replay_command::<ReviewCommandResponse>(
        &state.db,
        &principal,
        START_REVIEW_COMMAND,
        idempotency_key,
        &fingerprint,
    )
    .await?
    {
        return Ok((StatusCode::OK, Json(response)));
    }
    let mut transaction = state.db.begin().await.map_err(database_error)?;
    let review = lock_review(&mut transaction, &principal, project_id, review_id).await?;
    if !matches!(review.status.as_str(), "draft" | "changes_requested") {
        return Err(ApiError::conflict(
            "Only draft or changes-requested reviews can start a new round",
        ));
    }
    if let Some(response) = replay_command_tx::<ReviewCommandResponse>(
        &mut transaction,
        &principal,
        START_REVIEW_COMMAND,
        idempotency_key,
        &fingerprint,
    )
    .await?
    {
        return Ok((StatusCode::OK, Json(response)));
    }
    let required_participants = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT count(*) FROM review_participants
        WHERE organization_id = $1 AND project_id = $2 AND review_id = $3 AND required
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?;
    if required_participants < i64::from(review.required_approvals) {
        return Err(ApiError::conflict(
            "Required reviewer assignments do not satisfy the approval threshold",
        ));
    }
    if review.status == "changes_requested" {
        let blockers =
            count_open_blocking_comments_tx(&mut transaction, &principal, project_id, review_id)
                .await?;
        if blockers > 0 {
            return Err(ApiError::conflict(
                "Resolve all blocking comments before starting another review round",
            ));
        }
    }
    let next_round = review.current_round + 1;
    let next_version =
        next_event_version(&mut transaction, &principal, project_id, review_id).await?;
    sqlx::query(
        r#"
        UPDATE review_packages
        SET status = 'in_review', current_round = $4, updated_at = now()
        WHERE organization_id = $1 AND project_id = $2 AND id = $3
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review_id)
    .bind(next_round)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    insert_review_event(
        &mut transaction,
        &principal,
        project_id,
        review_id,
        next_version,
        next_round,
        "started",
        "in_review",
        (!rationale.is_empty()).then_some(rationale.as_str()),
    )
    .await?;
    insert_audit(
        &mut transaction,
        &principal,
        project_id,
        "review.started",
        "review_package",
        review_id,
        serde_json::json!({ "round": next_round, "rationale": rationale }),
    )
    .await?;
    let response = ReviewCommandResponse {
        review_id,
        status: "in_review".to_owned(),
        current_round: next_round,
    };
    store_command(
        &mut transaction,
        &principal,
        START_REVIEW_COMMAND,
        idempotency_key,
        &fingerprint,
        "review_package",
        review_id,
        next_round,
        &response,
    )
    .await?;
    transaction.commit().await.map_err(database_error)?;
    Ok((StatusCode::OK, Json(response)))
}

pub async fn add_comment(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path((project_id, review_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(request): Json<AddReviewCommentRequest>,
) -> Result<(StatusCode, Json<ReviewCommentResponse>), ApiError> {
    authorize_project(&state, &principal, project_id, Action::Review).await?;
    let body = validate_required_text(&request.body, 4_000, "comment")?;
    let idempotency_key = parse_idempotency_key(&headers)?;
    let fingerprint = fingerprint(&(
        project_id,
        review_id,
        request.target_artifact_id,
        &body,
        request.blocking,
    ))?;
    if let Some(response) = replay_command::<ReviewCommentResponse>(
        &state.db,
        &principal,
        ADD_COMMENT_COMMAND,
        idempotency_key,
        &fingerprint,
    )
    .await?
    {
        return Ok((StatusCode::OK, Json(response)));
    }
    let mut transaction = state.db.begin().await.map_err(database_error)?;
    let review = lock_review(&mut transaction, &principal, project_id, review_id).await?;
    if review.status != "in_review" {
        return Err(ApiError::conflict(
            "Comments can only be added during an active review round",
        ));
    }
    require_participant(&mut transaction, &principal, project_id, review_id).await?;
    if let Some(response) = replay_command_tx::<ReviewCommentResponse>(
        &mut transaction,
        &principal,
        ADD_COMMENT_COMMAND,
        idempotency_key,
        &fingerprint,
    )
    .await?
    {
        return Ok((StatusCode::OK, Json(response)));
    }
    let (target_revision_id, target_key) = if let Some(artifact_id) = request.target_artifact_id {
        sqlx::query_as::<_, (Uuid, String)>(
            r#"
            SELECT ba.artifact_revision_id, ba.artifact_key
            FROM baseline_artifacts ba
            WHERE ba.organization_id = $1 AND ba.project_id = $2
              AND ba.baseline_id = $3 AND ba.artifact_id = $4
            "#,
        )
        .bind(principal.organization_id)
        .bind(project_id)
        .bind(review.baseline_id)
        .bind(artifact_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(database_error)?
        .ok_or_else(|| ApiError::bad_request("Comment target is not in the review baseline"))?
        .pipe(|(revision, key)| (Some(revision), Some(key)))
    } else {
        (None, None)
    };
    let comment_id = Uuid::new_v4();
    let response = sqlx::query_as::<_, ReviewCommentResponse>(
        r#"
        INSERT INTO review_comments (
            id, organization_id, project_id, review_id, target_artifact_id,
            target_revision_id, body, blocking, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id, target_artifact_id, target_revision_id,
                  $10::text AS target_key, body, blocking, created_by, created_at,
                  false AS resolved, NULL::text AS resolution,
                  NULL::text AS resolved_by, NULL::timestamptz AS resolved_at
        "#,
    )
    .bind(comment_id)
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review_id)
    .bind(request.target_artifact_id)
    .bind(target_revision_id)
    .bind(&body)
    .bind(request.blocking)
    .bind(&principal.subject)
    .bind(target_key)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?;
    insert_audit(
        &mut transaction,
        &principal,
        project_id,
        "review.comment_added",
        "review_comment",
        comment_id,
        serde_json::json!({
            "review_id": review_id,
            "target_artifact_id": request.target_artifact_id,
            "target_revision_id": target_revision_id,
            "blocking": request.blocking
        }),
    )
    .await?;
    store_command(
        &mut transaction,
        &principal,
        ADD_COMMENT_COMMAND,
        idempotency_key,
        &fingerprint,
        "review_comment",
        comment_id,
        1,
        &response,
    )
    .await?;
    transaction.commit().await.map_err(database_error)?;
    Ok((StatusCode::CREATED, Json(response)))
}

pub async fn resolve_comment(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path((project_id, review_id, comment_id)): Path<(Uuid, Uuid, Uuid)>,
    headers: HeaderMap,
    Json(request): Json<ResolveReviewCommentRequest>,
) -> Result<(StatusCode, Json<ReviewCommentResolutionResponse>), ApiError> {
    authorize_project(&state, &principal, project_id, Action::Write).await?;
    let resolution = validate_required_text(&request.resolution, 4_000, "resolution")?;
    let idempotency_key = parse_idempotency_key(&headers)?;
    let fingerprint = fingerprint(&(project_id, review_id, comment_id, &resolution))?;
    if let Some(response) = replay_command::<ReviewCommentResolutionResponse>(
        &state.db,
        &principal,
        RESOLVE_COMMENT_COMMAND,
        idempotency_key,
        &fingerprint,
    )
    .await?
    {
        return Ok((StatusCode::OK, Json(response)));
    }
    let mut transaction = state.db.begin().await.map_err(database_error)?;
    let review = lock_review(&mut transaction, &principal, project_id, review_id).await?;
    if !matches!(review.status.as_str(), "in_review" | "changes_requested") {
        return Err(ApiError::conflict(
            "Comments cannot be resolved after the review is finalized",
        ));
    }
    if let Some(response) = replay_command_tx::<ReviewCommentResolutionResponse>(
        &mut transaction,
        &principal,
        RESOLVE_COMMENT_COMMAND,
        idempotency_key,
        &fingerprint,
    )
    .await?
    {
        return Ok((StatusCode::OK, Json(response)));
    }
    let exists = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM review_comments c
            LEFT JOIN review_comment_resolutions r
              ON r.organization_id = c.organization_id
             AND r.project_id = c.project_id
             AND r.review_id = c.review_id
             AND r.comment_id = c.id
            WHERE c.organization_id = $1 AND c.project_id = $2
              AND c.review_id = $3 AND c.id = $4 AND r.id IS NULL
        )
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review_id)
    .bind(comment_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?;
    if !exists {
        return Err(ApiError::conflict(
            "Comment does not exist or is already resolved",
        ));
    }
    let resolution_id = Uuid::new_v4();
    let mut response = sqlx::query_as::<_, ReviewCommentResolutionResponse>(
        r#"
        INSERT INTO review_comment_resolutions (
            id, organization_id, project_id, review_id, comment_id,
            resolution, resolved_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, review_id, comment_id, resolution, resolved_by,
                  resolved_at, ''::text AS package_status
        "#,
    )
    .bind(resolution_id)
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review_id)
    .bind(comment_id)
    .bind(&resolution)
    .bind(&principal.subject)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?;
    let package_status = maybe_approve_review(
        &mut transaction,
        &principal,
        project_id,
        &review,
        "All approval and blocking-comment conditions are satisfied",
    )
    .await?;
    response.package_status = package_status;
    insert_audit(
        &mut transaction,
        &principal,
        project_id,
        "review.comment_resolved",
        "review_comment",
        comment_id,
        serde_json::json!({
            "review_id": review_id,
            "resolution_id": resolution_id,
            "package_status": response.package_status
        }),
    )
    .await?;
    store_command(
        &mut transaction,
        &principal,
        RESOLVE_COMMENT_COMMAND,
        idempotency_key,
        &fingerprint,
        "review_comment_resolution",
        resolution_id,
        review.current_round.max(1),
        &response,
    )
    .await?;
    transaction.commit().await.map_err(database_error)?;
    Ok((StatusCode::CREATED, Json(response)))
}

pub async fn record_decision(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path((project_id, review_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(request): Json<RecordReviewDecisionRequest>,
) -> Result<(StatusCode, Json<ReviewDecisionResponse>), ApiError> {
    authorize_project(&state, &principal, project_id, Action::Review).await?;
    let decision = request.decision.trim().to_ascii_lowercase();
    if !matches!(decision.as_str(), "approved" | "changes_requested") {
        return Err(ApiError::bad_request(
            "decision must be approved or changes_requested",
        ));
    }
    let comment = validate_optional_text(&request.comment, 4_000, "decision comment")?;
    if decision == "changes_requested" && comment.is_empty() {
        return Err(ApiError::bad_request(
            "changes_requested decisions require a comment",
        ));
    }
    let idempotency_key = parse_idempotency_key(&headers)?;
    let fingerprint = fingerprint(&(project_id, review_id, &decision, &comment))?;
    if let Some(response) = replay_command::<ReviewDecisionResponse>(
        &state.db,
        &principal,
        RECORD_DECISION_COMMAND,
        idempotency_key,
        &fingerprint,
    )
    .await?
    {
        return Ok((StatusCode::OK, Json(response)));
    }
    let mut transaction = state.db.begin().await.map_err(database_error)?;
    let review = lock_review(&mut transaction, &principal, project_id, review_id).await?;
    if review.status != "in_review" {
        return Err(ApiError::conflict(
            "Decisions can only be recorded during an active review round",
        ));
    }
    if principal.subject == review.created_by || principal.subject == review.baseline_created_by {
        return Err(ApiError::forbidden(
            "Segregation of duties prevents package authors and baseline creators from approving this review",
        ));
    }
    let participant =
        require_participant(&mut transaction, &principal, project_id, review_id).await?;
    if let Some(response) = replay_command_tx::<ReviewDecisionResponse>(
        &mut transaction,
        &principal,
        RECORD_DECISION_COMMAND,
        idempotency_key,
        &fingerprint,
    )
    .await?
    {
        return Ok((StatusCode::OK, Json(response)));
    }
    let already_decided = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM review_decisions
            WHERE organization_id = $1 AND project_id = $2 AND review_id = $3
              AND participant_id = $4 AND round = $5
        )
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review_id)
    .bind(participant.id)
    .bind(review.current_round)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?;
    if already_decided {
        return Err(ApiError::conflict(
            "Participant already recorded a decision for this review round",
        ));
    }
    let decision_id = Uuid::new_v4();
    let evidence = DecisionEvidence {
        schema_version: DECISION_SCHEMA_VERSION,
        decision_id,
        review_id,
        baseline_id: review.baseline_id,
        participant_id: participant.id,
        round: review.current_round,
        decision: &decision,
        comment: &comment,
        decided_by: &principal.subject,
    };
    let evidence_hash = canonical_hash(&evidence)?;
    let signature = state.evidence_signer.sign(&evidence_hash);
    let mut response = sqlx::query_as::<_, ReviewDecisionResponse>(
        r#"
        INSERT INTO review_decisions (
            id, organization_id, project_id, review_id, participant_id, round,
            decision, comment, evidence_hash, signature, signing_algorithm,
            signing_key_id, decided_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING id, participant_id, $14::text AS subject, round, decision,
                  comment, evidence_hash, signature, signing_algorithm,
                  signing_key_id, decided_by, decided_at,
                  false AS signature_valid, ''::text AS package_status
        "#,
    )
    .bind(decision_id)
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review_id)
    .bind(participant.id)
    .bind(review.current_round)
    .bind(&decision)
    .bind(&comment)
    .bind(&evidence_hash)
    .bind(&signature)
    .bind(EvidenceSigner::ALGORITHM)
    .bind(state.evidence_signer.key_id())
    .bind(&principal.subject)
    .bind(&participant.subject)
    .fetch_one(&mut *transaction)
    .await
    .map_err(conflict_database_error)?;
    response.signature_valid = true;
    let package_status = if decision == "changes_requested" {
        transition_review(
            &mut transaction,
            &principal,
            project_id,
            &review,
            "changes_requested",
            "changes_requested",
            &comment,
        )
        .await?;
        "changes_requested".to_owned()
    } else {
        maybe_approve_review(
            &mut transaction,
            &principal,
            project_id,
            &review,
            "Required approvals recorded and blocking comments resolved",
        )
        .await?
    };
    response.package_status = package_status;
    insert_audit(
        &mut transaction,
        &principal,
        project_id,
        "review.decision_recorded",
        "review_decision",
        decision_id,
        serde_json::json!({
            "review_id": review_id,
            "baseline_id": review.baseline_id,
            "round": review.current_round,
            "decision": decision,
            "evidence_hash": evidence_hash,
            "signature": signature,
            "package_status": response.package_status
        }),
    )
    .await?;
    store_command(
        &mut transaction,
        &principal,
        RECORD_DECISION_COMMAND,
        idempotency_key,
        &fingerprint,
        "review_decision",
        decision_id,
        review.current_round,
        &response,
    )
    .await?;
    transaction.commit().await.map_err(database_error)?;
    Ok((StatusCode::CREATED, Json(response)))
}

async fn load_review_records(
    pool: &PgPool,
    principal: &Principal,
    project_id: Uuid,
) -> Result<Vec<ReviewRecord>, ApiError> {
    sqlx::query_as::<_, ReviewRecord>(review_record_sql(false))
        .bind(principal.organization_id)
        .bind(project_id)
        .fetch_all(pool)
        .await
        .map_err(database_error)
}

async fn fetch_review_record(
    pool: &PgPool,
    principal: &Principal,
    project_id: Uuid,
    review_id: Uuid,
) -> Result<ReviewRecord, ApiError> {
    sqlx::query_as::<_, ReviewRecord>(review_record_sql(true))
        .bind(principal.organization_id)
        .bind(project_id)
        .bind(review_id)
        .fetch_optional(pool)
        .await
        .map_err(database_error)?
        .ok_or_else(|| ApiError::not_found("Review package does not exist"))
}

fn review_record_sql(single: bool) -> &'static str {
    if single {
        r#"
        SELECT rp.id, rp.project_id, rp.sequence, rp.baseline_id,
               b.sequence AS baseline_sequence, rp.title, rp.description,
               rp.status, rp.due_at, rp.required_approvals, rp.current_round,
               (SELECT count(*) FROM baseline_artifacts ba
                WHERE ba.organization_id = rp.organization_id
                  AND ba.project_id = rp.project_id
                  AND ba.baseline_id = rp.baseline_id) AS artifact_count,
               rp.created_by, rp.created_at, rp.updated_at
        FROM review_packages rp
        JOIN baselines b
          ON b.organization_id = rp.organization_id
         AND b.project_id = rp.project_id
         AND b.id = rp.baseline_id
        WHERE rp.organization_id = $1 AND rp.project_id = $2 AND rp.id = $3
        "#
    } else {
        r#"
        SELECT rp.id, rp.project_id, rp.sequence, rp.baseline_id,
               b.sequence AS baseline_sequence, rp.title, rp.description,
               rp.status, rp.due_at, rp.required_approvals, rp.current_round,
               (SELECT count(*) FROM baseline_artifacts ba
                WHERE ba.organization_id = rp.organization_id
                  AND ba.project_id = rp.project_id
                  AND ba.baseline_id = rp.baseline_id) AS artifact_count,
               rp.created_by, rp.created_at, rp.updated_at
        FROM review_packages rp
        JOIN baselines b
          ON b.organization_id = rp.organization_id
         AND b.project_id = rp.project_id
         AND b.id = rp.baseline_id
        WHERE rp.organization_id = $1 AND rp.project_id = $2
        ORDER BY rp.sequence DESC
        "#
    }
}

async fn load_review_response(
    state: &AppState,
    principal: &Principal,
    record: ReviewRecord,
) -> Result<ReviewPackageResponse, ApiError> {
    let participants = sqlx::query_as::<_, ReviewParticipantResponse>(
        r#"
        SELECT p.id, p.subject, p.role_label, p.required, p.assigned_by, p.created_at,
               d.decision AS current_decision, d.comment AS decision_comment,
               d.decided_at
        FROM review_participants p
        LEFT JOIN review_decisions d
          ON d.organization_id = p.organization_id
         AND d.project_id = p.project_id
         AND d.review_id = p.review_id
         AND d.participant_id = p.id
         AND d.round = $4
        WHERE p.organization_id = $1 AND p.project_id = $2 AND p.review_id = $3
        ORDER BY p.required DESC, p.created_at, p.id
        "#,
    )
    .bind(principal.organization_id)
    .bind(record.project_id)
    .bind(record.id)
    .bind(record.current_round)
    .fetch_all(&state.db)
    .await
    .map_err(database_error)?;
    let comments = sqlx::query_as::<_, ReviewCommentResponse>(
        r#"
        SELECT c.id, c.target_artifact_id, c.target_revision_id, a.key AS target_key,
               c.body, c.blocking, c.created_by, c.created_at,
               (r.id IS NOT NULL) AS resolved, r.resolution, r.resolved_by, r.resolved_at
        FROM review_comments c
        LEFT JOIN artifacts a
          ON a.organization_id = c.organization_id
         AND a.project_id = c.project_id
         AND a.id = c.target_artifact_id
        LEFT JOIN review_comment_resolutions r
          ON r.organization_id = c.organization_id
         AND r.project_id = c.project_id
         AND r.review_id = c.review_id
         AND r.comment_id = c.id
        WHERE c.organization_id = $1 AND c.project_id = $2 AND c.review_id = $3
        ORDER BY c.created_at DESC, c.id
        "#,
    )
    .bind(principal.organization_id)
    .bind(record.project_id)
    .bind(record.id)
    .fetch_all(&state.db)
    .await
    .map_err(database_error)?;
    let mut decisions = sqlx::query_as::<_, ReviewDecisionResponse>(
        r#"
        SELECT d.id, d.participant_id, p.subject, d.round, d.decision,
               d.comment, d.evidence_hash, d.signature, d.signing_algorithm,
               d.signing_key_id, d.decided_by, d.decided_at,
               false AS signature_valid, ''::text AS package_status
        FROM review_decisions d
        JOIN review_participants p
          ON p.organization_id = d.organization_id
         AND p.project_id = d.project_id
         AND p.review_id = d.review_id
         AND p.id = d.participant_id
        WHERE d.organization_id = $1 AND d.project_id = $2 AND d.review_id = $3
        ORDER BY d.round DESC, d.decided_at DESC, d.id
        "#,
    )
    .bind(principal.organization_id)
    .bind(record.project_id)
    .bind(record.id)
    .fetch_all(&state.db)
    .await
    .map_err(database_error)?;
    for decision in &mut decisions {
        decision.signature_valid = state.evidence_signer.verify_with_key_id(
            &decision.signing_key_id,
            &decision.evidence_hash,
            &decision.signature,
        );
        decision.package_status = record.status.clone();
    }
    let participant_count = participants.len() as i64;
    let approval_count = participants
        .iter()
        .filter(|participant| participant.current_decision.as_deref() == Some("approved"))
        .count() as i64;
    let open_comment_count = comments.iter().filter(|comment| !comment.resolved).count() as i64;
    let blocking_comment_count = comments
        .iter()
        .filter(|comment| comment.blocking && !comment.resolved)
        .count() as i64;
    Ok(ReviewPackageResponse {
        id: record.id,
        project_id: record.project_id,
        sequence: record.sequence,
        baseline_id: record.baseline_id,
        baseline_sequence: record.baseline_sequence,
        title: record.title,
        description: record.description,
        status: record.status,
        due_at: record.due_at,
        required_approvals: record.required_approvals,
        current_round: record.current_round,
        artifact_count: record.artifact_count,
        participant_count,
        approval_count,
        open_comment_count,
        blocking_comment_count,
        created_by: record.created_by,
        created_at: record.created_at,
        updated_at: record.updated_at,
        participants,
        comments,
        decisions,
    })
}

async fn lock_project(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    project_id: Uuid,
) -> Result<(), ApiError> {
    sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM projects WHERE organization_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(database_error)?
    .ok_or_else(|| ApiError::not_found("Project does not exist"))?;
    Ok(())
}

async fn lock_review(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    project_id: Uuid,
    review_id: Uuid,
) -> Result<ReviewLock, ApiError> {
    sqlx::query_as::<_, ReviewLock>(
        r#"
        SELECT rp.id, rp.baseline_id, b.created_by AS baseline_created_by,
               rp.status, rp.current_round, rp.required_approvals, rp.created_by
        FROM review_packages rp
        JOIN baselines b
          ON b.organization_id = rp.organization_id
         AND b.project_id = rp.project_id
         AND b.id = rp.baseline_id
        WHERE rp.organization_id = $1 AND rp.project_id = $2 AND rp.id = $3
        FOR UPDATE OF rp
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(database_error)?
    .ok_or_else(|| ApiError::not_found("Review package does not exist"))
}

async fn require_participant(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    project_id: Uuid,
    review_id: Uuid,
) -> Result<ReviewParticipantResponse, ApiError> {
    sqlx::query_as::<_, ReviewParticipantResponse>(
        r#"
        SELECT id, subject, role_label, required, assigned_by, created_at,
               NULL::text AS current_decision, NULL::text AS decision_comment,
               NULL::timestamptz AS decided_at
        FROM review_participants
        WHERE organization_id = $1 AND project_id = $2
          AND review_id = $3 AND subject = $4
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review_id)
    .bind(&principal.subject)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(database_error)?
    .ok_or_else(|| ApiError::forbidden("Principal is not assigned to this review package"))
}

async fn maybe_approve_review(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    project_id: Uuid,
    review: &ReviewLock,
    rationale: &str,
) -> Result<String, ApiError> {
    if review.status != "in_review" {
        return Ok(review.status.clone());
    }
    let approvals = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT count(*)
        FROM review_decisions d
        JOIN review_participants p
          ON p.organization_id = d.organization_id
         AND p.project_id = d.project_id
         AND p.review_id = d.review_id
         AND p.id = d.participant_id
        WHERE d.organization_id = $1 AND d.project_id = $2 AND d.review_id = $3
          AND d.round = $4 AND d.decision = 'approved' AND p.required
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review.id)
    .bind(review.current_round)
    .fetch_one(&mut **transaction)
    .await
    .map_err(database_error)?;
    let blockers =
        count_open_blocking_comments_tx(transaction, principal, project_id, review.id).await?;
    if approvals >= i64::from(review.required_approvals) && blockers == 0 {
        transition_review(
            transaction,
            principal,
            project_id,
            review,
            "approved",
            "approved",
            rationale,
        )
        .await?;
        Ok("approved".to_owned())
    } else {
        Ok("in_review".to_owned())
    }
}

async fn transition_review(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    project_id: Uuid,
    review: &ReviewLock,
    status: &str,
    event_type: &str,
    rationale: &str,
) -> Result<(), ApiError> {
    sqlx::query(
        r#"
        UPDATE review_packages SET status = $4, updated_at = now()
        WHERE organization_id = $1 AND project_id = $2 AND id = $3
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review.id)
    .bind(status)
    .execute(&mut **transaction)
    .await
    .map_err(database_error)?;
    let version = next_event_version(transaction, principal, project_id, review.id).await?;
    insert_review_event(
        transaction,
        principal,
        project_id,
        review.id,
        version,
        review.current_round,
        event_type,
        status,
        Some(rationale),
    )
    .await
}

async fn count_open_blocking_comments_tx(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    project_id: Uuid,
    review_id: Uuid,
) -> Result<i64, ApiError> {
    sqlx::query_scalar::<_, i64>(
        r#"
        SELECT count(*)
        FROM review_comments c
        LEFT JOIN review_comment_resolutions r
          ON r.organization_id = c.organization_id
         AND r.project_id = c.project_id
         AND r.review_id = c.review_id
         AND r.comment_id = c.id
        WHERE c.organization_id = $1 AND c.project_id = $2 AND c.review_id = $3
          AND c.blocking AND r.id IS NULL
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review_id)
    .fetch_one(&mut **transaction)
    .await
    .map_err(database_error)
}

#[allow(clippy::too_many_arguments)]
async fn insert_review_event(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    project_id: Uuid,
    review_id: Uuid,
    version: i32,
    round: i32,
    event_type: &str,
    status: &str,
    rationale: Option<&str>,
) -> Result<(), ApiError> {
    sqlx::query(
        r#"
        INSERT INTO review_package_events (
            id, organization_id, project_id, review_id, version, round,
            event_type, status, rationale, actor_subject
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review_id)
    .bind(version)
    .bind(round)
    .bind(event_type)
    .bind(status)
    .bind(rationale)
    .bind(&principal.subject)
    .execute(&mut **transaction)
    .await
    .map_err(database_error)?;
    Ok(())
}

async fn next_event_version(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    project_id: Uuid,
    review_id: Uuid,
) -> Result<i32, ApiError> {
    Ok(sqlx::query_scalar::<_, Option<i32>>(
        r#"
        SELECT max(version) FROM review_package_events
        WHERE organization_id = $1 AND project_id = $2 AND review_id = $3
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(review_id)
    .fetch_one(&mut **transaction)
    .await
    .map_err(database_error)?
    .unwrap_or(0)
        + 1)
}

fn validate_create_review(request: CreateReviewRequest) -> Result<CreateReviewRequest, ApiError> {
    let title = validate_required_text(&request.title, 200, "review title")?;
    let description = validate_optional_text(&request.description, 4_000, "review description")?;
    if !(1..=50).contains(&request.required_approvals) {
        return Err(ApiError::bad_request(
            "required_approvals must be between 1 and 50",
        ));
    }
    Ok(CreateReviewRequest {
        baseline_id: request.baseline_id,
        title,
        description,
        due_at: request.due_at,
        required_approvals: request.required_approvals,
    })
}

fn validate_participant(request: AddParticipantRequest) -> Result<AddParticipantRequest, ApiError> {
    let subject = validate_required_text(&request.subject, 200, "participant subject")?;
    let role_label = validate_required_text(&request.role_label, 120, "participant role")?;
    Ok(AddParticipantRequest {
        subject,
        role_label,
        required: request.required,
    })
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

fn canonical_hash<T: Serialize>(value: &T) -> Result<String, ApiError> {
    let bytes = serde_json::to_vec(value)
        .map_err(|_| ApiError::internal("Could not serialize review decision evidence"))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn fingerprint<T: Serialize>(value: &T) -> Result<String, ApiError> {
    serde_json::to_string(value)
        .map_err(|_| ApiError::internal("Could not fingerprint review command"))
}

fn default_true() -> bool {
    true
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
            "Idempotency key was already used with a different review command",
        ));
    }
    serde_json::from_value(stored.response_payload)
        .map(Some)
        .map_err(|_| ApiError::internal("Stored review command response is invalid"))
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
        .map_err(|_| ApiError::internal("Could not store review command response"))?;
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
        ApiError::conflict("Review command conflicts with existing controlled evidence")
    } else {
        database_error(error)
    }
}

fn database_error(error: sqlx::Error) -> ApiError {
    tracing::warn!(%error, "review database operation failed");
    ApiError::unavailable("Review database operation failed")
}

trait Pipe: Sized {
    fn pipe<T>(self, operation: impl FnOnce(Self) -> T) -> T {
        operation(self)
    }
}

impl<T> Pipe for T {}

#[cfg(test)]
mod tests {
    use super::{DecisionEvidence, canonical_hash, validate_required_text};
    use uuid::Uuid;

    #[test]
    fn review_decision_hashes_are_stable() {
        let evidence = DecisionEvidence {
            schema_version: "openrm-review-decision-v1",
            decision_id: Uuid::nil(),
            review_id: Uuid::nil(),
            baseline_id: Uuid::nil(),
            participant_id: Uuid::nil(),
            round: 1,
            decision: "approved",
            comment: "Evidence reviewed",
            decided_by: "reviewer",
        };
        assert_eq!(
            canonical_hash(&evidence).unwrap(),
            canonical_hash(&evidence).unwrap()
        );
        assert_eq!(canonical_hash(&evidence).unwrap().len(), 64);
    }

    #[test]
    fn review_text_validation_rejects_blank_content() {
        assert!(validate_required_text("   ", 20, "comment").is_err());
    }
}
