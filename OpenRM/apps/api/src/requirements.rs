use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthenticatedPrincipal,
    authorize,
    error::ApiError,
    policy::{Action, Principal},
    projects::{authorize_project, insert_audit},
};

const IDEMPOTENCY_HEADER: &str = "x-idempotency-key";
const CREATE_COMMAND: &str = "requirement.create";
const DERIVE_COMMAND: &str = "requirement.derive";
const REVISE_COMMAND: &str = "requirement.revise";

#[derive(Debug, FromRow, Serialize)]
pub struct ProjectSummary {
    pub id: Uuid,
    pub key: String,
    pub name: String,
    pub requirement_prefix: String,
    pub next_requirement_number: i64,
    pub description: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct ProjectListResponse {
    pub items: Vec<ProjectSummary>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CreateRequirementRequest {
    #[serde(default)]
    pub key: Option<String>,
    pub title: String,
    pub statement: String,
    #[serde(default = "empty_object")]
    pub attributes: Value,
    pub folder_id: Option<Uuid>,
    #[serde(default)]
    pub tag_ids: Vec<Uuid>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ReviseRequirementRequest {
    pub expected_revision: i32,
    pub title: String,
    pub statement: String,
    #[serde(default = "empty_object")]
    pub attributes: Value,
    pub folder_id: Option<Uuid>,
    #[serde(default)]
    pub tag_ids: Vec<Uuid>,
}

#[derive(Clone, Debug, Serialize)]
struct ValidatedRequirement {
    key: Option<String>,
    title: String,
    statement: String,
    attributes: Value,
    folder_id: Option<Uuid>,
    tag_ids: Vec<Uuid>,
}

#[derive(Debug, FromRow)]
struct RequirementRecord {
    id: Uuid,
    project_id: Uuid,
    key: String,
    title: String,
    statement: String,
    attributes: Value,
    folder_id: Option<Uuid>,
    tag_ids: Vec<Uuid>,
    revision: i32,
    created_by: String,
    author_label: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct RequirementResponse {
    pub id: Uuid,
    pub project_id: Uuid,
    pub key: String,
    pub title: String,
    pub statement: String,
    pub attributes: Value,
    pub folder_id: Option<Uuid>,
    pub tag_ids: Vec<Uuid>,
    pub revision: i32,
    pub created_by: String,
    #[serde(default)]
    pub created_by_name: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl From<RequirementRecord> for RequirementResponse {
    fn from(record: RequirementRecord) -> Self {
        Self {
            id: record.id,
            project_id: record.project_id,
            key: record.key,
            title: record.title,
            statement: record.statement,
            attributes: record.attributes,
            folder_id: record.folder_id,
            tag_ids: record.tag_ids,
            revision: record.revision,
            created_by: record.created_by,
            created_by_name: abbreviate_author_label(&record.author_label),
            created_at: record.created_at,
            updated_at: record.updated_at,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct RequirementListQuery {
    pub search: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub folder_id: Option<Uuid>,
    pub tag_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
pub struct RequirementListResponse {
    pub items: Vec<RequirementResponse>,
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
}

#[derive(Debug, FromRow)]
struct RequirementRevisionRecord {
    id: Uuid,
    revision: i32,
    title: String,
    statement: String,
    attributes: Value,
    folder_id: Option<Uuid>,
    tag_ids: Vec<Uuid>,
    created_by: String,
    author_label: String,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct RequirementRevisionResponse {
    pub id: Uuid,
    pub revision: i32,
    pub title: String,
    pub statement: String,
    pub attributes: Value,
    pub folder_id: Option<Uuid>,
    pub tag_ids: Vec<Uuid>,
    pub created_by: String,
    pub created_by_name: String,
    pub created_at: DateTime<Utc>,
}

impl From<RequirementRevisionRecord> for RequirementRevisionResponse {
    fn from(record: RequirementRevisionRecord) -> Self {
        Self {
            id: record.id,
            revision: record.revision,
            title: record.title,
            statement: record.statement,
            attributes: record.attributes,
            folder_id: record.folder_id,
            tag_ids: record.tag_ids,
            created_by: record.created_by,
            created_by_name: abbreviate_author_label(&record.author_label),
            created_at: record.created_at,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct RequirementRevisionListResponse {
    pub items: Vec<RequirementRevisionResponse>,
}

#[derive(Debug, Deserialize)]
pub struct RequirementComparisonQuery {
    pub from_revision: i32,
    pub to_revision: i32,
}

#[derive(Debug, Serialize)]
pub struct RequirementComparisonResponse {
    pub requirement_id: Uuid,
    pub from: RequirementRevisionResponse,
    pub to: RequirementRevisionResponse,
    pub changed_fields: Vec<&'static str>,
}

#[derive(Debug, Deserialize)]
pub struct RequirementImportRequest {
    pub items: Vec<CreateRequirementRequest>,
}

#[derive(Debug, Serialize)]
pub struct RequirementImportResponse {
    pub items: Vec<RequirementResponse>,
    pub imported: usize,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct DerivedRequirementResponse {
    pub requirement: RequirementResponse,
    pub relationship_id: Uuid,
}

#[derive(Debug, FromRow)]
struct CommandResult {
    request_fingerprint: String,
    response_payload: Value,
}

#[derive(Debug, FromRow)]
struct AttributeDefinition {
    key: String,
    value_type: String,
    required: bool,
    config: Value,
}

pub async fn list_projects(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
) -> Result<Json<ProjectListResponse>, ApiError> {
    authorize(&state, &principal, Action::Read)?;
    let administrator = principal.roles.iter().any(|role| role == "administrator");
    let items = sqlx::query_as::<_, ProjectSummary>(
        r#"
        SELECT p.id, p.key, p.name, p.requirement_prefix,
               p.next_requirement_number, p.description, p.created_at
        FROM projects p
        WHERE p.organization_id = $1
          AND (
            $2 OR EXISTS (
              SELECT 1 FROM project_memberships m
              WHERE m.organization_id = p.organization_id
                AND m.project_id = p.id
                AND m.subject = $3
            )
          )
        ORDER BY p.key
        "#,
    )
    .bind(principal.organization_id)
    .bind(administrator)
    .bind(&principal.subject)
    .fetch_all(&state.db)
    .await
    .map_err(database_error)?;
    Ok(Json(ProjectListResponse { items }))
}

pub async fn list_requirements(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
    Query(query): Query<RequirementListQuery>,
) -> Result<Json<RequirementListResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Read).await?;

    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    let offset = query.offset.unwrap_or(0).max(0);
    let search = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let items = sqlx::query_as::<_, RequirementRecord>(
        r#"
        SELECT a.id, a.project_id, a.key, a.title, a.statement, a.attributes, a.folder_id,
               COALESCE((
                 SELECT array_agg(at.tag_id ORDER BY at.tag_id)
                 FROM artifact_tags at
                 WHERE at.organization_id = a.organization_id
                   AND at.project_id = a.project_id AND at.artifact_id = a.id
               ), '{}'::uuid[]) AS tag_ids,
               a.current_revision_number AS revision, a.created_by,
               COALESCE((
                 SELECT COALESCE(NULLIF(btrim(ui.display_name), ''), NULLIF(btrim(ui.email), ''))
                 FROM user_identities ui
                 JOIN organization_memberships om ON om.user_identity_id = ui.id
                 WHERE om.organization_id = a.organization_id AND ui.subject = a.created_by
                 ORDER BY ui.updated_at DESC, ui.created_at DESC
                 LIMIT 1
               ), a.created_by) AS author_label,
               a.created_at, a.updated_at
        FROM artifacts a
        JOIN artifact_types t
          ON t.organization_id = a.organization_id
         AND t.project_id = a.project_id
         AND t.id = a.artifact_type_id
        WHERE a.organization_id = $1
          AND a.project_id = $2
          AND t.key = 'REQUIREMENT'
          AND (
            $3::text IS NULL OR
            to_tsvector('english', a.key || ' ' || a.title || ' ' || a.statement)
              @@ websearch_to_tsquery('english', $3)
          )
          AND ($4::uuid IS NULL OR a.folder_id = $4)
          AND ($5::uuid IS NULL OR EXISTS (
            SELECT 1 FROM artifact_tags filter_tag
            WHERE filter_tag.organization_id = a.organization_id
              AND filter_tag.project_id = a.project_id
              AND filter_tag.artifact_id = a.id
              AND filter_tag.tag_id = $5
          ))
        ORDER BY a.updated_at DESC, a.key
        LIMIT $6 OFFSET $7
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(search)
    .bind(query.folder_id)
    .bind(query.tag_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await
    .map_err(database_error)?;

    let total = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT count(*)
        FROM artifacts a
        JOIN artifact_types t
          ON t.organization_id = a.organization_id
         AND t.project_id = a.project_id
         AND t.id = a.artifact_type_id
        WHERE a.organization_id = $1
          AND a.project_id = $2
          AND t.key = 'REQUIREMENT'
          AND (
            $3::text IS NULL OR
            to_tsvector('english', a.key || ' ' || a.title || ' ' || a.statement)
              @@ websearch_to_tsquery('english', $3)
          )
          AND ($4::uuid IS NULL OR a.folder_id = $4)
          AND ($5::uuid IS NULL OR EXISTS (
            SELECT 1 FROM artifact_tags filter_tag
            WHERE filter_tag.organization_id = a.organization_id
              AND filter_tag.project_id = a.project_id
              AND filter_tag.artifact_id = a.id
              AND filter_tag.tag_id = $5
          ))
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(search)
    .bind(query.folder_id)
    .bind(query.tag_id)
    .fetch_one(&state.db)
    .await
    .map_err(database_error)?;

    Ok(Json(RequirementListResponse {
        items: items.into_iter().map(RequirementResponse::from).collect(),
        total,
        limit,
        offset,
    }))
}

pub async fn create_requirement(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<CreateRequirementRequest>,
) -> Result<(StatusCode, Json<RequirementResponse>), ApiError> {
    authorize_project(&state, &principal, project_id, Action::Write).await?;
    let idempotency_key = parse_idempotency_key(&headers)?;
    let requirement = validate_create(request)?;
    validate_requirement_workspace(&state.db, &principal, project_id, &requirement).await?;
    let fingerprint = serde_json::to_string(&(project_id, &requirement))
        .map_err(|_| ApiError::internal("Could not fingerprint requirement command"))?;

    if let Some(command) =
        find_command_result(&state.db, &principal, CREATE_COMMAND, idempotency_key).await?
    {
        if command.request_fingerprint != fingerprint {
            return Err(ApiError::conflict(
                "Idempotency key was already used with a different request",
            ));
        }
        let existing = serde_json::from_value::<RequirementResponse>(command.response_payload)
            .map_err(|_| ApiError::internal("Stored command response is invalid"))?;
        return Ok((StatusCode::OK, Json(existing)));
    }

    let mut transaction = state.db.begin().await.map_err(database_error)?;
    let artifact_type_id = sqlx::query_scalar::<_, Uuid>(
        r#"
        SELECT id
        FROM artifact_types
        WHERE organization_id = $1 AND project_id = $2 AND key = 'REQUIREMENT'
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?
    .ok_or_else(|| ApiError::not_found("Project does not exist"))?;

    let requirement_key = allocate_requirement_key(
        &mut transaction,
        &principal,
        project_id,
        requirement.key.as_deref(),
    )
    .await?;

    let artifact_id = Uuid::new_v4();
    let revision_id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO artifacts (
            id, organization_id, project_id, artifact_type_id, key, title, statement,
            attributes, folder_id, current_revision_id, current_revision_number, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11)
        "#,
    )
    .bind(artifact_id)
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(artifact_type_id)
    .bind(&requirement_key)
    .bind(&requirement.title)
    .bind(&requirement.statement)
    .bind(&requirement.attributes)
    .bind(requirement.folder_id)
    .bind(revision_id)
    .bind(&principal.subject)
    .execute(&mut *transaction)
    .await
    .map_err(requirement_insert_error)?;

    sqlx::query(
        r#"
        INSERT INTO artifact_revisions (
            id, organization_id, project_id, artifact_id, revision_number,
            title, statement, attributes, folder_id, tag_ids, created_by
        )
        VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10)
        "#,
    )
    .bind(revision_id)
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(artifact_id)
    .bind(&requirement.title)
    .bind(&requirement.statement)
    .bind(&requirement.attributes)
    .bind(requirement.folder_id)
    .bind(&requirement.tag_ids)
    .bind(&principal.subject)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;

    replace_tags(
        &mut transaction,
        &principal,
        project_id,
        artifact_id,
        &requirement.tag_ids,
    )
    .await?;

    insert_audit_event(
        &mut transaction,
        &principal,
        project_id,
        artifact_id,
        "requirement.created",
        json!({"key": requirement_key, "revision": 1}),
    )
    .await?;

    let created = sqlx::query_as::<_, RequirementRecord>(
        r#"
        SELECT a.id, a.project_id, a.key, a.title, a.statement, a.attributes, a.folder_id,
               $4::uuid[] AS tag_ids,
               a.current_revision_number AS revision, a.created_by,
               COALESCE((
                 SELECT COALESCE(NULLIF(btrim(ui.display_name), ''), NULLIF(btrim(ui.email), ''))
                 FROM user_identities ui
                 JOIN organization_memberships om ON om.user_identity_id = ui.id
                 WHERE om.organization_id = a.organization_id AND ui.subject = a.created_by
                 ORDER BY ui.updated_at DESC, ui.created_at DESC
                 LIMIT 1
               ), a.created_by) AS author_label,
               a.created_at, a.updated_at
        FROM artifacts a
        WHERE a.organization_id = $1 AND a.project_id = $2 AND a.id = $3
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(artifact_id)
    .bind(&requirement.tag_ids)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?;
    let created = RequirementResponse::from(created);
    let response_payload = serde_json::to_value(&created)
        .map_err(|_| ApiError::internal("Could not store command response"))?;

    sqlx::query(
        r#"
        INSERT INTO command_results (
            organization_id, actor_subject, command_name, idempotency_key,
            request_fingerprint, aggregate_type, aggregate_id, response_revision, response_payload
        )
        VALUES ($1, $2, $3, $4, $5, 'requirement', $6, 1, $7)
        "#,
    )
    .bind(principal.organization_id)
    .bind(&principal.subject)
    .bind(CREATE_COMMAND)
    .bind(idempotency_key)
    .bind(&fingerprint)
    .bind(artifact_id)
    .bind(response_payload)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;

    transaction.commit().await.map_err(database_error)?;
    Ok((StatusCode::CREATED, Json(created)))
}

pub async fn create_derived_requirement(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path((project_id, source_requirement_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(mut request): Json<CreateRequirementRequest>,
) -> Result<(StatusCode, Json<DerivedRequirementResponse>), ApiError> {
    authorize_project(&state, &principal, project_id, Action::Write).await?;
    let idempotency_key = parse_idempotency_key(&headers)?.to_owned();
    request.key = None;
    let requirement = validate_create(request)?;
    validate_requirement_workspace(&state.db, &principal, project_id, &requirement).await?;
    let fingerprint = serde_json::to_string(&(project_id, source_requirement_id, &requirement))
        .map_err(|_| ApiError::internal("Could not fingerprint derived requirement command"))?;
    if let Some(command) =
        find_command_result(&state.db, &principal, DERIVE_COMMAND, &idempotency_key).await?
    {
        if command.request_fingerprint != fingerprint {
            return Err(ApiError::conflict(
                "Idempotency key was already used with a different derived requirement request",
            ));
        }
        let existing =
            serde_json::from_value::<DerivedRequirementResponse>(command.response_payload)
                .map_err(|_| {
                    ApiError::internal("Stored derived requirement response is invalid")
                })?;
        return Ok((StatusCode::OK, Json(existing)));
    }

    let mut transaction = state.db.begin().await.map_err(database_error)?;
    let source_revision_id = sqlx::query_scalar::<_, Uuid>(
        r#"
        SELECT artifact.current_revision_id
        FROM artifacts artifact
        JOIN artifact_types artifact_type
          ON artifact_type.organization_id = artifact.organization_id
         AND artifact_type.project_id = artifact.project_id
         AND artifact_type.id = artifact.artifact_type_id
        WHERE artifact.organization_id = $1
          AND artifact.project_id = $2
          AND artifact.id = $3
          AND artifact_type.key = 'REQUIREMENT'
        FOR UPDATE OF artifact
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(source_requirement_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?
    .ok_or_else(|| ApiError::not_found("Base requirement does not exist"))?;
    let relationship_type_id = sqlx::query_scalar::<_, Uuid>(
        r#"
        SELECT id
        FROM relationship_types
        WHERE organization_id = $1 AND project_id = $2 AND key = 'DECOMPOSES_TO'
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?
    .ok_or_else(|| ApiError::not_found("DECOMPOSES_TO relationship type does not exist"))?;
    let artifact_type_id = sqlx::query_scalar::<_, Uuid>(
        r#"
        SELECT id FROM artifact_types
        WHERE organization_id = $1 AND project_id = $2 AND key = 'REQUIREMENT'
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?;
    let requirement_key =
        allocate_requirement_key(&mut transaction, &principal, project_id, None).await?;
    let artifact_id = Uuid::new_v4();
    let artifact_revision_id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO artifacts (
            id, organization_id, project_id, artifact_type_id, key, title, statement,
            attributes, folder_id, current_revision_id, current_revision_number, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11)
        "#,
    )
    .bind(artifact_id)
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(artifact_type_id)
    .bind(&requirement_key)
    .bind(&requirement.title)
    .bind(&requirement.statement)
    .bind(&requirement.attributes)
    .bind(requirement.folder_id)
    .bind(artifact_revision_id)
    .bind(&principal.subject)
    .execute(&mut *transaction)
    .await
    .map_err(requirement_insert_error)?;
    sqlx::query(
        r#"
        INSERT INTO artifact_revisions (
            id, organization_id, project_id, artifact_id, revision_number,
            title, statement, attributes, folder_id, tag_ids, created_by
        )
        VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10)
        "#,
    )
    .bind(artifact_revision_id)
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(artifact_id)
    .bind(&requirement.title)
    .bind(&requirement.statement)
    .bind(&requirement.attributes)
    .bind(requirement.folder_id)
    .bind(&requirement.tag_ids)
    .bind(&principal.subject)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    replace_tags(
        &mut transaction,
        &principal,
        project_id,
        artifact_id,
        &requirement.tag_ids,
    )
    .await?;
    insert_audit_event(
        &mut transaction,
        &principal,
        project_id,
        artifact_id,
        "requirement.derived",
        json!({
            "key": requirement_key,
            "revision": 1,
            "source_requirement_id": source_requirement_id,
        }),
    )
    .await?;

    let relationship_id = Uuid::new_v4();
    let relationship_revision_id = Uuid::new_v4();
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
    .bind(relationship_type_id)
    .bind(source_requirement_id)
    .bind(artifact_id)
    .bind(relationship_revision_id)
    .bind(&principal.subject)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
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
    .bind(relationship_revision_id)
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(relationship_id)
    .bind(relationship_type_id)
    .bind(source_requirement_id)
    .bind(source_revision_id)
    .bind(artifact_id)
    .bind(artifact_revision_id)
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
        json!({
            "relationship_type_id": relationship_type_id,
            "source_artifact_id": source_requirement_id,
            "source_revision_id": source_revision_id,
            "target_artifact_id": artifact_id,
            "target_revision_id": artifact_revision_id,
            "version": 1,
        }),
    )
    .await?;

    let created = sqlx::query_as::<_, RequirementRecord>(
        r#"
        SELECT a.id, a.project_id, a.key, a.title, a.statement, a.attributes, a.folder_id,
               $4::uuid[] AS tag_ids,
               a.current_revision_number AS revision, a.created_by,
               COALESCE((
                 SELECT COALESCE(NULLIF(btrim(ui.display_name), ''), NULLIF(btrim(ui.email), ''))
                 FROM user_identities ui
                 JOIN organization_memberships om ON om.user_identity_id = ui.id
                 WHERE om.organization_id = a.organization_id AND ui.subject = a.created_by
                 ORDER BY ui.updated_at DESC, ui.created_at DESC
                 LIMIT 1
               ), a.created_by) AS author_label,
               a.created_at, a.updated_at
        FROM artifacts a
        WHERE a.organization_id = $1 AND a.project_id = $2 AND a.id = $3
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(artifact_id)
    .bind(&requirement.tag_ids)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?;
    let response = DerivedRequirementResponse {
        requirement: created.into(),
        relationship_id,
    };
    let response_payload = serde_json::to_value(&response)
        .map_err(|_| ApiError::internal("Could not store derived requirement response"))?;
    sqlx::query(
        r#"
        INSERT INTO command_results (
            organization_id, actor_subject, command_name, idempotency_key,
            request_fingerprint, aggregate_type, aggregate_id, response_revision, response_payload
        )
        VALUES ($1, $2, $3, $4, $5, 'requirement', $6, 1, $7)
        "#,
    )
    .bind(principal.organization_id)
    .bind(&principal.subject)
    .bind(DERIVE_COMMAND)
    .bind(&idempotency_key)
    .bind(fingerprint)
    .bind(artifact_id)
    .bind(response_payload)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;
    Ok((StatusCode::CREATED, Json(response)))
}

pub async fn get_requirement(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path((project_id, requirement_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<RequirementResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Read).await?;
    let requirement = fetch_requirement(&state.db, &principal, project_id, requirement_id).await?;
    Ok(Json(requirement.into()))
}

pub async fn revise_requirement(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path((project_id, requirement_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(request): Json<ReviseRequirementRequest>,
) -> Result<Json<RequirementResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Write).await?;
    if request.expected_revision < 1 {
        return Err(ApiError::bad_request("expected_revision must be positive"));
    }
    let idempotency_key = parse_idempotency_key(&headers)?;
    let expected_revision = request.expected_revision;
    let content = validate_content(
        request.title,
        request.statement,
        request.attributes,
        request.folder_id,
        request.tag_ids,
    )?;
    validate_requirement_workspace(&state.db, &principal, project_id, &content).await?;
    let fingerprint =
        serde_json::to_string(&(project_id, requirement_id, expected_revision, &content))
            .map_err(|_| ApiError::internal("Could not fingerprint revision command"))?;
    if let Some(command) =
        find_command_result(&state.db, &principal, REVISE_COMMAND, idempotency_key).await?
    {
        if command.request_fingerprint != fingerprint {
            return Err(ApiError::conflict(
                "Idempotency key was already used with a different revision request",
            ));
        }
        let existing = serde_json::from_value::<RequirementResponse>(command.response_payload)
            .map_err(|_| ApiError::internal("Stored revision response is invalid"))?;
        return Ok(Json(existing));
    }

    let mut transaction = state.db.begin().await.map_err(database_error)?;
    let current = sqlx::query_as::<_, RequirementRecord>(
        r#"
        SELECT a.id, a.project_id, a.key, a.title, a.statement, a.attributes, a.folder_id,
               COALESCE((
                 SELECT array_agg(at.tag_id ORDER BY at.tag_id)
                 FROM artifact_tags at
                 WHERE at.organization_id = a.organization_id
                   AND at.project_id = a.project_id AND at.artifact_id = a.id
               ), '{}'::uuid[]) AS tag_ids,
               a.current_revision_number AS revision, a.created_by,
               COALESCE((
                 SELECT COALESCE(NULLIF(btrim(ui.display_name), ''), NULLIF(btrim(ui.email), ''))
                 FROM user_identities ui
                 JOIN organization_memberships om ON om.user_identity_id = ui.id
                 WHERE om.organization_id = a.organization_id AND ui.subject = a.created_by
                 ORDER BY ui.updated_at DESC, ui.created_at DESC
                 LIMIT 1
               ), a.created_by) AS author_label,
               a.created_at, a.updated_at
        FROM artifacts a
        JOIN artifact_types t
          ON t.organization_id = a.organization_id
         AND t.project_id = a.project_id
         AND t.id = a.artifact_type_id
        WHERE a.organization_id = $1 AND a.project_id = $2 AND a.id = $3
          AND t.key = 'REQUIREMENT'
        FOR UPDATE OF a
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(requirement_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?
    .ok_or_else(|| ApiError::not_found("Requirement does not exist"))?;

    if current.revision != expected_revision {
        return Err(ApiError::conflict_with_details(
            "Requirement has changed since it was read",
            json!({
                "expected_revision": expected_revision,
                "current_revision": current.revision,
            }),
        ));
    }

    let next_revision = current.revision + 1;
    let revision_id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO artifact_revisions (
            id, organization_id, project_id, artifact_id, revision_number,
            title, statement, attributes, folder_id, tag_ids, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        "#,
    )
    .bind(revision_id)
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(requirement_id)
    .bind(next_revision)
    .bind(&content.title)
    .bind(&content.statement)
    .bind(&content.attributes)
    .bind(content.folder_id)
    .bind(&content.tag_ids)
    .bind(&principal.subject)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;

    sqlx::query(
        r#"
        UPDATE artifacts
        SET title = $4, statement = $5, attributes = $6,
            folder_id = $7, current_revision_id = $8,
            current_revision_number = $9, updated_at = now()
        WHERE organization_id = $1 AND project_id = $2 AND id = $3
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(requirement_id)
    .bind(&content.title)
    .bind(&content.statement)
    .bind(&content.attributes)
    .bind(content.folder_id)
    .bind(revision_id)
    .bind(next_revision)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;

    replace_tags(
        &mut transaction,
        &principal,
        project_id,
        requirement_id,
        &content.tag_ids,
    )
    .await?;

    insert_audit_event(
        &mut transaction,
        &principal,
        project_id,
        requirement_id,
        "requirement.revised",
        json!({"from_revision": current.revision, "to_revision": next_revision}),
    )
    .await?;

    sqlx::query(
        r#"
        INSERT INTO outbox_messages (organization_id, topic, payload)
        VALUES ($1, 'relationship.source-revised', $2)
        "#,
    )
    .bind(principal.organization_id)
    .bind(json!({
        "project_id": project_id,
        "source_artifact_id": requirement_id,
        "source_revision_id": revision_id,
        "source_revision": next_revision
    }))
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;

    let updated = sqlx::query_as::<_, RequirementRecord>(
        r#"
        SELECT a.id, a.project_id, a.key, a.title, a.statement, a.attributes, a.folder_id,
               $4::uuid[] AS tag_ids,
               a.current_revision_number AS revision, a.created_by,
               COALESCE((
                 SELECT COALESCE(NULLIF(btrim(ui.display_name), ''), NULLIF(btrim(ui.email), ''))
                 FROM user_identities ui
                 JOIN organization_memberships om ON om.user_identity_id = ui.id
                 WHERE om.organization_id = a.organization_id AND ui.subject = a.created_by
                 ORDER BY ui.updated_at DESC, ui.created_at DESC
                 LIMIT 1
               ), a.created_by) AS author_label,
               a.created_at, a.updated_at
        FROM artifacts a
        WHERE a.organization_id = $1 AND a.project_id = $2 AND a.id = $3
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(requirement_id)
    .bind(&content.tag_ids)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?;
    let updated = RequirementResponse::from(updated);
    let response_payload = serde_json::to_value(&updated)
        .map_err(|_| ApiError::internal("Could not store revision response"))?;
    sqlx::query(
        r#"
        INSERT INTO command_results (
            organization_id, actor_subject, command_name, idempotency_key,
            request_fingerprint, aggregate_type, aggregate_id, response_revision, response_payload
        )
        VALUES ($1, $2, $3, $4, $5, 'requirement', $6, $7, $8)
        "#,
    )
    .bind(principal.organization_id)
    .bind(&principal.subject)
    .bind(REVISE_COMMAND)
    .bind(idempotency_key)
    .bind(fingerprint)
    .bind(requirement_id)
    .bind(next_revision)
    .bind(response_payload)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;
    Ok(Json(updated))
}

pub async fn list_requirement_revisions(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path((project_id, requirement_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<RequirementRevisionListResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Read).await?;
    fetch_requirement(&state.db, &principal, project_id, requirement_id).await?;
    let items = sqlx::query_as::<_, RequirementRevisionRecord>(
        r#"
        SELECT r.id, r.revision_number AS revision, r.title, r.statement, r.attributes,
               r.folder_id, r.tag_ids, r.created_by,
               COALESCE((
                 SELECT COALESCE(NULLIF(btrim(ui.display_name), ''), NULLIF(btrim(ui.email), ''))
                 FROM user_identities ui
                 JOIN organization_memberships om ON om.user_identity_id = ui.id
                 WHERE om.organization_id = r.organization_id AND ui.subject = r.created_by
                 ORDER BY ui.updated_at DESC, ui.created_at DESC
                 LIMIT 1
               ), r.created_by) AS author_label,
               r.created_at
        FROM artifact_revisions r
        WHERE r.organization_id = $1 AND r.project_id = $2 AND r.artifact_id = $3
        ORDER BY r.revision_number DESC
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(requirement_id)
    .fetch_all(&state.db)
    .await
    .map_err(database_error)?;
    Ok(Json(RequirementRevisionListResponse {
        items: items
            .into_iter()
            .map(RequirementRevisionResponse::from)
            .collect(),
    }))
}

pub async fn compare_requirement_revisions(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path((project_id, requirement_id)): Path<(Uuid, Uuid)>,
    Query(query): Query<RequirementComparisonQuery>,
) -> Result<Json<RequirementComparisonResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Read).await?;
    if query.from_revision < 1 || query.to_revision < 1 {
        return Err(ApiError::bad_request("Revision numbers must be positive"));
    }
    let from = fetch_revision(
        &state.db,
        &principal,
        project_id,
        requirement_id,
        query.from_revision,
    )
    .await?;
    let to = fetch_revision(
        &state.db,
        &principal,
        project_id,
        requirement_id,
        query.to_revision,
    )
    .await?;
    let mut changed_fields = Vec::new();
    if from.title != to.title {
        changed_fields.push("title");
    }
    if from.statement != to.statement {
        changed_fields.push("statement");
    }
    if from.attributes != to.attributes {
        changed_fields.push("attributes");
    }
    if from.folder_id != to.folder_id {
        changed_fields.push("folder_id");
    }
    if from.tag_ids != to.tag_ids {
        changed_fields.push("tag_ids");
    }
    Ok(Json(RequirementComparisonResponse {
        requirement_id,
        from,
        to,
        changed_fields,
    }))
}

pub async fn import_requirements(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<RequirementImportRequest>,
) -> Result<(StatusCode, Json<RequirementImportResponse>), ApiError> {
    authorize_project(&state, &principal, project_id, Action::Write).await?;
    let import_key = parse_idempotency_key(&headers)?.to_owned();
    if request.items.is_empty() || request.items.len() > 100 {
        return Err(ApiError::bad_request(
            "Import must contain between 1 and 100 requirements",
        ));
    }
    let mut items = Vec::with_capacity(request.items.len());
    for (index, request) in request.items.into_iter().enumerate() {
        let mut command_headers = HeaderMap::new();
        let child_key = format!("{import_key}:{index}");
        command_headers.insert(
            IDEMPOTENCY_HEADER,
            child_key
                .parse()
                .map_err(|_| ApiError::bad_request("Import idempotency key is invalid"))?,
        );
        let (_, Json(created)) = create_requirement(
            State(state.clone()),
            AuthenticatedPrincipal(principal.clone()),
            Path(project_id),
            command_headers,
            Json(request),
        )
        .await?;
        items.push(created);
    }
    let imported = items.len();
    Ok((
        StatusCode::CREATED,
        Json(RequirementImportResponse { items, imported }),
    ))
}

pub async fn export_requirements(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
) -> Result<Json<RequirementListResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Read).await?;
    let mut items = Vec::new();
    let mut offset = 0_i64;
    let total = loop {
        let Json(page) = list_requirements(
            State(state.clone()),
            AuthenticatedPrincipal(principal.clone()),
            Path(project_id),
            Query(RequirementListQuery {
                search: None,
                limit: Some(100),
                offset: Some(offset),
                folder_id: None,
                tag_id: None,
            }),
        )
        .await?;
        let page_total = page.total;
        let count = page.items.len() as i64;
        items.extend(page.items);
        offset += count;
        if count == 0 || offset >= page_total {
            break page_total;
        }
    };
    Ok(Json(RequirementListResponse {
        items,
        total,
        limit: total.max(1),
        offset: 0,
    }))
}

async fn fetch_revision(
    pool: &PgPool,
    principal: &Principal,
    project_id: Uuid,
    requirement_id: Uuid,
    revision: i32,
) -> Result<RequirementRevisionResponse, ApiError> {
    sqlx::query_as::<_, RequirementRevisionRecord>(
        r#"
        SELECT r.id, r.revision_number AS revision, r.title, r.statement, r.attributes,
               r.folder_id, r.tag_ids, r.created_by,
               COALESCE((
                 SELECT COALESCE(NULLIF(btrim(ui.display_name), ''), NULLIF(btrim(ui.email), ''))
                 FROM user_identities ui
                 JOIN organization_memberships om ON om.user_identity_id = ui.id
                 WHERE om.organization_id = r.organization_id AND ui.subject = r.created_by
                 ORDER BY ui.updated_at DESC, ui.created_at DESC
                 LIMIT 1
               ), r.created_by) AS author_label,
               r.created_at
        FROM artifact_revisions r
        WHERE r.organization_id = $1 AND r.project_id = $2
          AND r.artifact_id = $3 AND r.revision_number = $4
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(requirement_id)
    .bind(revision)
    .fetch_optional(pool)
    .await
    .map_err(database_error)?
    .ok_or_else(|| ApiError::not_found("Requirement revision does not exist"))
    .map(RequirementRevisionResponse::from)
}

async fn fetch_requirement(
    pool: &PgPool,
    principal: &Principal,
    project_id: Uuid,
    requirement_id: Uuid,
) -> Result<RequirementRecord, ApiError> {
    sqlx::query_as::<_, RequirementRecord>(
        r#"
        SELECT a.id, a.project_id, a.key, a.title, a.statement, a.attributes, a.folder_id,
               COALESCE((
                 SELECT array_agg(at.tag_id ORDER BY at.tag_id)
                 FROM artifact_tags at
                 WHERE at.organization_id = a.organization_id
                   AND at.project_id = a.project_id AND at.artifact_id = a.id
               ), '{}'::uuid[]) AS tag_ids,
               a.current_revision_number AS revision, a.created_by,
               COALESCE((
                 SELECT COALESCE(NULLIF(btrim(ui.display_name), ''), NULLIF(btrim(ui.email), ''))
                 FROM user_identities ui
                 JOIN organization_memberships om ON om.user_identity_id = ui.id
                 WHERE om.organization_id = a.organization_id AND ui.subject = a.created_by
                 ORDER BY ui.updated_at DESC, ui.created_at DESC
                 LIMIT 1
               ), a.created_by) AS author_label,
               a.created_at, a.updated_at
        FROM artifacts a
        JOIN artifact_types t
          ON t.organization_id = a.organization_id
         AND t.project_id = a.project_id
         AND t.id = a.artifact_type_id
        WHERE a.organization_id = $1 AND a.project_id = $2 AND a.id = $3
          AND t.key = 'REQUIREMENT'
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(requirement_id)
    .fetch_optional(pool)
    .await
    .map_err(database_error)?
    .ok_or_else(|| ApiError::not_found("Requirement does not exist"))
}

async fn find_command_result(
    pool: &PgPool,
    principal: &Principal,
    command_name: &str,
    idempotency_key: &str,
) -> Result<Option<CommandResult>, ApiError> {
    sqlx::query_as::<_, CommandResult>(
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

async fn insert_audit_event(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    principal: &Principal,
    project_id: Uuid,
    aggregate_id: Uuid,
    event_type: &str,
    payload: Value,
) -> Result<(), ApiError> {
    sqlx::query(
        r#"
        INSERT INTO audit_events (
            organization_id, project_id, actor_subject, event_type,
            aggregate_type, aggregate_id, payload
        )
        VALUES ($1, $2, $3, $4, 'requirement', $5, $6)
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(&principal.subject)
    .bind(event_type)
    .bind(aggregate_id)
    .bind(payload)
    .execute(&mut **transaction)
    .await
    .map_err(database_error)?;
    Ok(())
}

fn validate_create(request: CreateRequirementRequest) -> Result<ValidatedRequirement, ApiError> {
    let key = request
        .key
        .map(|key| key.trim().to_owned())
        .filter(|key| !key.is_empty());
    if key
        .as_deref()
        .is_some_and(|key| !valid_requirement_key(key))
    {
        return Err(ApiError::bad_request(
            "key must contain 2-32 uppercase letters, digits, or hyphens and start with a letter",
        ));
    }
    let content = validate_content(
        request.title,
        request.statement,
        request.attributes,
        request.folder_id,
        request.tag_ids,
    )?;
    Ok(ValidatedRequirement {
        key,
        title: content.title,
        statement: content.statement,
        attributes: content.attributes,
        folder_id: content.folder_id,
        tag_ids: content.tag_ids,
    })
}

fn validate_content(
    title: String,
    statement: String,
    attributes: Value,
    folder_id: Option<Uuid>,
    mut tag_ids: Vec<Uuid>,
) -> Result<ValidatedRequirement, ApiError> {
    let title = title.trim().to_owned();
    let statement = statement.trim().to_owned();
    if title.is_empty() || title.chars().count() > 200 {
        return Err(ApiError::bad_request(
            "title must contain between 1 and 200 characters",
        ));
    }
    if statement.is_empty() || statement.chars().count() > 20_000 {
        return Err(ApiError::bad_request(
            "statement must contain between 1 and 20000 characters",
        ));
    }
    if !attributes.is_object() {
        return Err(ApiError::bad_request("attributes must be a JSON object"));
    }
    tag_ids.sort_unstable();
    tag_ids.dedup();
    if tag_ids.len() > 50 {
        return Err(ApiError::bad_request(
            "A requirement may have at most 50 tags",
        ));
    }
    Ok(ValidatedRequirement {
        key: None,
        title,
        statement,
        attributes,
        folder_id,
        tag_ids,
    })
}

async fn allocate_requirement_key(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    principal: &Principal,
    project_id: Uuid,
    requested_key: Option<&str>,
) -> Result<String, ApiError> {
    if let Some(requested_key) = requested_key {
        let prefix = sqlx::query_scalar::<_, String>(
            r#"
            SELECT requirement_prefix
            FROM projects
            WHERE organization_id = $1 AND id = $2
            FOR UPDATE
            "#,
        )
        .bind(principal.organization_id)
        .bind(project_id)
        .fetch_optional(&mut **transaction)
        .await
        .map_err(database_error)?
        .ok_or_else(|| ApiError::not_found("Project does not exist"))?;
        if let Some(number) = requested_key
            .strip_prefix(&format!("{prefix}-"))
            .and_then(|value| value.parse::<i64>().ok())
            .filter(|number| *number > 0)
        {
            sqlx::query(
                r#"
                UPDATE projects
                SET next_requirement_number = GREATEST(next_requirement_number, $3)
                WHERE organization_id = $1 AND id = $2
                "#,
            )
            .bind(principal.organization_id)
            .bind(project_id)
            .bind(number + 1)
            .execute(&mut **transaction)
            .await
            .map_err(database_error)?;
        }
        return Ok(requested_key.to_owned());
    }

    let (prefix, number) = sqlx::query_as::<_, (String, i64)>(
        r#"
        UPDATE projects
        SET next_requirement_number = next_requirement_number + 1
        WHERE organization_id = $1 AND id = $2
        RETURNING requirement_prefix, next_requirement_number - 1
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(database_error)?
    .ok_or_else(|| ApiError::not_found("Project does not exist"))?;
    Ok(format!("{prefix}-{number:03}"))
}

async fn validate_requirement_workspace(
    pool: &PgPool,
    principal: &Principal,
    project_id: Uuid,
    requirement: &ValidatedRequirement,
) -> Result<(), ApiError> {
    if let Some(folder_id) = requirement.folder_id {
        let exists = sqlx::query_scalar::<_, bool>(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM folders
                WHERE organization_id = $1 AND project_id = $2 AND id = $3
            )
            "#,
        )
        .bind(principal.organization_id)
        .bind(project_id)
        .bind(folder_id)
        .fetch_one(pool)
        .await
        .map_err(database_error)?;
        if !exists {
            return Err(ApiError::bad_request("folder_id is not in this project"));
        }
    }
    if !requirement.tag_ids.is_empty() {
        let count = sqlx::query_scalar::<_, i64>(
            r#"
            SELECT count(*) FROM tags
            WHERE organization_id = $1 AND project_id = $2 AND id = ANY($3)
            "#,
        )
        .bind(principal.organization_id)
        .bind(project_id)
        .bind(&requirement.tag_ids)
        .fetch_one(pool)
        .await
        .map_err(database_error)?;
        if count != requirement.tag_ids.len() as i64 {
            return Err(ApiError::bad_request(
                "One or more tags are not in this project",
            ));
        }
    }

    let definitions = sqlx::query_as::<_, AttributeDefinition>(
        r#"
        SELECT key, value_type, required, config
        FROM custom_attribute_definitions
        WHERE organization_id = $1 AND project_id = $2
        ORDER BY key
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .fetch_all(pool)
    .await
    .map_err(database_error)?;
    let values = requirement
        .attributes
        .as_object()
        .expect("validated attributes are an object");
    for key in values.keys() {
        if !definitions.iter().any(|definition| definition.key == *key) {
            return Err(ApiError::bad_request(format!(
                "Attribute '{key}' is not defined for this project"
            )));
        }
    }
    for definition in definitions {
        let value = values.get(&definition.key);
        if definition.required && value.is_none() {
            return Err(ApiError::bad_request(format!(
                "Attribute '{}' is required",
                definition.key
            )));
        }
        let Some(value) = value else { continue };
        let valid_type = match definition.value_type.as_str() {
            "text" => value.is_string(),
            "number" => value.is_number(),
            "boolean" => value.is_boolean(),
            "enum" => {
                let options = definition
                    .config
                    .get("options")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                value.is_string() && options.iter().any(|option| option == value)
            }
            _ => false,
        };
        if !valid_type {
            return Err(ApiError::bad_request(format!(
                "Attribute '{}' does not match type '{}'",
                definition.key, definition.value_type
            )));
        }
    }
    Ok(())
}

async fn replace_tags(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    principal: &Principal,
    project_id: Uuid,
    artifact_id: Uuid,
    tag_ids: &[Uuid],
) -> Result<(), ApiError> {
    sqlx::query(
        r#"
        DELETE FROM artifact_tags
        WHERE organization_id = $1 AND project_id = $2 AND artifact_id = $3
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(artifact_id)
    .execute(&mut **transaction)
    .await
    .map_err(database_error)?;
    for tag_id in tag_ids {
        sqlx::query(
            r#"
            INSERT INTO artifact_tags (organization_id, project_id, artifact_id, tag_id)
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(principal.organization_id)
        .bind(project_id)
        .bind(artifact_id)
        .bind(tag_id)
        .execute(&mut **transaction)
        .await
        .map_err(database_error)?;
    }
    Ok(())
}

fn parse_idempotency_key(headers: &HeaderMap) -> Result<&str, ApiError> {
    let value = headers
        .get(IDEMPOTENCY_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| (8..=128).contains(&value.len()))
        .filter(|value| {
            value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
        })
        .ok_or_else(|| {
            ApiError::bad_request(
                "X-Idempotency-Key must contain 8-128 letters, digits, hyphens, underscores, periods, or colons",
            )
        })?;
    Ok(value)
}

fn valid_requirement_key(value: &str) -> bool {
    (2..=32).contains(&value.len())
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_uppercase())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'-')
}

fn abbreviate_author_label(value: &str) -> String {
    let value = value.trim();
    let mut parts = value.split_whitespace();
    let Some(first_name) = parts.next() else {
        return String::new();
    };
    let Some(last_name) = parts.last() else {
        return first_name.to_owned();
    };
    let initial = first_name
        .chars()
        .next()
        .map(|character| character.to_uppercase().collect::<String>())
        .unwrap_or_default();
    format!("{initial}. {last_name}")
}

fn empty_object() -> Value {
    json!({})
}

fn requirement_insert_error(error: sqlx::Error) -> ApiError {
    if error
        .as_database_error()
        .and_then(|error| error.code())
        .as_deref()
        == Some("23505")
    {
        return ApiError::conflict("Requirement key already exists in this project");
    }
    database_error(error)
}

fn database_error(error: sqlx::Error) -> ApiError {
    tracing::warn!(%error, "requirements database operation failed");
    ApiError::unavailable("Requirements database operation failed")
}

#[cfg(test)]
mod tests {
    use axum::http::{HeaderMap, HeaderValue};
    use serde_json::json;

    use super::{
        CreateRequirementRequest, abbreviate_author_label, parse_idempotency_key,
        valid_requirement_key, validate_create,
    };

    #[test]
    fn abbreviates_author_names_without_touching_fallback_identifiers() {
        assert_eq!(abbreviate_author_label("TJ Johnson"), "T. Johnson");
        assert_eq!(abbreviate_author_label("Mary Jane Smith"), "M. Smith");
        assert_eq!(abbreviate_author_label("Cher"), "Cher");
        assert_eq!(
            abbreviate_author_label("author@example.com"),
            "author@example.com"
        );
        assert_eq!(
            abbreviate_author_label("71cb5510-0061-704c-5f38-dfb8278cb70d"),
            "71cb5510-0061-704c-5f38-dfb8278cb70d"
        );
    }

    #[test]
    fn validates_requirement_keys() {
        assert!(valid_requirement_key("SYS-101"));
        assert!(!valid_requirement_key("sys-101"));
        assert!(!valid_requirement_key("1-SYS"));
    }

    #[test]
    fn normalizes_requirement_content() {
        let validated = validate_create(CreateRequirementRequest {
            key: Some("SYS-101".to_owned()),
            title: "  Stable control  ".to_owned(),
            statement: "  The controller shall remain stable.  ".to_owned(),
            attributes: json!({"priority": "high"}),
            folder_id: None,
            tag_ids: Vec::new(),
        })
        .expect("request should be valid");
        assert_eq!(validated.title, "Stable control");
        assert_eq!(validated.statement, "The controller shall remain stable.");
        assert_eq!(validated.key.as_deref(), Some("SYS-101"));
    }

    #[test]
    fn accepts_server_assigned_requirement_keys() {
        let validated = validate_create(CreateRequirementRequest {
            key: None,
            title: "Stable control".to_owned(),
            statement: "The controller shall remain stable.".to_owned(),
            attributes: json!({}),
            folder_id: None,
            tag_ids: Vec::new(),
        })
        .expect("request should be valid");
        assert_eq!(validated.key, None);
    }

    #[test]
    fn requires_well_formed_idempotency_keys() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-idempotency-key",
            HeaderValue::from_static("req:create:001"),
        );
        assert_eq!(
            parse_idempotency_key(&headers).expect("header should be valid"),
            "req:create:001"
        );
    }
}
