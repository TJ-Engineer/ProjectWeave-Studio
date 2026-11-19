use std::collections::HashMap;

use aws_sdk_s3::{Client as S3Client, config::Region};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthenticatedPrincipal,
    config::Config,
    error::ApiError,
    policy::{Action, Principal},
    projects::{authorize_project, insert_audit},
};

#[derive(Clone)]
pub enum ObjectStore {
    Disabled,
    S3 { client: S3Client, bucket: String },
}

#[derive(Debug)]
struct StoredObject {
    key: String,
    size_bytes: i64,
    etag: Option<String>,
    last_modified: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct StorageObjectResponse {
    pub key: String,
    pub size_bytes: i64,
    pub etag: Option<String>,
    pub last_modified: Option<DateTime<Utc>>,
    pub linked: bool,
    pub link_count: usize,
}

#[derive(Debug, Serialize)]
pub struct StorageObjectListResponse {
    pub items: Vec<StorageObjectResponse>,
    pub prefix: String,
    pub total_size_bytes: i64,
}

#[derive(Debug, Deserialize)]
pub struct StorageObjectListQuery {
    pub search: Option<String>,
    pub limit: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct DeleteStorageObjectQuery {
    pub key: String,
}

#[derive(Debug, Serialize)]
pub struct DeleteStorageObjectResponse {
    pub key: String,
    pub deleted: bool,
    pub version_id: Option<String>,
}

#[derive(Debug, FromRow)]
struct ObjectLinkRecord {
    object_key: String,
    link_count: i64,
}

impl ObjectStore {
    pub async fn from_config(config: &Config) -> Result<Self, ApiError> {
        let Some(bucket) = config.object_storage_bucket.clone() else {
            return Ok(Self::Disabled);
        };
        let sdk_config = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(Region::new(config.object_storage_region.clone()))
            .load()
            .await;
        let mut builder = aws_sdk_s3::config::Builder::from(&sdk_config)
            .force_path_style(config.object_storage_force_path_style);
        if let Some(endpoint) = &config.object_storage_endpoint {
            builder = builder.endpoint_url(endpoint);
        }
        Ok(Self::S3 {
            client: S3Client::from_conf(builder.build()),
            bucket,
        })
    }

    pub fn disabled() -> Self {
        Self::Disabled
    }

    async fn list(&self, prefix: &str, limit: i32) -> Result<Vec<StoredObject>, ApiError> {
        let Self::S3 { client, bucket } = self else {
            return Err(ApiError::unavailable("Object storage is not configured"));
        };
        let output = client
            .list_objects_v2()
            .bucket(bucket)
            .prefix(prefix)
            .max_keys(limit)
            .send()
            .await
            .map_err(storage_error)?;
        Ok(output
            .contents()
            .iter()
            .filter_map(|object| {
                let key = object.key()?.strip_prefix(prefix)?.to_owned();
                if key.is_empty() || key.ends_with('/') {
                    return None;
                }
                let last_modified = object
                    .last_modified()
                    .and_then(|value| DateTime::from_timestamp(value.secs(), value.subsec_nanos()));
                Some(StoredObject {
                    key,
                    size_bytes: object.size().unwrap_or_default(),
                    etag: object
                        .e_tag()
                        .map(|value| value.trim_matches('"').to_owned()),
                    last_modified,
                })
            })
            .collect())
    }

