use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthenticatedPrincipal,
    authorize,
    error::ApiError,
    policy::{Action, Principal},
};

const IDEMPOTENCY_HEADER: &str = "x-idempotency-key";
const CREATE_PROJECT_COMMAND: &str = "project.create";

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CreateProjectRequest {
    pub key: String,
    pub name: String,
    pub requirement_prefix: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Deserialize, FromRow, Serialize)]
pub struct ProjectResponse {
    pub id: Uuid,
    pub key: String,
    pub name: String,
    pub requirement_prefix: String,
    pub next_requirement_number: i64,
    pub description: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct ProjectMembershipRequest {
    pub subject: String,
    pub role: String,
}

#[derive(Debug, FromRow, Serialize)]
pub struct ProjectMembershipResponse {
    pub subject: String,
    pub role: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct ProjectMembershipListResponse {
    pub items: Vec<ProjectMembershipResponse>,
}

#[derive(Debug, Deserialize)]
pub struct WorkspaceResourceRequest {
    pub name: Option<String>,
    pub parent_id: Option<Uuid>,
    pub color: Option<String>,
    pub key: Option<String>,
    pub label: Option<String>,
    pub value_type: Option<String>,
    pub required: Option<bool>,
    pub config: Option<Value>,
    pub filters: Option<Value>,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceResourceListResponse {
    pub items: Vec<Value>,
}

#[derive(Debug, FromRow)]
struct StoredCommand {
    request_fingerprint: String,
    response_payload: Value,
}

pub async fn create_project(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    headers: HeaderMap,
    Json(request): Json<CreateProjectRequest>,
) -> Result<(StatusCode, Json<ProjectResponse>), ApiError> {
    authorize(&state, &principal, Action::Administer)?;
    let idempotency_key = parse_idempotency_key(&headers)?;
    let request = validate_project(request)?;
    let fingerprint = serde_json::to_string(&request)
        .map_err(|_| ApiError::internal("Could not fingerprint project command"))?;

    if let Some(stored) = find_project_command(&state.db, &principal, idempotency_key).await? {
        if stored.request_fingerprint != fingerprint {
            return Err(ApiError::conflict(
                "Idempotency key was already used with a different project request",
            ));
        }
        let response = serde_json::from_value(stored.response_payload)
            .map_err(|_| ApiError::internal("Stored project command response is invalid"))?;
        return Ok((StatusCode::OK, Json(response)));
    }

    let project_id = Uuid::new_v4();
    let mut transaction = state.db.begin().await.map_err(database_error)?;
    let project = sqlx::query_as::<_, ProjectResponse>(
        r#"
        INSERT INTO projects (
            id, organization_id, key, name, requirement_prefix, description
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, key, name, requirement_prefix,
                  next_requirement_number, description, created_at
        "#,
    )
    .bind(project_id)
    .bind(principal.organization_id)
    .bind(&request.key)
    .bind(&request.name)
    .bind(&request.requirement_prefix)
    .bind(&request.description)
    .fetch_one(&mut *transaction)
    .await
    .map_err(project_insert_error)?;

    let requirement_type_id = sqlx::query_scalar::<_, Uuid>(
        r#"
        INSERT INTO artifact_types (organization_id, project_id, key, name)
        VALUES ($1, $2, 'REQUIREMENT', 'Requirement')
        RETURNING id
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?;
    sqlx::query(
        r#"
        INSERT INTO relationship_types (
            organization_id, project_id, key, name,
            source_artifact_type_id, target_artifact_type_id,
            max_targets_per_source, max_sources_per_target, propagates_suspect
        )
        VALUES
            ($1, $2, 'DECOMPOSES_TO', 'Decomposes to', $3, $3, NULL, 1, true),
            ($1, $2, 'DEPENDS_ON', 'Depends on', $3, $3, NULL, NULL, true)
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(requirement_type_id)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    sqlx::query(
        r#"
        INSERT INTO project_memberships (organization_id, project_id, subject, role)
        VALUES ($1, $2, $3, 'administrator')
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(&principal.subject)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    sqlx::query(
        r#"
        INSERT INTO folders (organization_id, project_id, name, created_by)
        VALUES ($1, $2, 'Requirements', $3)
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(&principal.subject)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    sqlx::query(
        r#"
        INSERT INTO custom_attribute_definitions (
            organization_id, project_id, key, label, value_type, config, created_by
        )
        VALUES ($1, $2, 'priority', 'Priority', 'enum',
                '{"options":["low","medium","high","critical"]}'::jsonb, $3)
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(&principal.subject)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;

    insert_audit(
        &mut transaction,
        &principal,
        project_id,
        "project.created",
        "project",
        project_id,
        json!({
            "key": project.key,
            "name": project.name,
            "requirement_prefix": project.requirement_prefix,
        }),
    )
    .await?;
    let response_payload = serde_json::to_value(&project)
        .map_err(|_| ApiError::internal("Could not store project command response"))?;
    sqlx::query(
        r#"
        INSERT INTO command_results (
            organization_id, actor_subject, command_name, idempotency_key,
            request_fingerprint, aggregate_type, aggregate_id, response_revision, response_payload
        )
        VALUES ($1, $2, $3, $4, $5, 'project', $6, 1, $7)
        "#,
    )
    .bind(principal.organization_id)
    .bind(&principal.subject)
    .bind(CREATE_PROJECT_COMMAND)
    .bind(idempotency_key)
    .bind(&fingerprint)
    .bind(project_id)
    .bind(response_payload)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;
    Ok((StatusCode::CREATED, Json(project)))
}

pub async fn list_memberships(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
) -> Result<Json<ProjectMembershipListResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Administer).await?;
    let items = sqlx::query_as::<_, ProjectMembershipResponse>(
        r#"
        SELECT subject, role, created_at
        FROM project_memberships
        WHERE organization_id = $1 AND project_id = $2
        ORDER BY subject
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .map_err(database_error)?;
    Ok(Json(ProjectMembershipListResponse { items }))
}

pub async fn upsert_membership(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
    Json(request): Json<ProjectMembershipRequest>,
) -> Result<Json<ProjectMembershipResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Administer).await?;
    let subject = request.subject.trim();
    if subject.is_empty() || subject.len() > 200 {
        return Err(ApiError::bad_request(
            "subject must contain 1-200 characters",
        ));
    }
    if !matches!(
        request.role.as_str(),
        "administrator" | "author" | "reviewer" | "viewer"
    ) {
        return Err(ApiError::bad_request("role is invalid"));
    }
    let mut transaction = state.db.begin().await.map_err(database_error)?;
    let membership = sqlx::query_as::<_, ProjectMembershipResponse>(
        r#"
        INSERT INTO project_memberships (organization_id, project_id, subject, role)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (organization_id, project_id, subject)
        DO UPDATE SET role = EXCLUDED.role
        RETURNING subject, role, created_at
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(subject)
    .bind(&request.role)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?;
    insert_audit(
        &mut transaction,
        &principal,
        project_id,
        "project.membership_set",
        "project_membership",
        project_id,
        json!({"subject": membership.subject, "role": membership.role}),
    )
    .await?;
    transaction.commit().await.map_err(database_error)?;
    Ok(Json(membership))
}

pub async fn list_workspace_resources(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path((project_id, resource)): Path<(Uuid, String)>,
) -> Result<Json<WorkspaceResourceListResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Read).await?;
    let items = match resource.as_str() {
        "folders" => {
            sqlx::query_scalar::<_, Value>(
                r#"
                SELECT jsonb_build_object(
                    'id', id, 'parent_id', parent_id, 'name', name, 'created_at', created_at
                )
                FROM folders
                WHERE organization_id = $1 AND project_id = $2
                ORDER BY name
                "#,
            )
            .bind(principal.organization_id)
            .bind(project_id)
            .fetch_all(&state.db)
            .await
            .map_err(database_error)?
        }
        "tags" => {
            sqlx::query_scalar::<_, Value>(
                r#"
                SELECT jsonb_build_object('id', id, 'name', name, 'color', color, 'created_at', created_at)
                FROM tags
                WHERE organization_id = $1 AND project_id = $2
                ORDER BY name
                "#,
            )
            .bind(principal.organization_id)
            .bind(project_id)
            .fetch_all(&state.db)
            .await
            .map_err(database_error)?
        }
        "attribute-definitions" => {
            sqlx::query_scalar::<_, Value>(
                r#"
                SELECT jsonb_build_object(
                    'id', id, 'key', key, 'label', label, 'value_type', value_type,
                    'required', required, 'config', config, 'created_at', created_at
                )
                FROM custom_attribute_definitions
                WHERE organization_id = $1 AND project_id = $2
                ORDER BY key
                "#,
            )
            .bind(principal.organization_id)
            .bind(project_id)
            .fetch_all(&state.db)
            .await
            .map_err(database_error)?
        }
        "saved-views" => {
            sqlx::query_scalar::<_, Value>(
                r#"
                SELECT jsonb_build_object(
                    'id', id, 'name', name, 'filters', filters, 'created_at', created_at
                )
                FROM saved_views
                WHERE organization_id = $1 AND project_id = $2 AND owner_subject = $3
                ORDER BY name
                "#,
            )
            .bind(principal.organization_id)
            .bind(project_id)
            .bind(&principal.subject)
            .fetch_all(&state.db)
            .await
            .map_err(database_error)?
        }
        _ => return Err(ApiError::not_found("Workspace resource does not exist")),
    };
    Ok(Json(WorkspaceResourceListResponse { items }))
}

pub async fn create_workspace_resource(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path((project_id, resource)): Path<(Uuid, String)>,
    Json(request): Json<WorkspaceResourceRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    authorize_project(&state, &principal, project_id, Action::Write).await?;
    let mut transaction = state.db.begin().await.map_err(database_error)?;
    let (item, aggregate_type, event_type) = match resource.as_str() {
        "folders" => {
            let name = required_text(request.name.as_deref(), "name", 120)?;
            let item = sqlx::query_scalar::<_, Value>(
                r#"
                WITH inserted AS (
                    INSERT INTO folders (organization_id, project_id, parent_id, name, created_by)
                    VALUES ($1, $2, $3, $4, $5)
                    RETURNING id, parent_id, name, created_at
                )
                SELECT to_jsonb(inserted) FROM inserted
                "#,
            )
            .bind(principal.organization_id)
            .bind(project_id)
            .bind(request.parent_id)
            .bind(name)
            .bind(&principal.subject)
            .fetch_one(&mut *transaction)
            .await
            .map_err(resource_insert_error)?;
            (item, "folder", "folder.created")
        }
        "tags" => {
            let name = required_text(request.name.as_deref(), "name", 64)?;
            let color = request.color.as_deref().unwrap_or("#64748b");
            if color.len() != 7
                || !color.starts_with('#')
                || !color[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(ApiError::bad_request("color must use #RRGGBB format"));
            }
            let item = sqlx::query_scalar::<_, Value>(
                r#"
                WITH inserted AS (
                    INSERT INTO tags (organization_id, project_id, name, color, created_by)
                    VALUES ($1, $2, $3, $4, $5)
                    RETURNING id, name, color, created_at
                )
                SELECT to_jsonb(inserted) FROM inserted
                "#,
            )
            .bind(principal.organization_id)
            .bind(project_id)
            .bind(name)
            .bind(color)
            .bind(&principal.subject)
            .fetch_one(&mut *transaction)
            .await
            .map_err(resource_insert_error)?;
            (item, "tag", "tag.created")
        }
        "attribute-definitions" => {
            let key = required_text(request.key.as_deref(), "key", 64)?;
            if !valid_attribute_key(key) {
                return Err(ApiError::bad_request(
                    "key must start with a lowercase letter and contain lowercase letters, digits, or underscores",
                ));
            }
            let label = required_text(request.label.as_deref(), "label", 120)?;
            let value_type = request.value_type.as_deref().unwrap_or("text");
            if !matches!(value_type, "text" | "number" | "boolean" | "enum") {
                return Err(ApiError::bad_request("value_type is invalid"));
            }
            let config = request.config.unwrap_or_else(|| json!({}));
            if !config.is_object() {
                return Err(ApiError::bad_request("config must be a JSON object"));
            }
            let item = sqlx::query_scalar::<_, Value>(
                r#"
                WITH inserted AS (
                    INSERT INTO custom_attribute_definitions (
                        organization_id, project_id, key, label, value_type, required, config, created_by
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    RETURNING id, key, label, value_type, required, config, created_at
                )
                SELECT to_jsonb(inserted) FROM inserted
                "#,
            )
            .bind(principal.organization_id)
            .bind(project_id)
            .bind(key)
            .bind(label)
            .bind(value_type)
            .bind(request.required.unwrap_or(false))
            .bind(config)
            .bind(&principal.subject)
            .fetch_one(&mut *transaction)
            .await
            .map_err(resource_insert_error)?;
            (
                item,
                "custom_attribute_definition",
                "attribute_definition.created",
            )
        }
        "saved-views" => {
            let name = required_text(request.name.as_deref(), "name", 120)?;
            let filters = request.filters.unwrap_or_else(|| json!({}));
            if !filters.is_object() {
                return Err(ApiError::bad_request("filters must be a JSON object"));
            }
            let item = sqlx::query_scalar::<_, Value>(
                r#"
                WITH inserted AS (
                    INSERT INTO saved_views (organization_id, project_id, owner_subject, name, filters)
                    VALUES ($1, $2, $3, $4, $5)
                    RETURNING id, name, filters, created_at
                )
                SELECT to_jsonb(inserted) FROM inserted
                "#,
            )
            .bind(principal.organization_id)
            .bind(project_id)
            .bind(&principal.subject)
            .bind(name)
            .bind(filters)
            .fetch_one(&mut *transaction)
            .await
            .map_err(resource_insert_error)?;
            (item, "saved_view", "saved_view.created")
        }
        _ => return Err(ApiError::not_found("Workspace resource does not exist")),
    };

    let aggregate_id = item
        .get("id")
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok())
        .ok_or_else(|| ApiError::internal("Workspace resource did not return an id"))?;
    insert_audit(
        &mut transaction,
        &principal,
        project_id,
        event_type,
        aggregate_type,
        aggregate_id,
        item.clone(),
    )
    .await?;
    transaction.commit().await.map_err(database_error)?;
    Ok((StatusCode::CREATED, Json(item)))
}

pub async fn authorize_project(
    state: &AppState,
    principal: &Principal,
    project_id: Uuid,
    action: Action,
) -> Result<(), ApiError> {
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE organization_id = $1 AND id = $2)",
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .fetch_one(&state.db)
    .await
    .map_err(database_error)?;
    if !exists {
        return Err(ApiError::not_found("Project does not exist"));
    }
    if principal.roles.iter().any(|role| role == "administrator") {
        return Ok(());
    }
    let role = sqlx::query_scalar::<_, String>(
        r#"
        SELECT role
        FROM project_memberships
        WHERE organization_id = $1 AND project_id = $2 AND subject = $3
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(&principal.subject)
    .fetch_optional(&state.db)
    .await
    .map_err(database_error)?
    .ok_or_else(|| ApiError::forbidden("Principal is not a member of this project"))?;
    let scoped = Principal {
        subject: principal.subject.clone(),
        organization_id: principal.organization_id,
        roles: vec![role],
    };
    state
        .policy
        .allows(&scoped, action, principal.organization_id)
        .then_some(())
        .ok_or_else(|| ApiError::forbidden("Project role does not allow this action"))
}

async fn find_project_command(
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
    .bind(CREATE_PROJECT_COMMAND)
    .bind(idempotency_key)
    .fetch_optional(pool)
    .await
    .map_err(database_error)
}

pub async fn insert_audit(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    project_id: Uuid,
    event_type: &str,
    aggregate_type: &str,
    aggregate_id: Uuid,
    payload: Value,
) -> Result<(), ApiError> {
    sqlx::query(
        r#"
        INSERT INTO audit_events (
            organization_id, project_id, actor_subject, event_type,
            aggregate_type, aggregate_id, payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(&principal.subject)
    .bind(event_type)
    .bind(aggregate_type)
    .bind(aggregate_id)
    .bind(payload)
    .execute(&mut **transaction)
    .await
    .map_err(database_error)?;
    Ok(())
}

fn validate_project(request: CreateProjectRequest) -> Result<CreateProjectRequest, ApiError> {
    let key = request.key.trim().to_owned();
    let name = request.name.trim().to_owned();
    let requirement_prefix = request.requirement_prefix.trim().to_owned();
    let description = request.description.trim().to_owned();
    if !(2..=16).contains(&key.len())
        || !key
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_uppercase())
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(ApiError::bad_request("project key is invalid"));
    }
    if name.is_empty() || name.chars().count() > 160 {
        return Err(ApiError::bad_request(
            "project name must contain 1-160 characters",
        ));
    }
    if !(2..=8).contains(&requirement_prefix.len())
        || !requirement_prefix
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_uppercase())
        || !requirement_prefix
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
    {
        return Err(ApiError::bad_request(
            "requirement_prefix must contain 2-8 uppercase letters or digits and start with a letter",
        ));
    }
    if description.chars().count() > 2_000 {
        return Err(ApiError::bad_request(
            "project description must not exceed 2000 characters",
        ));
    }
    Ok(CreateProjectRequest {
        key,
        name,
        requirement_prefix,
        description,
    })
}

fn required_text<'a>(value: Option<&'a str>, field: &str, max: usize) -> Result<&'a str, ApiError> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.chars().count() <= max)
        .ok_or_else(|| ApiError::bad_request(format!("{field} must contain 1-{max} characters")))
}

fn valid_attribute_key(value: &str) -> bool {
    (2..=64).contains(&value.len())
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
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

fn project_insert_error(error: sqlx::Error) -> ApiError {
    if error
        .as_database_error()
        .and_then(|error| error.constraint())
        == Some("projects_requirement_prefix_unique")
    {
        return ApiError::conflict("Requirement prefix already exists in this organization");
    }
    if is_unique_violation(&error) {
        return ApiError::conflict("Project key already exists in this organization");
    }
    database_error(error)
}

fn resource_insert_error(error: sqlx::Error) -> ApiError {
    if is_unique_violation(&error) {
        return ApiError::conflict("Workspace resource already exists");
    }
    database_error(error)
}

fn is_unique_violation(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .and_then(|error| error.code())
        .as_deref()
        == Some("23505")
}

fn database_error(error: sqlx::Error) -> ApiError {
    tracing::warn!(%error, "project workspace database operation failed");
    ApiError::unavailable("Project workspace database operation failed")
}

#[cfg(test)]
mod tests {
    use super::{CreateProjectRequest, valid_attribute_key, validate_project};

    #[test]
    fn validates_project_keys() {
        assert!(
            validate_project(CreateProjectRequest {
                key: "PROJECT-2".to_owned(),
                name: "Project two".to_owned(),
                requirement_prefix: "PRJ".to_owned(),
                description: String::new(),
            })
            .is_ok()
        );
        assert!(
            validate_project(CreateProjectRequest {
                key: "project".to_owned(),
                name: "Invalid".to_owned(),
                requirement_prefix: "PRJ".to_owned(),
                description: String::new(),
            })
            .is_err()
        );
    }

    #[test]
    fn validates_custom_attribute_keys() {
        assert!(valid_attribute_key("safety_level"));
        assert!(!valid_attribute_key("Safety-Level"));
    }
}
