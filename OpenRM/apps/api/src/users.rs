use std::sync::Arc;

use aws_sdk_cognitoidentityprovider::{
    Client as CognitoClient,
    types::{AttributeType, DeliveryMediumType},
};
use axum::{Json, extract::State, http::StatusCode};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthenticatedPrincipal,
    authorize,
    config::{AuthMode, Config},
    error::ApiError,
    policy::{Action, Principal},
};

#[derive(Clone)]
pub enum UserDirectory {
    Development {
        issuer: Arc<str>,
    },
    Cognito {
        client: CognitoClient,
        pool_id: Arc<str>,
        issuer: Arc<str>,
    },
}

#[derive(Debug)]
struct DirectoryIdentity {
    username: String,
    subject: String,
    email: Option<String>,
    display_name: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct UserProjectMembership {
    pub project_id: Uuid,
    pub project_key: Option<String>,
    pub project_name: Option<String>,
    pub role: String,
}

#[derive(Debug, Deserialize)]
pub struct InviteUserRequest {
    pub email: String,
    pub display_name: Option<String>,
    pub title: Option<String>,
    pub department: Option<String>,
    pub organization_role: String,
    #[serde(default)]
    pub project_memberships: Vec<UserProjectMembership>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateProfileRequest {
    pub display_name: Option<String>,
    pub title: Option<String>,
    pub department: Option<String>,
    pub bio: Option<String>,
}

#[derive(Debug, FromRow)]
struct UserRecord {
    id: Uuid,
    subject: String,
    email: Option<String>,
    display_name: Option<String>,
    title: Option<String>,
    department: Option<String>,
    bio: Option<String>,
    organization_role: String,
    project_memberships: Value,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct UserResponse {
    pub id: Uuid,
    pub subject: String,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub title: Option<String>,
    pub department: Option<String>,
    pub bio: Option<String>,
    pub organization_role: String,
    pub project_memberships: Vec<UserProjectMembership>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct UserListResponse {
    pub items: Vec<UserResponse>,
}

impl UserDirectory {
    pub async fn from_config(config: &Config) -> Result<Self, ApiError> {
        match config.auth_mode {
            AuthMode::Dev => Ok(Self::development()),
            AuthMode::Oidc => {
                let pool_id = config
                    .cognito_user_pool_id
                    .as_deref()
                    .ok_or_else(|| ApiError::unavailable("Cognito user pool is not configured"))?;
                let issuer = config
                    .oidc_issuer
                    .as_deref()
                    .ok_or_else(|| ApiError::unavailable("OIDC issuer is not configured"))?;
                let sdk_config =
                    aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
                Ok(Self::Cognito {
                    client: CognitoClient::new(&sdk_config),
                    pool_id: Arc::from(pool_id),
                    issuer: Arc::from(issuer),
                })
            }
        }
    }

    pub fn development() -> Self {
        Self::Development {
            issuer: Arc::from("development"),
        }
    }

    fn issuer(&self) -> &str {
        match self {
            Self::Development { issuer } | Self::Cognito { issuer, .. } => issuer,
        }
    }

    async fn invite(
        &self,
        email: &str,
        display_name: Option<&str>,
        organization_id: Uuid,
        role: &str,
    ) -> Result<DirectoryIdentity, ApiError> {
        let Self::Cognito {
            client, pool_id, ..
        } = self
        else {
            return Ok(DirectoryIdentity {
                username: email.to_owned(),
                subject: Uuid::new_v4().to_string(),
                email: Some(email.to_owned()),
                display_name: display_name.map(str::to_owned),
            });
        };

        let mut attributes = vec![
            directory_attribute("email", email),
            directory_attribute("email_verified", "true"),
            directory_attribute("custom:org_id", &organization_id.to_string()),
        ];
        if let Some(display_name) = display_name {
            attributes.push(directory_attribute("name", display_name));
        }
        let create_result = client
            .admin_create_user()
            .user_pool_id(pool_id.as_ref())
            .username(email)
            .set_user_attributes(Some(attributes))
            .desired_delivery_mediums(DeliveryMediumType::Email)
            .send()
            .await;
        if let Err(error) = &create_result
            && !error.to_string().contains("UsernameExistsException")
        {
            tracing::warn!(%error, "Cognito user invitation failed");
            return Err(ApiError::unavailable("Could not send the user invitation"));
        }

        let identity = self.lookup(email).await?;
        client
            .admin_add_user_to_group()
            .user_pool_id(pool_id.as_ref())
            .username(&identity.username)
            .group_name(role)
            .send()
            .await
            .map_err(|error| {
                tracing::warn!(%error, "Cognito role assignment failed");
                ApiError::unavailable("The user was invited but the role could not be assigned")
            })?;
        Ok(identity)
    }

    async fn lookup(&self, username: &str) -> Result<DirectoryIdentity, ApiError> {
        let Self::Cognito {
            client, pool_id, ..
        } = self
        else {
            return Ok(DirectoryIdentity {
                username: username.to_owned(),
                subject: username.to_owned(),
                email: None,
                display_name: None,
            });
        };
        let output = client
            .admin_get_user()
            .user_pool_id(pool_id.as_ref())
            .username(username)
            .send()
            .await
            .map_err(|error| {
                tracing::warn!(%error, "Cognito user lookup failed");
                ApiError::unavailable("Could not read the user directory")
            })?;
        let attribute = |name: &str| {
            output
                .user_attributes()
                .iter()
                .find(|attribute| attribute.name() == name)
                .and_then(|attribute| attribute.value())
                .map(str::to_owned)
        };
        Ok(DirectoryIdentity {
            username: output.username().to_owned(),
            subject: attribute("sub").unwrap_or_else(|| username.to_owned()),
            email: attribute("email"),
            display_name: attribute("name"),
        })
    }
}

pub async fn list_users(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
) -> Result<Json<UserListResponse>, ApiError> {
    authorize(&state, &principal, Action::Administer)?;
    let records = query_users(&state, &principal, None).await?;
    Ok(Json(UserListResponse {
        items: records.into_iter().map(UserResponse::from).collect(),
    }))
}

pub async fn invite_user(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Json(request): Json<InviteUserRequest>,
) -> Result<(StatusCode, Json<UserResponse>), ApiError> {
    authorize(&state, &principal, Action::Administer)?;
    let request = validate_invitation(request)?;
    validate_projects(&state, &principal, &request.project_memberships).await?;
    let identity = state
        .user_directory
        .invite(
            &request.email,
            request.display_name.as_deref(),
            principal.organization_id,
            &request.organization_role,
        )
        .await?;

    let mut transaction = state.db.begin().await.map_err(database_error)?;
    let user_id = upsert_identity(
        &mut transaction,
        state.user_directory.issuer(),
        &identity,
        request.display_name.as_deref(),
        request.title.as_deref(),
        request.department.as_deref(),
    )
    .await?;
    sqlx::query(
        r#"
        INSERT INTO organization_memberships (organization_id, user_identity_id, role)
        VALUES ($1, $2, $3)
        ON CONFLICT (organization_id, user_identity_id)
        DO UPDATE SET role = EXCLUDED.role
        "#,
    )
    .bind(principal.organization_id)
    .bind(user_id)
    .bind(&request.organization_role)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    for membership in &request.project_memberships {
        sqlx::query(
            r#"
            INSERT INTO project_memberships (organization_id, project_id, subject, role)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (organization_id, project_id, subject)
            DO UPDATE SET role = EXCLUDED.role
            "#,
        )
        .bind(principal.organization_id)
        .bind(membership.project_id)
        .bind(&identity.subject)
        .bind(&membership.role)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    }
    insert_user_audit(
        &mut transaction,
        &principal,
        user_id,
        "user.invited",
        json!({
            "email": request.email,
            "organization_role": request.organization_role,
            "project_memberships": request.project_memberships,
        }),
    )
    .await?;
    transaction.commit().await.map_err(database_error)?;
    let record = query_users(&state, &principal, Some(user_id))
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| ApiError::internal("Invited user profile could not be read"))?;
    Ok((StatusCode::CREATED, Json(record.into())))
}

pub async fn get_profile(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
) -> Result<Json<UserResponse>, ApiError> {
    authorize(&state, &principal, Action::Read)?;
    let user_id = ensure_current_profile(&state, &principal).await?;
    let record = query_users(&state, &principal, Some(user_id))
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| ApiError::internal("User profile could not be read"))?;
    Ok(Json(record.into()))
}

pub async fn update_profile(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Json(request): Json<UpdateProfileRequest>,
) -> Result<Json<UserResponse>, ApiError> {
    authorize(&state, &principal, Action::Read)?;
    let request = validate_profile(request)?;
    let user_id = ensure_current_profile(&state, &principal).await?;
    sqlx::query(
        r#"
        UPDATE user_identities
        SET display_name = $2, title = $3, department = $4, bio = $5, updated_at = now()
        WHERE id = $1
        "#,
    )
    .bind(user_id)
    .bind(request.display_name)
    .bind(request.title)
    .bind(request.department)
    .bind(request.bio)
    .execute(&state.db)
    .await
    .map_err(database_error)?;
    let record = query_users(&state, &principal, Some(user_id))
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| ApiError::internal("User profile could not be read"))?;
    Ok(Json(record.into()))
}

async fn ensure_current_profile(state: &AppState, principal: &Principal) -> Result<Uuid, ApiError> {
    let identity = state.user_directory.lookup(&principal.subject).await?;
    let mut transaction = state.db.begin().await.map_err(database_error)?;
    let user_id = upsert_identity(
        &mut transaction,
        state.user_directory.issuer(),
        &identity,
        identity.display_name.as_deref(),
        None,
        None,
    )
    .await?;
    let role = ["administrator", "author", "reviewer", "viewer"]
        .into_iter()
        .find(|role| principal.roles.iter().any(|assigned| assigned == role))
        .unwrap_or("viewer");
    sqlx::query(
        r#"
        INSERT INTO organization_memberships (organization_id, user_identity_id, role)
        VALUES ($1, $2, $3)
        ON CONFLICT (organization_id, user_identity_id) DO NOTHING
        "#,
    )
    .bind(principal.organization_id)
    .bind(user_id)
    .bind(role)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;
    Ok(user_id)
}

async fn upsert_identity(
    transaction: &mut Transaction<'_, Postgres>,
    issuer: &str,
    identity: &DirectoryIdentity,
    display_name: Option<&str>,
    title: Option<&str>,
    department: Option<&str>,
) -> Result<Uuid, ApiError> {
    sqlx::query_scalar::<_, Uuid>(
        r#"
        INSERT INTO user_identities (
            issuer, subject, display_name, email, title, department
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (issuer, subject) DO UPDATE
        SET display_name = COALESCE(EXCLUDED.display_name, user_identities.display_name),
            email = COALESCE(EXCLUDED.email, user_identities.email),
            title = COALESCE(EXCLUDED.title, user_identities.title),
            department = COALESCE(EXCLUDED.department, user_identities.department),
            updated_at = now()
        RETURNING id
        "#,
    )
    .bind(issuer)
    .bind(&identity.subject)
    .bind(display_name.or(identity.display_name.as_deref()))
    .bind(&identity.email)
    .bind(title)
    .bind(department)
    .fetch_one(&mut **transaction)
    .await
    .map_err(database_error)
}

async fn query_users(
    state: &AppState,
    principal: &Principal,
    user_id: Option<Uuid>,
) -> Result<Vec<UserRecord>, ApiError> {
    sqlx::query_as::<_, UserRecord>(
        r#"
        SELECT ui.id, ui.subject, ui.email, ui.display_name, ui.title, ui.department, ui.bio,
               om.role AS organization_role,
               COALESCE(
                 jsonb_agg(
                   jsonb_build_object(
                     'project_id', pm.project_id,
                     'project_key', p.key,
                     'project_name', p.name,
                     'role', pm.role
                   ) ORDER BY p.key
                 ) FILTER (WHERE pm.project_id IS NOT NULL),
                 '[]'::jsonb
               ) AS project_memberships,
               ui.created_at, ui.updated_at
        FROM user_identities ui
        JOIN organization_memberships om ON om.user_identity_id = ui.id
        LEFT JOIN project_memberships pm
          ON pm.organization_id = om.organization_id AND pm.subject = ui.subject
        LEFT JOIN projects p
          ON p.organization_id = pm.organization_id AND p.id = pm.project_id
        WHERE om.organization_id = $1 AND ($2::uuid IS NULL OR ui.id = $2)
        GROUP BY ui.id, om.role
        ORDER BY lower(COALESCE(ui.display_name, ui.email, ui.subject))
        "#,
    )
    .bind(principal.organization_id)
    .bind(user_id)
    .fetch_all(&state.db)
    .await
    .map_err(database_error)
}

async fn validate_projects(
    state: &AppState,
    principal: &Principal,
    memberships: &[UserProjectMembership],
) -> Result<(), ApiError> {
    if memberships.len() > 100 {
        return Err(ApiError::bad_request(
            "A user may be assigned to at most 100 projects",
        ));
    }
    for membership in memberships {
        if !valid_role(&membership.role) {
            return Err(ApiError::bad_request("Project role is invalid"));
        }
        let exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE organization_id = $1 AND id = $2)",
        )
        .bind(principal.organization_id)
        .bind(membership.project_id)
        .fetch_one(&state.db)
        .await
        .map_err(database_error)?;
        if !exists {
            return Err(ApiError::bad_request("A selected project does not exist"));
        }
    }
    Ok(())
}