    async fn delete(&self, key: &str) -> Result<Option<String>, ApiError> {
        let Self::S3 { client, bucket } = self else {
            return Err(ApiError::unavailable("Object storage is not configured"));
        };
        let output = client
            .delete_object()
            .bucket(bucket)
            .key(key)
            .send()
            .await
            .map_err(storage_error)?;
        Ok(output.version_id().map(str::to_owned))
    }
}

pub async fn list_objects(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
    Query(query): Query<StorageObjectListQuery>,
) -> Result<Json<StorageObjectListResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Read).await?;
    let prefix = project_prefix(&principal, project_id);
    let search = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase);
    let limit = query.limit.unwrap_or(100).clamp(1, 500);
    let objects = state.object_store.list(&prefix, limit).await?;
    let keys = objects
        .iter()
        .flat_map(|object| [object.key.clone(), format!("{prefix}{}", object.key)])
        .collect::<Vec<_>>();
    let links = if keys.is_empty() {
        HashMap::new()
    } else {
        sqlx::query_as::<_, ObjectLinkRecord>(
            r#"
            SELECT object_key, count(*) AS link_count
            FROM verification_attachments
            WHERE organization_id = $1 AND project_id = $2 AND object_key = ANY($3)
            GROUP BY object_key
            "#,
        )
        .bind(principal.organization_id)
        .bind(project_id)
        .bind(&keys)
        .fetch_all(&state.db)
        .await
        .map_err(database_error)?
        .into_iter()
        .map(|record| (record.object_key, record.link_count as usize))
        .collect::<HashMap<_, _>>()
    };
    let items = objects
        .into_iter()
        .filter(|object| {
            search
                .as_ref()
                .is_none_or(|search| object.key.to_ascii_lowercase().contains(search))
        })
        .map(|object| {
            let link_count = links.get(&object.key).copied().unwrap_or_default()
                + links
                    .get(&format!("{prefix}{}", object.key))
                    .copied()
                    .unwrap_or_default();
            StorageObjectResponse {
                key: object.key,
                size_bytes: object.size_bytes,
                etag: object.etag,
                last_modified: object.last_modified,
                linked: link_count > 0,
                link_count,
            }
        })
        .collect::<Vec<_>>();
    let total_size_bytes = items.iter().map(|object| object.size_bytes).sum();
    Ok(Json(StorageObjectListResponse {
        items,
        prefix,
        total_size_bytes,
    }))
}

pub async fn delete_object(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
    Query(query): Query<DeleteStorageObjectQuery>,
) -> Result<(StatusCode, Json<DeleteStorageObjectResponse>), ApiError> {
    authorize_project(&state, &principal, project_id, Action::Administer).await?;
    let key = validate_object_key(&query.key)?;
    let prefix = project_prefix(&principal, project_id);
    let full_key = format!("{prefix}{key}");
    let mut transaction = state.db.begin().await.map_err(database_error)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(&full_key)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(&key)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    let linked = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS(
          SELECT 1 FROM verification_attachments
          WHERE organization_id = $1 AND project_id = $2
            AND object_key IN ($3, $4)
        )
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(&key)
    .bind(&full_key)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?;
    if linked {
        return Err(ApiError::conflict(
            "Linked evidence objects cannot be deleted",
        ));
    }
    let version_id = state.object_store.delete(&full_key).await?;
    insert_audit(
        &mut transaction,
        &principal,
        project_id,
        "storage.object_deleted",
        "storage_object",
        Uuid::new_v4(),
        serde_json::json!({
            "key": key,
            "full_key": full_key,
            "version_id": version_id,
        }),
    )
    .await?;
    transaction.commit().await.map_err(database_error)?;
    Ok((
        StatusCode::OK,
        Json(DeleteStorageObjectResponse {
            key,
            deleted: true,
            version_id,
        }),
    ))
}

fn project_prefix(principal: &Principal, project_id: Uuid) -> String {
    format!(
        "organizations/{}/projects/{project_id}/",
        principal.organization_id
    )
}

fn validate_object_key(value: &str) -> Result<String, ApiError> {
    let value = value.trim().trim_start_matches('/');
    if value.is_empty()
        || value.len() > 768
        || value.chars().any(char::is_control)
        || value
            .split('/')
            .any(|segment| matches!(segment, "." | ".."))
    {
        return Err(ApiError::bad_request("Object key is invalid"));
    }
    Ok(value.to_owned())
}

fn storage_error(error: aws_sdk_s3::error::SdkError<impl std::fmt::Debug>) -> ApiError {
    tracing::warn!(?error, "object storage operation failed");
    ApiError::unavailable("Object storage operation failed")
}

fn database_error(error: sqlx::Error) -> ApiError {
    tracing::warn!(%error, "object storage database operation failed");
    ApiError::unavailable("Object storage database operation failed")
}

#[cfg(test)]
mod tests {
    use super::validate_object_key;

    #[test]
    fn object_keys_remain_project_relative_and_cannot_traverse() {
        assert_eq!(
            validate_object_key("verification/run-1/result.json").unwrap(),
            "verification/run-1/result.json"
        );
        assert!(validate_object_key("../other-project/object").is_err());
        assert_eq!(
            validate_object_key("https://example.test/evidence/result.json").unwrap(),
            "https://example.test/evidence/result.json"
        );
    }
}
