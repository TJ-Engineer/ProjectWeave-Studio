use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthenticatedPrincipal,
    error::ApiError,
    policy::{Action, Principal},
    projects::{authorize_project, insert_audit},
};

const IDEMPOTENCY_HEADER: &str = "x-idempotency-key";
const CREATE_COMMAND: &str = "relationship.create";
const RESOLVE_COMMAND: &str = "relationship.resolve";

#[derive(Debug, FromRow, Serialize)]
pub struct RelationshipTypeResponse {
    pub id: Uuid,
    pub key: String,
    pub name: String,
    pub source_artifact_type: String,
    pub target_artifact_type: String,
    pub max_targets_per_source: Option<i32>,
    pub max_sources_per_target: Option<i32>,
    pub propagates_suspect: bool,
}

#[derive(Debug, Serialize)]
pub struct RelationshipTypeListResponse {
    pub items: Vec<RelationshipTypeResponse>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CreateRelationshipRequest {
    pub relationship_type_id: Uuid,
    pub source_artifact_id: Uuid,
    pub target_artifact_id: Uuid,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ResolveRelationshipRequest {
    pub expected_version: i32,
    pub disposition: String,
}

#[derive(Debug, Deserialize)]
pub struct RelationshipListQuery {
    pub artifact_id: Option<Uuid>,
    pub direction: Option<String>,
}

#[derive(Debug, FromRow, Deserialize, Serialize)]
pub struct RelationshipResponse {
    pub id: Uuid,
    pub project_id: Uuid,
    pub relationship_type_id: Uuid,
    pub relationship_type_key: String,
    pub relationship_type_name: String,
    pub source_artifact_id: Uuid,
    pub source_key: String,
    pub source_title: String,
    pub source_revision: i32,
    pub target_artifact_id: Uuid,
    pub target_key: String,
    pub target_title: String,
    pub target_revision: i32,
    pub version: i32,
    pub suspect: bool,
    pub suspect_reason: Option<String>,
    pub disposition: Option<String>,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub version_created_by: String,
    pub version_created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct RelationshipListResponse {
    pub items: Vec<RelationshipResponse>,
}

#[derive(Debug, FromRow, Serialize)]
pub struct RelationshipRevisionResponse {
    pub id: Uuid,
    pub version: i32,
    pub source_revision: i32,
    pub target_revision: i32,
    pub suspect: bool,
    pub suspect_reason: Option<String>,
    pub disposition: Option<String>,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct RelationshipRevisionListResponse {
    pub items: Vec<RelationshipRevisionResponse>,
}

#[derive(Debug, FromRow)]
struct RelationshipRule {
    id: Uuid,
    source_artifact_type_id: Uuid,
    target_artifact_type_id: Uuid,
    max_targets_per_source: Option<i32>,
    max_sources_per_target: Option<i32>,
}

#[derive(Debug, FromRow)]
struct ArtifactEndpoint {
    id: Uuid,
    artifact_type_id: Uuid,
    current_revision_id: Uuid,
}

#[derive(Debug, FromRow)]
struct StoredCommand {
    request_fingerprint: String,
    response_payload: Value,
}

#[derive(Debug, FromRow)]
struct ResolutionContext {
    id: Uuid,
    relationship_type_id: Uuid,
    source_artifact_id: Uuid,
    source_revision_id: Uuid,
    target_artifact_id: Uuid,
    target_revision_id: Uuid,
    current_version: i32,
    suspect: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Direction {
    Both,
    Source,
    Target,
}

impl Direction {
    fn as_str(self) -> &'static str {
        match self {
            Self::Both => "both",
            Self::Source => "source",
            Self::Target => "target",
        }
    }
}

pub async fn list_relationship_types(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
) -> Result<Json<RelationshipTypeListResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Read).await?;
    let items = sqlx::query_as::<_, RelationshipTypeResponse>(
        r#"
        SELECT rt.id, rt.key, rt.name,
               source_type.key AS source_artifact_type,
               target_type.key AS target_artifact_type,
               rt.max_targets_per_source, rt.max_sources_per_target,
               rt.propagates_suspect
        FROM relationship_types rt
        JOIN artifact_types source_type
          ON source_type.organization_id = rt.organization_id
         AND source_type.project_id = rt.project_id
         AND source_type.id = rt.source_artifact_type_id
        JOIN artifact_types target_type
          ON target_type.organization_id = rt.organization_id
         AND target_type.project_id = rt.project_id
         AND target_type.id = rt.target_artifact_type_id
        WHERE rt.organization_id = $1 AND rt.project_id = $2
        ORDER BY rt.key
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .map_err(database_error)?;
    Ok(Json(RelationshipTypeListResponse { items }))
}

pub async fn list_relationships(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
    Query(query): Query<RelationshipListQuery>,
) -> Result<Json<RelationshipListResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Read).await?;
    let direction = parse_direction(query.direction.as_deref())?;
    if query.artifact_id.is_none() && direction != Direction::Both {
        return Err(ApiError::bad_request(
            "direction requires an artifact_id filter",
        ));
    }
    let items = sqlx::query_as::<_, RelationshipResponse>(
        r#"
        SELECT r.id, r.project_id,
               rt.id AS relationship_type_id,
               rt.key AS relationship_type_key,
               rt.name AS relationship_type_name,
               source.id AS source_artifact_id,
               source.key AS source_key,
               source.title AS source_title,
               source_revision.revision_number AS source_revision,
               target.id AS target_artifact_id,
               target.key AS target_key,
               target.title AS target_title,
               target_revision.revision_number AS target_revision,
               revision.version, revision.suspect, revision.suspect_reason, revision.disposition,
               r.created_by, r.created_at, r.updated_at,
               revision.created_by AS version_created_by,
               revision.created_at AS version_created_at
        FROM relationships r
        JOIN relationship_types rt
          ON rt.organization_id = r.organization_id
         AND rt.project_id = r.project_id
         AND rt.id = r.relationship_type_id
        JOIN relationship_revisions revision
          ON revision.organization_id = r.organization_id
         AND revision.project_id = r.project_id
         AND revision.relationship_id = r.id
         AND revision.id = r.current_revision_id
        JOIN artifacts source
          ON source.organization_id = r.organization_id
         AND source.project_id = r.project_id
         AND source.id = r.source_artifact_id
        JOIN artifact_revisions source_revision
          ON source_revision.organization_id = revision.organization_id
         AND source_revision.project_id = revision.project_id
         AND source_revision.artifact_id = revision.source_artifact_id
         AND source_revision.id = revision.source_revision_id
        JOIN artifacts target
          ON target.organization_id = r.organization_id
         AND target.project_id = r.project_id
         AND target.id = r.target_artifact_id
        JOIN artifact_revisions target_revision
          ON target_revision.organization_id = revision.organization_id
         AND target_revision.project_id = revision.project_id
         AND target_revision.artifact_id = revision.target_artifact_id
         AND target_revision.id = revision.target_revision_id
        WHERE r.organization_id = $1 AND r.project_id = $2
          AND (
            $3::uuid IS NULL
            OR ($4 = 'both' AND (r.source_artifact_id = $3 OR r.target_artifact_id = $3))
            OR ($4 = 'source' AND r.source_artifact_id = $3)
            OR ($4 = 'target' AND r.target_artifact_id = $3)
          )
        ORDER BY source.key, rt.key, target.key, r.id
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(query.artifact_id)
    .bind(direction.as_str())
    .fetch_all(&state.db)
    .await
    .map_err(database_error)?;
    Ok(Json(RelationshipListResponse { items }))
}

pub async fn create_relationship(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<CreateRelationshipRequest>,
) -> Result<(StatusCode, Json<RelationshipResponse>), ApiError> {
    authorize_project(&state, &principal, project_id, Action::Write).await?;
    validate_distinct_endpoints(&request)?;
    let idempotency_key = parse_idempotency_key(&headers)?;
    let fingerprint = serde_json::to_string(&(project_id, &request))
        .map_err(|_| ApiError::internal("Could not fingerprint relationship command"))?;
    if let Some(stored) =
        find_command(&state.db, &principal, CREATE_COMMAND, idempotency_key).await?
    {
        if stored.request_fingerprint != fingerprint {
            return Err(ApiError::conflict(
                "Idempotency key was already used with a different relationship request",
            ));
        }
        let response = serde_json::from_value(stored.response_payload)
            .map_err(|_| ApiError::internal("Stored relationship response is invalid"))?;
        return Ok((StatusCode::OK, Json(response)));
    }

    let mut transaction = state.db.begin().await.map_err(database_error)?;
    let rule = fetch_rule(
        &mut transaction,
        &principal,
        project_id,
        request.relationship_type_id,
    )
    .await?;
    let source = fetch_endpoint(
        &mut transaction,
        &principal,
        project_id,
        request.source_artifact_id,
        "Source artifact",
    )
    .await?;
    let target = fetch_endpoint(
        &mut transaction,
        &principal,
        project_id,
        request.target_artifact_id,
        "Target artifact",
    )
    .await?;
    if source.artifact_type_id != rule.source_artifact_type_id
        || target.artifact_type_id != rule.target_artifact_type_id
    {
        return Err(ApiError::bad_request(
            "Relationship endpoints do not match the type's directed source and target rules",
        ));
    }
    enforce_cardinality(
        &mut transaction,
        &principal,
        project_id,
        &rule,
        source.id,
        target.id,
    )
    .await?;

    let relationship_id = Uuid::new_v4();
    let revision_id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO relationships (
            id, organization_id, project_id, relationship_type_id,
            source_artifact_id, target_artifact_id,
            current_revision_id, current_version, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8)
        "#,
    )
    .bind(relationship_id)
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(rule.id)
    .bind(source.id)
    .bind(target.id)
    .bind(revision_id)
    .bind(&principal.subject)
    .execute(&mut *transaction)
    .await
    .map_err(relationship_insert_error)?;
    sqlx::query(
        r#"
        INSERT INTO relationship_revisions (
            id, organization_id, project_id, relationship_id, version,
            relationship_type_id, source_artifact_id, source_revision_id,
            target_artifact_id, target_revision_id, created_by
        )
        VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10)
        "#,
    )
    .bind(revision_id)
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(relationship_id)
    .bind(rule.id)
    .bind(source.id)
    .bind(source.current_revision_id)
    .bind(target.id)
    .bind(target.current_revision_id)
    .bind(&principal.subject)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;