async fn insert_user_audit(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    user_id: Uuid,
    event_type: &str,
    payload: Value,
) -> Result<(), ApiError> {
    sqlx::query(
        r#"
        INSERT INTO audit_events (
            organization_id, project_id, actor_subject, event_type,
            aggregate_type, aggregate_id, payload
        )
        VALUES ($1, NULL, $2, $3, 'user', $4, $5)
        "#,
    )
    .bind(principal.organization_id)
    .bind(&principal.subject)
    .bind(event_type)
    .bind(user_id)
    .bind(payload)
    .execute(&mut **transaction)
    .await
    .map_err(database_error)?;
    Ok(())
}

fn validate_invitation(mut request: InviteUserRequest) -> Result<InviteUserRequest, ApiError> {
    request.email = request.email.trim().to_ascii_lowercase();
    if request.email.len() > 320
        || !request.email.contains('@')
        || request.email.starts_with('@')
        || request.email.ends_with('@')
    {
        return Err(ApiError::bad_request("email is invalid"));
    }
    request.display_name = optional_text(request.display_name, "display_name", 160)?;
    request.title = optional_text(request.title, "title", 160)?;
    request.department = optional_text(request.department, "department", 160)?;
    if !valid_role(&request.organization_role) {
        return Err(ApiError::bad_request("organization_role is invalid"));
    }
    Ok(request)
}

fn validate_profile(mut request: UpdateProfileRequest) -> Result<UpdateProfileRequest, ApiError> {
    request.display_name = optional_text(request.display_name, "display_name", 160)?;
    request.title = optional_text(request.title, "title", 160)?;
    request.department = optional_text(request.department, "department", 160)?;
    request.bio = optional_text(request.bio, "bio", 2_000)?;
    Ok(request)
}

fn optional_text(
    value: Option<String>,
    field: &str,
    maximum: usize,
) -> Result<Option<String>, ApiError> {
    let value = value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if value
        .as_ref()
        .is_some_and(|value| value.chars().count() > maximum)
    {
        return Err(ApiError::bad_request(format!(
            "{field} must not exceed {maximum} characters"
        )));
    }
    Ok(value)
}

fn valid_role(role: &str) -> bool {
    matches!(role, "administrator" | "author" | "reviewer" | "viewer")
}

fn directory_attribute(name: &str, value: &str) -> AttributeType {
    AttributeType::builder()
        .name(name)
        .value(value)
        .build()
        .expect("Cognito directory attribute has a name")
}

impl From<UserRecord> for UserResponse {
    fn from(record: UserRecord) -> Self {
        Self {
            id: record.id,
            subject: record.subject,
            email: record.email,
            display_name: record.display_name,
            title: record.title,
            department: record.department,
            bio: record.bio,
            organization_role: record.organization_role,
            project_memberships: serde_json::from_value(record.project_memberships)
                .unwrap_or_default(),
            created_at: record.created_at,
            updated_at: record.updated_at,
        }
    }
}

fn database_error(error: sqlx::Error) -> ApiError {
    tracing::warn!(%error, "user profile database operation failed");
    ApiError::unavailable("User profile database operation failed")
}

#[cfg(test)]
mod tests {
    use super::{InviteUserRequest, UpdateProfileRequest, validate_invitation, validate_profile};

    #[test]
    fn validates_invitation_roles_and_email() {
        assert!(
            validate_invitation(InviteUserRequest {
                email: "Person@Example.com".to_owned(),
                display_name: Some("Person".to_owned()),
                title: None,
                department: None,
                organization_role: "author".to_owned(),
                project_memberships: Vec::new(),
            })
            .is_ok()
        );
    }

    #[test]
    fn trims_empty_profile_fields() {
        let profile = validate_profile(UpdateProfileRequest {
            display_name: Some("  Person  ".to_owned()),
            title: Some("  ".to_owned()),
            department: None,
            bio: None,
        })
        .expect("profile is valid");
        assert_eq!(profile.display_name.as_deref(), Some("Person"));
        assert_eq!(profile.title, None);
    }
}