    insert_audit(
        &mut transaction,
        &principal,
        project_id,
        "relationship.created",
        "relationship",
        relationship_id,
        serde_json::json!({
            "relationship_type_id": rule.id,
            "source_artifact_id": source.id,
            "source_revision_id": source.current_revision_id,
            "target_artifact_id": target.id,
            "target_revision_id": target.current_revision_id,
            "version": 1
        }),
    )
    .await?;

    let response =
        fetch_relationship(&mut transaction, &principal, project_id, relationship_id).await?;
    let response_payload = serde_json::to_value(&response)
        .map_err(|_| ApiError::internal("Could not store relationship response"))?;
    sqlx::query(
        r#"
        INSERT INTO command_results (
            organization_id, actor_subject, command_name, idempotency_key,
            request_fingerprint, aggregate_type, aggregate_id, response_revision, response_payload
        )
        VALUES ($1, $2, $3, $4, $5, 'relationship', $6, 1, $7)
        "#,
    )
    .bind(principal.organization_id)
    .bind(&principal.subject)
    .bind(CREATE_COMMAND)
    .bind(idempotency_key)
    .bind(fingerprint)
    .bind(relationship_id)
    .bind(response_payload)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;
    Ok((StatusCode::CREATED, Json(response)))
}

pub async fn resolve_relationship(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path((project_id, relationship_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(request): Json<ResolveRelationshipRequest>,
) -> Result<Json<RelationshipResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Review).await?;
    if request.expected_version < 1 {
        return Err(ApiError::bad_request("expected_version must be positive"));
    }
    let disposition = request.disposition.trim();
    if disposition.is_empty() || disposition.chars().count() > 2_000 {
        return Err(ApiError::bad_request(
            "disposition must contain 1-2000 characters",
        ));
    }
    let idempotency_key = parse_idempotency_key(&headers)?;
    let fingerprint = serde_json::to_string(&(
        project_id,
        relationship_id,
        request.expected_version,
        disposition,
    ))
    .map_err(|_| ApiError::internal("Could not fingerprint relationship resolution"))?;
    if let Some(stored) =
        find_command(&state.db, &principal, RESOLVE_COMMAND, idempotency_key).await?
    {
        if stored.request_fingerprint != fingerprint {
            return Err(ApiError::conflict(
                "Idempotency key was already used with a different resolution request",
            ));
        }
        let response = serde_json::from_value(stored.response_payload)
            .map_err(|_| ApiError::internal("Stored relationship resolution is invalid"))?;
        return Ok(Json(response));
    }

    let mut transaction = state.db.begin().await.map_err(database_error)?;
    let current = sqlx::query_as::<_, ResolutionContext>(
        r#"
        SELECT r.id, r.relationship_type_id, r.source_artifact_id,
               source.current_revision_id AS source_revision_id,
               r.target_artifact_id, target.current_revision_id AS target_revision_id,
               r.current_version, revision.suspect
        FROM relationships r
        JOIN relationship_revisions revision
          ON revision.organization_id = r.organization_id
         AND revision.project_id = r.project_id
         AND revision.relationship_id = r.id
         AND revision.id = r.current_revision_id
        JOIN artifacts source
          ON source.organization_id = r.organization_id
         AND source.project_id = r.project_id
         AND source.id = r.source_artifact_id
        JOIN artifacts target
          ON target.organization_id = r.organization_id
         AND target.project_id = r.project_id
         AND target.id = r.target_artifact_id
        WHERE r.organization_id = $1 AND r.project_id = $2 AND r.id = $3
        FOR UPDATE OF r
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(relationship_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?
    .ok_or_else(|| ApiError::not_found("Relationship does not exist"))?;
    if current.current_version != request.expected_version {
        return Err(ApiError::conflict_with_details(
            "Relationship has changed since it was read",
            serde_json::json!({
                "expected_version": request.expected_version,
                "current_version": current.current_version
            }),
        ));
    }
    if !current.suspect {
        return Err(ApiError::conflict("Relationship is not suspect"));
    }

    let next_version = current.current_version + 1;
    let revision_id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO relationship_revisions (
            id, organization_id, project_id, relationship_id, version,
            relationship_type_id, source_artifact_id, source_revision_id,
            target_artifact_id, target_revision_id, suspect, disposition, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, $11, $12)
        "#,
    )
    .bind(revision_id)
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(current.id)
    .bind(next_version)
    .bind(current.relationship_type_id)
    .bind(current.source_artifact_id)
    .bind(current.source_revision_id)
    .bind(current.target_artifact_id)
    .bind(current.target_revision_id)
    .bind(disposition)
    .bind(&principal.subject)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    sqlx::query(
        r#"
        UPDATE relationships
        SET current_revision_id = $4, current_version = $5, updated_at = now()
        WHERE organization_id = $1 AND project_id = $2 AND id = $3
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(current.id)
    .bind(revision_id)
    .bind(next_version)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    insert_audit(
        &mut transaction,
        &principal,
        project_id,
        "relationship.suspect_resolved",
        "relationship",
        current.id,
        serde_json::json!({
            "from_version": current.current_version,
            "to_version": next_version,
            "source_revision_id": current.source_revision_id,
            "target_revision_id": current.target_revision_id,
            "disposition": disposition
        }),
    )
    .await?;
    let response = fetch_relationship(&mut transaction, &principal, project_id, current.id).await?;
    let response_payload = serde_json::to_value(&response)
        .map_err(|_| ApiError::internal("Could not store relationship resolution"))?;
    sqlx::query(
        r#"
        INSERT INTO command_results (
            organization_id, actor_subject, command_name, idempotency_key,
            request_fingerprint, aggregate_type, aggregate_id, response_revision, response_payload
        )
        VALUES ($1, $2, $3, $4, $5, 'relationship', $6, $7, $8)
        "#,
    )
    .bind(principal.organization_id)
    .bind(&principal.subject)
    .bind(RESOLVE_COMMAND)
    .bind(idempotency_key)
    .bind(fingerprint)
    .bind(current.id)
    .bind(next_version)
    .bind(response_payload)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;
    Ok(Json(response))
}

pub async fn list_relationship_revisions(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path((project_id, relationship_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<RelationshipRevisionListResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Read).await?;
    let exists = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM relationships
            WHERE organization_id = $1 AND project_id = $2 AND id = $3
        )
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(relationship_id)
    .fetch_one(&state.db)
    .await
    .map_err(database_error)?;
    if !exists {
        return Err(ApiError::not_found("Relationship does not exist"));
    }
    let items = sqlx::query_as::<_, RelationshipRevisionResponse>(
        r#"
        SELECT revision.id, revision.version,
               source_revision.revision_number AS source_revision,
               target_revision.revision_number AS target_revision,
               revision.suspect, revision.suspect_reason, revision.disposition,
               revision.created_by, revision.created_at
        FROM relationship_revisions revision
        JOIN artifact_revisions source_revision
          ON source_revision.organization_id = revision.organization_id
         AND source_revision.project_id = revision.project_id
         AND source_revision.artifact_id = revision.source_artifact_id
         AND source_revision.id = revision.source_revision_id
        JOIN artifact_revisions target_revision
          ON target_revision.organization_id = revision.organization_id
         AND target_revision.project_id = revision.project_id
         AND target_revision.artifact_id = revision.target_artifact_id
         AND target_revision.id = revision.target_revision_id
        WHERE revision.organization_id = $1 AND revision.project_id = $2
          AND revision.relationship_id = $3
        ORDER BY revision.version DESC
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(relationship_id)
    .fetch_all(&state.db)
    .await
    .map_err(database_error)?;
    Ok(Json(RelationshipRevisionListResponse { items }))
}

async fn fetch_rule(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    project_id: Uuid,
    relationship_type_id: Uuid,
) -> Result<RelationshipRule, ApiError> {
    sqlx::query_as::<_, RelationshipRule>(
        r#"
        SELECT id, source_artifact_type_id, target_artifact_type_id,
               max_targets_per_source, max_sources_per_target
        FROM relationship_types
        WHERE organization_id = $1 AND project_id = $2 AND id = $3
        FOR UPDATE
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(relationship_type_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(database_error)?
    .ok_or_else(|| ApiError::not_found("Relationship type does not exist"))
}

async fn fetch_endpoint(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    project_id: Uuid,
    artifact_id: Uuid,
    label: &str,
) -> Result<ArtifactEndpoint, ApiError> {
    sqlx::query_as::<_, ArtifactEndpoint>(
        r#"
        SELECT id, artifact_type_id, current_revision_id
        FROM artifacts
        WHERE organization_id = $1 AND project_id = $2 AND id = $3
        FOR SHARE
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(artifact_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(database_error)?
    .ok_or_else(|| ApiError::not_found(format!("{label} does not exist")))
}

async fn enforce_cardinality(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    project_id: Uuid,
    rule: &RelationshipRule,
    source_id: Uuid,
    target_id: Uuid,
) -> Result<(), ApiError> {
    if let Some(maximum) = rule.max_targets_per_source {
        let count = sqlx::query_scalar::<_, i64>(
            r#"
            SELECT count(*)
            FROM relationships
            WHERE organization_id = $1 AND project_id = $2
              AND relationship_type_id = $3 AND source_artifact_id = $4
            "#,
        )
        .bind(principal.organization_id)
        .bind(project_id)
        .bind(rule.id)
        .bind(source_id)
        .fetch_one(&mut **transaction)
        .await
        .map_err(database_error)?;
        if count >= i64::from(maximum) {
            return Err(ApiError::conflict(
                "Relationship type target cardinality has been reached for the source artifact",
            ));
        }
    }
    if let Some(maximum) = rule.max_sources_per_target {
        let count = sqlx::query_scalar::<_, i64>(
            r#"
            SELECT count(*)
            FROM relationships
            WHERE organization_id = $1 AND project_id = $2
              AND relationship_type_id = $3 AND target_artifact_id = $4
            "#,
        )
        .bind(principal.organization_id)
        .bind(project_id)
        .bind(rule.id)
        .bind(target_id)
        .fetch_one(&mut **transaction)
        .await
        .map_err(database_error)?;
        if count >= i64::from(maximum) {
            return Err(ApiError::conflict(
                "Relationship type source cardinality has been reached for the target artifact",
            ));
        }
    }
    Ok(())
}

async fn fetch_relationship(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    project_id: Uuid,
    relationship_id: Uuid,
) -> Result<RelationshipResponse, ApiError> {
    sqlx::query_as::<_, RelationshipResponse>(
        r#"
        SELECT r.id, r.project_id,
               rt.id AS relationship_type_id,
               rt.key AS relationship_type_key,
               rt.name AS relationship_type_name,
               source.id AS source_artifact_id,
               source.key AS source_key,
               source.title AS source_title,
               source_revision.revision_number AS source_revision,
               target.id AS target_artifact_id,
               target.key AS target_key,
               target.title AS target_title,
               target_revision.revision_number AS target_revision,
               revision.version, revision.suspect, revision.suspect_reason, revision.disposition,
               r.created_by, r.created_at, r.updated_at,
               revision.created_by AS version_created_by,
               revision.created_at AS version_created_at
        FROM relationships r
        JOIN relationship_types rt
          ON rt.organization_id = r.organization_id
         AND rt.project_id = r.project_id
         AND rt.id = r.relationship_type_id
        JOIN relationship_revisions revision
          ON revision.organization_id = r.organization_id
         AND revision.project_id = r.project_id
         AND revision.relationship_id = r.id
         AND revision.id = r.current_revision_id
        JOIN artifacts source
          ON source.organization_id = r.organization_id
         AND source.project_id = r.project_id
         AND source.id = r.source_artifact_id
        JOIN artifact_revisions source_revision
          ON source_revision.organization_id = revision.organization_id
         AND source_revision.project_id = revision.project_id
         AND source_revision.artifact_id = revision.source_artifact_id
         AND source_revision.id = revision.source_revision_id
        JOIN artifacts target
          ON target.organization_id = r.organization_id
         AND target.project_id = r.project_id
         AND target.id = r.target_artifact_id
        JOIN artifact_revisions target_revision
          ON target_revision.organization_id = revision.organization_id
         AND target_revision.project_id = revision.project_id
         AND target_revision.artifact_id = revision.target_artifact_id
         AND target_revision.id = revision.target_revision_id
        WHERE r.organization_id = $1 AND r.project_id = $2 AND r.id = $3
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(relationship_id)
    .fetch_one(&mut **transaction)
    .await
    .map_err(database_error)
}

async fn find_command(
    pool: &PgPool,
    principal: &Principal,
    command_name: &str,
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
    .bind(command_name)
    .bind(idempotency_key)
    .fetch_optional(pool)
    .await
    .map_err(database_error)
}

fn parse_direction(value: Option<&str>) -> Result<Direction, ApiError> {
    match value.unwrap_or("both") {
        "both" => Ok(Direction::Both),
        "source" => Ok(Direction::Source),
        "target" => Ok(Direction::Target),
        _ => Err(ApiError::bad_request(
            "direction must be one of both, source, or target",
        )),
    }
}

fn validate_distinct_endpoints(request: &CreateRelationshipRequest) -> Result<(), ApiError> {
    if request.source_artifact_id == request.target_artifact_id {
        return Err(ApiError::bad_request(
            "A relationship must connect two distinct artifacts",
        ));
    }
    Ok(())
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

fn relationship_insert_error(error: sqlx::Error) -> ApiError {
    if error
        .as_database_error()
        .and_then(|error| error.code())
        .as_deref()
        == Some("23505")
    {
        return ApiError::conflict("Relationship already exists");
    }
    database_error(error)
}

fn database_error(error: sqlx::Error) -> ApiError {
    tracing::warn!(%error, "relationship database operation failed");
    ApiError::unavailable("Relationship database operation failed")
}

#[cfg(test)]
mod tests {
    use super::{
        CreateRelationshipRequest, Direction, parse_direction, validate_distinct_endpoints,
    };
    use uuid::Uuid;

    #[test]
    fn validates_relationship_direction_filters() {
        assert_eq!(parse_direction(None).unwrap(), Direction::Both);
        assert_eq!(parse_direction(Some("source")).unwrap(), Direction::Source);
        assert_eq!(parse_direction(Some("target")).unwrap(), Direction::Target);
        assert!(parse_direction(Some("sideways")).is_err());
    }

    #[test]
    fn rejects_self_relationships() {
        let artifact_id = Uuid::new_v4();
        assert!(
            validate_distinct_endpoints(&CreateRelationshipRequest {
                relationship_type_id: Uuid::new_v4(),
                source_artifact_id: artifact_id,
                target_artifact_id: artifact_id,
            })
            .is_err()
        );
    }
}
