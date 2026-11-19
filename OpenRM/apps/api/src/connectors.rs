use std::{sync::Arc, time::Duration};

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use reqwest::header::RETRY_AFTER;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthenticatedPrincipal,
    error::ApiError,
    policy::Action,
    projects::{authorize_project, insert_audit},
};

#[derive(Clone)]
pub struct JiraDispatcher {
    client: reqwest::Client,
    token: Option<Arc<str>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpsertJiraConfigurationRequest {
    pub expected_version: i32,
    pub mode: String,
    pub base_url: String,
    pub remote_project_key: String,
    pub secret_ref: String,
    #[serde(default)]
    pub field_mapping: Value,
    #[serde(default = "default_max_attempts")]
    pub max_attempts: i32,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct EnqueueJiraDeliveryRequest {
    pub event_key: String,
    pub operation: String,
    pub external_issue_key: String,
    pub payload: Value,
}

#[derive(Debug, Deserialize)]
pub struct DeliveryQuery {
    pub status: Option<String>,
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct JiraConfigurationResponse {
    pub id: Uuid,
    pub project_id: Uuid,
    pub mode: String,
    pub base_url: String,
    pub remote_project_key: String,
    pub secret_ref: String,
    pub field_mapping: Value,
    pub max_attempts: i32,
    pub version: i32,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
    pub updated_by: String,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct JiraConfigurationEventResponse {
    pub id: Uuid,
    pub version: i32,
    pub mode: String,
    pub base_url: String,
    pub remote_project_key: String,
    pub secret_ref: String,
    pub field_mapping: Value,
    pub max_attempts: i32,
    pub actor_subject: String,
    pub occurred_at: DateTime<Utc>,
}

#[derive(Debug, FromRow, Serialize)]
pub struct JiraDeliveryAttemptResponse {
    pub id: Uuid,
    pub attempt: i32,
    pub outcome: String,
    pub response_status: Option<i32>,
    pub retry_after_seconds: Option<i32>,
    pub error: Option<String>,
    pub occurred_at: DateTime<Utc>,
}

#[derive(Debug, FromRow)]
struct DeliveryRecord {
    id: Uuid,
    connector_id: Uuid,
    event_key: String,
    operation: String,
    external_issue_key: String,
    payload: Value,
    payload_hash: String,
    status: String,
    attempts: i32,
    available_at: DateTime<Utc>,
    delivered_at: Option<DateTime<Utc>>,
    last_error: Option<String>,
    created_by: String,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct JiraDeliveryResponse {
    pub id: Uuid,
    pub connector_id: Uuid,
    pub event_key: String,
    pub operation: String,
    pub external_issue_key: String,
    pub payload: Value,
    pub payload_hash: String,
    pub status: String,
    pub attempts: i32,
    pub available_at: DateTime<Utc>,
    pub delivered_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
    pub attempt_history: Vec<JiraDeliveryAttemptResponse>,
}

#[derive(Debug, Serialize)]
pub struct JiraConnectorResponse {
    pub configuration: Option<JiraConfigurationResponse>,
    pub configuration_history: Vec<JiraConfigurationEventResponse>,
    pub pending: i64,
    pub retrying: i64,
    pub delivered: i64,
    pub dead_letters: i64,
}

#[derive(Debug, Serialize)]
pub struct JiraDeliveryListResponse {
    pub items: Vec<JiraDeliveryResponse>,
}

#[derive(Debug, FromRow)]
struct ClaimedDelivery {
    id: Uuid,
    organization_id: Uuid,
    project_id: Uuid,
    operation: String,
    external_issue_key: String,
    payload: Value,
    attempts: i32,
    mode: String,
    base_url: String,
    max_attempts: i32,
}

#[derive(Debug, Eq, PartialEq)]
struct DispatchOutcome {
    outcome: &'static str,
    response_status: Option<i32>,
    retry_after_seconds: Option<i32>,
    error: Option<String>,
}

impl JiraDispatcher {
    pub fn new(token: Option<String>) -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(15))
                .user_agent(concat!("OpenRM/", env!("CARGO_PKG_VERSION")))
                .build()?,
            token: token.map(Arc::from),
        })
    }

    async fn dispatch(&self, delivery: &ClaimedDelivery) -> DispatchOutcome {
        if delivery.mode == "dry_run" {
            return DispatchOutcome {
                outcome: "delivered",
                response_status: Some(204),
                retry_after_seconds: None,
                error: None,
            };
        }
        let Some(token) = self.token.as_deref() else {
            return DispatchOutcome {
                outcome: "dead_letter",
                response_status: None,
                retry_after_seconds: None,
                error: Some("JIRA_API_TOKEN is not configured".to_owned()),
            };
        };
        let url = jira_operation_url(
            &delivery.base_url,
            &delivery.operation,
            &delivery.external_issue_key,
        );
        match self
            .client
            .post(url)
            .bearer_auth(token)
            .json(&delivery.payload)
            .send()
            .await
        {
            Ok(response) => {
                let status = response.status().as_u16() as i32;
                let retry_after = response
                    .headers()
                    .get(RETRY_AFTER)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse::<i32>().ok())
                    .map(|seconds| seconds.clamp(1, 3_600));
                classify_response(
                    status,
                    retry_after,
                    delivery.attempts,
                    delivery.max_attempts,
                )
            }
            Err(error) => classify_transport_error(
                error.to_string(),
                delivery.attempts,
                delivery.max_attempts,
            ),
        }
    }
}

pub async fn get_jira_connector(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
) -> Result<Json<JiraConnectorResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Read).await?;
    let configuration =
        load_configuration(&state.db, principal.organization_id, project_id).await?;
    let configuration_history = if let Some(configuration) = &configuration {
        sqlx::query_as::<_, JiraConfigurationEventResponse>(
            r#"
            SELECT id, version, mode, base_url, remote_project_key, secret_ref,
                   field_mapping, max_attempts, actor_subject, occurred_at
            FROM connector_configuration_events
            WHERE organization_id = $1 AND project_id = $2 AND connector_id = $3
            ORDER BY version, id
            "#,
        )
        .bind(principal.organization_id)
        .bind(project_id)
        .bind(configuration.id)
        .fetch_all(&state.db)
        .await
        .map_err(database_error)?
    } else {
        Vec::new()
    };
    let (pending, retrying, delivered, dead_letters) =
        load_counts(&state.db, principal.organization_id, project_id).await?;
    Ok(Json(JiraConnectorResponse {
        configuration,
        configuration_history,
        pending,
        retrying,
        delivered,
        dead_letters,
    }))
}

pub async fn upsert_jira_connector(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
    Json(request): Json<UpsertJiraConfigurationRequest>,
) -> Result<Json<JiraConfigurationResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Administer).await?;
    let request = validate_configuration(request)?;
    let mut transaction = state.db.begin().await.map_err(database_error)?;
    let current = sqlx::query_as::<_, JiraConfigurationResponse>(
        r#"
        SELECT id, project_id, mode, base_url, remote_project_key, secret_ref,
               field_mapping, max_attempts, version, created_by, created_at,
               updated_by, updated_at
        FROM connector_configurations
        WHERE organization_id = $1 AND project_id = $2 AND connector_type = 'jira'
        FOR UPDATE
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?;
    let (connector_id, version) = match current {
        Some(current) => {
            if current.version != request.expected_version {
                return Err(ApiError::conflict_with_details(
                    "Connector configuration changed since it was loaded",
                    serde_json::json!({ "current_version": current.version }),
                ));
            }
            let version = current.version + 1;
            sqlx::query(
                r#"
                UPDATE connector_configurations
                SET mode = $4, base_url = $5, remote_project_key = $6,
                    secret_ref = $7, field_mapping = $8, max_attempts = $9,
                    version = $10, updated_by = $11, updated_at = now()
                WHERE organization_id = $1 AND project_id = $2 AND id = $3
                "#,
            )
            .bind(principal.organization_id)
            .bind(project_id)
            .bind(current.id)
            .bind(&request.mode)
            .bind(&request.base_url)
            .bind(&request.remote_project_key)
            .bind(&request.secret_ref)
            .bind(&request.field_mapping)
            .bind(request.max_attempts)
            .bind(version)
            .bind(&principal.subject)
            .execute(&mut *transaction)
            .await
            .map_err(database_error)?;
            (current.id, version)
        }
        None => {
            if request.expected_version != 0 {
                return Err(ApiError::conflict(
                    "New connector configuration must use expected_version 0",
                ));
            }
            let connector_id = Uuid::new_v4();
            sqlx::query(
                r#"
                INSERT INTO connector_configurations (
                    id, organization_id, project_id, connector_type, mode,
                    base_url, remote_project_key, secret_ref, field_mapping,
                    max_attempts, created_by, updated_by
                )
                VALUES ($1, $2, $3, 'jira', $4, $5, $6, $7, $8, $9, $10, $10)
                "#,
            )
            .bind(connector_id)
            .bind(principal.organization_id)
            .bind(project_id)
            .bind(&request.mode)
            .bind(&request.base_url)
            .bind(&request.remote_project_key)
            .bind(&request.secret_ref)
            .bind(&request.field_mapping)
            .bind(request.max_attempts)
            .bind(&principal.subject)
            .execute(&mut *transaction)
            .await
            .map_err(database_error)?;
            (connector_id, 1)
        }
    };
    sqlx::query(
        r#"
        INSERT INTO connector_configuration_events (
            id, organization_id, project_id, connector_id, version, mode,
            base_url, remote_project_key, secret_ref, field_mapping,
            max_attempts, actor_subject
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(connector_id)
    .bind(version)
    .bind(&request.mode)
    .bind(&request.base_url)
    .bind(&request.remote_project_key)
    .bind(&request.secret_ref)
    .bind(&request.field_mapping)
    .bind(request.max_attempts)
    .bind(&principal.subject)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    insert_audit(
        &mut transaction,
        &principal,
        project_id,
        "connector.jira_configured",
        "connector_configuration",
        connector_id,
        serde_json::json!({
            "version": version,
            "mode": request.mode,
            "base_url": request.base_url,
            "remote_project_key": request.remote_project_key,
            "secret_ref": request.secret_ref,
            "max_attempts": request.max_attempts
        }),
    )
    .await?;
    let response = sqlx::query_as::<_, JiraConfigurationResponse>(
        r#"
        SELECT id, project_id, mode, base_url, remote_project_key, secret_ref,
               field_mapping, max_attempts, version, created_by, created_at,
               updated_by, updated_at
        FROM connector_configurations
        WHERE organization_id = $1 AND project_id = $2 AND id = $3
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(connector_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;
    Ok(Json(response))
}

pub async fn list_jira_deliveries(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
    Query(query): Query<DeliveryQuery>,
) -> Result<Json<JiraDeliveryListResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Read).await?;
    if let Some(status) = query.status.as_deref()
        && !valid_delivery_status(status)
    {
        return Err(ApiError::bad_request("Delivery status filter is invalid"));
    }
    let records = sqlx::query_as::<_, DeliveryRecord>(
        r#"
        SELECT id, connector_id, event_key, operation, external_issue_key,
               payload, payload_hash, status, attempts, available_at,
               delivered_at, last_error, created_by, created_at
        FROM connector_deliveries
        WHERE organization_id = $1 AND project_id = $2
          AND ($3::text IS NULL OR status = $3)
        ORDER BY created_at DESC, id DESC
        LIMIT 200
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(query.status)
    .fetch_all(&state.db)
    .await
    .map_err(database_error)?;
    let mut items = Vec::with_capacity(records.len());
    for record in records {
        items.push(load_delivery_response(&state.db, &principal, project_id, record).await?);
    }
    Ok(Json(JiraDeliveryListResponse { items }))
}

pub async fn enqueue_jira_delivery(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
    Json(request): Json<EnqueueJiraDeliveryRequest>,
) -> Result<(StatusCode, Json<JiraDeliveryResponse>), ApiError> {
    authorize_project(&state, &principal, project_id, Action::Write).await?;
    let request = validate_delivery(request)?;
    let payload_hash = payload_hash(&request)?;
    let mut transaction = state.db.begin().await.map_err(database_error)?;
    let connector_id = sqlx::query_scalar::<_, Uuid>(
        r#"
        SELECT id FROM connector_configurations
        WHERE organization_id = $1 AND project_id = $2
          AND connector_type = 'jira' AND mode <> 'disabled'
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?
    .ok_or_else(|| ApiError::conflict("Jira connector is not enabled"))?;
    let existing = sqlx::query_as::<_, DeliveryRecord>(
        r#"
        SELECT id, connector_id, event_key, operation, external_issue_key,
               payload, payload_hash, status, attempts, available_at,
               delivered_at, last_error, created_by, created_at
        FROM connector_deliveries
        WHERE organization_id = $1 AND project_id = $2
          AND connector_id = $3 AND event_key = $4
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(connector_id)
    .bind(&request.event_key)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?;
    if let Some(existing) = existing {
        if existing.payload_hash != payload_hash {
            return Err(ApiError::conflict(
                "Connector event key was already used with a different payload",
            ));
        }
        transaction.commit().await.map_err(database_error)?;
        let response = load_delivery_response(&state.db, &principal, project_id, existing).await?;
        return Ok((StatusCode::OK, Json(response)));
    }
    let delivery_id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO connector_deliveries (
            id, organization_id, project_id, connector_id, event_key,
            operation, external_issue_key, payload, payload_hash,
            status, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10)
        "#,
    )
    .bind(delivery_id)
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(connector_id)
    .bind(&request.event_key)
    .bind(&request.operation)
    .bind(&request.external_issue_key)
    .bind(&request.payload)
    .bind(&payload_hash)
    .bind(&principal.subject)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    insert_audit(
        &mut transaction,
        &principal,
        project_id,
        "connector.delivery_enqueued",
        "connector_delivery",
        delivery_id,
        serde_json::json!({
            "connector_id": connector_id,
            "event_key": request.event_key,
            "operation": request.operation,
            "external_issue_key": request.external_issue_key,
            "payload_hash": payload_hash
        }),
    )
    .await?;
    transaction.commit().await.map_err(database_error)?;
    let record = load_delivery_record(
        &state.db,
        principal.organization_id,
        project_id,
        delivery_id,
    )
    .await?;
    Ok((
        StatusCode::CREATED,
        Json(load_delivery_response(&state.db, &principal, project_id, record).await?),
    ))
}

pub async fn replay_jira_delivery(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path((project_id, delivery_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<JiraDeliveryResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Administer).await?;
    let mut transaction = state.db.begin().await.map_err(database_error)?;
    let status = sqlx::query_scalar::<_, String>(
        r#"
        SELECT status FROM connector_deliveries
        WHERE organization_id = $1 AND project_id = $2 AND id = $3
        FOR UPDATE
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(delivery_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?
    .ok_or_else(|| ApiError::not_found("Connector delivery does not exist"))?;
    if status != "dead_letter" {
        return Err(ApiError::conflict(
            "Only dead-letter deliveries can be replayed",
        ));
    }
    sqlx::query(
        r#"
        UPDATE connector_deliveries
        SET status = 'pending', available_at = now(), locked_at = NULL,
            delivered_at = NULL, last_error = NULL
        WHERE organization_id = $1 AND project_id = $2 AND id = $3
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(delivery_id)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    insert_audit(
        &mut transaction,
        &principal,
        project_id,
        "connector.delivery_replayed",
        "connector_delivery",
        delivery_id,
        serde_json::json!({ "prior_status": status }),
    )
    .await?;
    transaction.commit().await.map_err(database_error)?;
    let record = load_delivery_record(
        &state.db,
        principal.organization_id,
        project_id,
        delivery_id,
    )
    .await?;
    Ok(Json(
        load_delivery_response(&state.db, &principal, project_id, record).await?,
    ))
}

pub async fn run(pool: PgPool, dispatcher: JiraDispatcher) {
    loop {
        match process_next(&pool, &dispatcher).await {
            Ok(true) => continue,
            Ok(false) => tokio::time::sleep(Duration::from_millis(250)).await,
            Err(error) => {
                tracing::warn!(%error, "connector delivery processing failed");
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
}

async fn process_next(pool: &PgPool, dispatcher: &JiraDispatcher) -> Result<bool, sqlx::Error> {
    let mut transaction = pool.begin().await?;
    let claimed = sqlx::query_as::<_, ClaimedDelivery>(
        r#"
        WITH candidate AS (
            SELECT delivery.id
            FROM connector_deliveries delivery
            JOIN connector_configurations config
              ON config.organization_id = delivery.organization_id
             AND config.project_id = delivery.project_id
             AND config.id = delivery.connector_id
            WHERE config.mode <> 'disabled'
              AND (
                (delivery.status IN ('pending', 'retry') AND delivery.available_at <= now())
                OR (delivery.status = 'processing' AND delivery.locked_at < now() - interval '5 minutes')
              )
            ORDER BY delivery.available_at, delivery.created_at, delivery.id
            FOR UPDATE OF delivery SKIP LOCKED
            LIMIT 1
        )
        UPDATE connector_deliveries delivery
        SET status = 'processing', locked_at = now(), attempts = delivery.attempts + 1
        FROM candidate, connector_configurations config
        WHERE delivery.id = candidate.id
          AND config.organization_id = delivery.organization_id
          AND config.project_id = delivery.project_id
          AND config.id = delivery.connector_id
        RETURNING delivery.id, delivery.organization_id, delivery.project_id,
                  delivery.operation, delivery.external_issue_key, delivery.payload,
                  delivery.attempts, config.mode, config.base_url, config.max_attempts
        "#,
    )
    .fetch_optional(&mut *transaction)
    .await?;
    transaction.commit().await?;
    let Some(claimed) = claimed else {
        return Ok(false);
    };
    let outcome = dispatcher.dispatch(&claimed).await;
    let mut transaction = pool.begin().await?;
    sqlx::query(
        r#"
        INSERT INTO connector_delivery_attempts (
            id, organization_id, project_id, delivery_id, attempt,
            outcome, response_status, retry_after_seconds, error
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(claimed.organization_id)
    .bind(claimed.project_id)
    .bind(claimed.id)
    .bind(claimed.attempts)
    .bind(outcome.outcome)
    .bind(outcome.response_status)
    .bind(outcome.retry_after_seconds)
    .bind(&outcome.error)
    .execute(&mut *transaction)
    .await?;
    match outcome.outcome {
        "delivered" => {
            sqlx::query(
                r#"
                UPDATE connector_deliveries
                SET status = 'delivered', delivered_at = now(), locked_at = NULL,
                    last_error = NULL
                WHERE id = $1
                "#,
            )
            .bind(claimed.id)
            .execute(&mut *transaction)
            .await?;
        }
        "retry" => {
            let retry_seconds = outcome
                .retry_after_seconds
                .unwrap_or_else(|| backoff_seconds(claimed.attempts));
            sqlx::query(
                r#"
                UPDATE connector_deliveries
                SET status = 'retry', available_at = now() + make_interval(secs => $2),
                    locked_at = NULL, last_error = $3
                WHERE id = $1
                "#,
            )
            .bind(claimed.id)
            .bind(retry_seconds as f64)
            .bind(&outcome.error)
            .execute(&mut *transaction)
            .await?;
        }
        _ => {
            sqlx::query(
                r#"
                UPDATE connector_deliveries
                SET status = 'dead_letter', locked_at = NULL, last_error = $2
                WHERE id = $1
                "#,
            )
            .bind(claimed.id)
            .bind(&outcome.error)
            .execute(&mut *transaction)
            .await?;
        }
    }
    transaction.commit().await?;
    Ok(true)
}

fn classify_response(
    status: i32,
    retry_after_seconds: Option<i32>,
    attempt: i32,
    max_attempts: i32,
) -> DispatchOutcome {
    if (200..300).contains(&status) {
        return DispatchOutcome {
            outcome: "delivered",
            response_status: Some(status),
            retry_after_seconds: None,
            error: None,
        };
    }
    let retryable = status == 408 || status == 425 || status == 429 || status >= 500;
    if retryable && attempt < max_attempts {
        return DispatchOutcome {
            outcome: "retry",
            response_status: Some(status),
            retry_after_seconds,
            error: Some(format!("Jira returned retryable HTTP {status}")),
        };
    }
    DispatchOutcome {
        outcome: "dead_letter",
        response_status: Some(status),
        retry_after_seconds: None,
        error: Some(format!("Jira delivery failed with HTTP {status}")),
    }
}

fn classify_transport_error(error: String, attempt: i32, max_attempts: i32) -> DispatchOutcome {
    DispatchOutcome {
        outcome: if attempt < max_attempts {
            "retry"
        } else {
            "dead_letter"
        },
        response_status: None,
        retry_after_seconds: None,
        error: Some(error),
    }
}

fn jira_operation_url(base_url: &str, operation: &str, issue_key: &str) -> String {
    let base = base_url.trim_end_matches('/');
    match operation {
        "link_issue" => format!("{base}/rest/api/3/issueLink"),
        "sync_status" => format!("{base}/rest/api/3/issue/{issue_key}/transitions"),
        _ => format!("{base}/rest/api/3/issue/{issue_key}/comment"),
    }
}

fn backoff_seconds(attempt: i32) -> i32 {
    2_i32.saturating_pow(attempt.clamp(1, 8) as u32).min(300)
}

fn validate_configuration(
    mut request: UpsertJiraConfigurationRequest,
) -> Result<UpsertJiraConfigurationRequest, ApiError> {
    request.mode = request.mode.trim().to_ascii_lowercase();
    request.base_url = request.base_url.trim().trim_end_matches('/').to_owned();
    request.remote_project_key = request.remote_project_key.trim().to_ascii_uppercase();
    request.secret_ref = request.secret_ref.trim().to_owned();
    if request.expected_version < 0 {
        return Err(ApiError::bad_request("expected_version cannot be negative"));
    }
    if !matches!(request.mode.as_str(), "disabled" | "dry_run" | "active") {
        return Err(ApiError::bad_request("Connector mode is invalid"));
    }
    if !valid_base_url(&request.base_url) {
        return Err(ApiError::bad_request(
            "Jira base URL must be an HTTPS origin without credentials, query, or fragment",
        ));
    }
    if !valid_remote_project_key(&request.remote_project_key) {
        return Err(ApiError::bad_request("Jira project key is invalid"));
    }
    if request.secret_ref != "env:JIRA_API_TOKEN" {
        return Err(ApiError::bad_request(
            "Jira secret_ref must be env:JIRA_API_TOKEN for this adapter version",
        ));
    }
    if !request.field_mapping.is_object() {
        return Err(ApiError::bad_request("Field mapping must be a JSON object"));
    }
    if !(1..=20).contains(&request.max_attempts) {
        return Err(ApiError::bad_request(
            "max_attempts must be between 1 and 20",
        ));
    }
    Ok(request)
}

fn validate_delivery(
    mut request: EnqueueJiraDeliveryRequest,
) -> Result<EnqueueJiraDeliveryRequest, ApiError> {
    request.event_key = request.event_key.trim().to_owned();
    request.operation = request.operation.trim().to_ascii_lowercase();
    request.external_issue_key = request.external_issue_key.trim().to_ascii_uppercase();
    if !(8..=128).contains(&request.event_key.len())
        || !request
            .event_key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(ApiError::bad_request("Connector event key is invalid"));
    }
    if !matches!(
        request.operation.as_str(),
        "link_issue" | "comment_revision" | "sync_status"
    ) {
        return Err(ApiError::bad_request("Connector operation is invalid"));
    }
    if !valid_issue_key(&request.external_issue_key) {
        return Err(ApiError::bad_request("Jira issue key is invalid"));
    }
    if !request.payload.is_object() {
        return Err(ApiError::bad_request(
            "Connector payload must be a JSON object",
        ));
    }
    let size = serde_json::to_vec(&request.payload)
        .map_err(|_| ApiError::bad_request("Connector payload is invalid"))?
        .len();
    if size > 128 * 1024 {
        return Err(ApiError::bad_request(
            "Connector payload cannot exceed 128 KiB",
        ));
    }
    Ok(request)
}

fn valid_base_url(value: &str) -> bool {
    reqwest::Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
    })
}

fn valid_remote_project_key(value: &str) -> bool {
    (2..=32).contains(&value.len())
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_uppercase())
        && value.bytes().all(|byte| {
            byte.is_ascii_uppercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
}

fn valid_issue_key(value: &str) -> bool {
    let Some((project, number)) = value.rsplit_once('-') else {
        return false;
    };
    valid_remote_project_key(project)
        && number.starts_with(|character: char| character.is_ascii_digit() && character != '0')
        && number.chars().all(|character| character.is_ascii_digit())
}

fn valid_delivery_status(value: &str) -> bool {
    matches!(
        value,
        "pending" | "processing" | "retry" | "delivered" | "dead_letter"
    )
}

fn payload_hash(request: &EnqueueJiraDeliveryRequest) -> Result<String, ApiError> {
    let bytes = serde_json::to_vec(request)
        .map_err(|_| ApiError::bad_request("Connector payload cannot be serialized"))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

async fn load_configuration(
    pool: &PgPool,
    organization_id: Uuid,
    project_id: Uuid,
) -> Result<Option<JiraConfigurationResponse>, ApiError> {
    sqlx::query_as::<_, JiraConfigurationResponse>(
        r#"
        SELECT id, project_id, mode, base_url, remote_project_key, secret_ref,
               field_mapping, max_attempts, version, created_by, created_at,
               updated_by, updated_at
        FROM connector_configurations
        WHERE organization_id = $1 AND project_id = $2 AND connector_type = 'jira'
        "#,
    )
    .bind(organization_id)
    .bind(project_id)
    .fetch_optional(pool)
    .await
    .map_err(database_error)
}

async fn load_counts(
    pool: &PgPool,
    organization_id: Uuid,
    project_id: Uuid,
) -> Result<(i64, i64, i64, i64), ApiError> {
    sqlx::query_as::<_, (i64, i64, i64, i64)>(
        r#"
        SELECT count(*) FILTER (WHERE status IN ('pending', 'processing')),
               count(*) FILTER (WHERE status = 'retry'),
               count(*) FILTER (WHERE status = 'delivered'),
               count(*) FILTER (WHERE status = 'dead_letter')
        FROM connector_deliveries
        WHERE organization_id = $1 AND project_id = $2
        "#,
    )
    .bind(organization_id)
    .bind(project_id)
    .fetch_one(pool)
    .await
    .map_err(database_error)
}

async fn load_delivery_record(
    pool: &PgPool,
    organization_id: Uuid,
    project_id: Uuid,
    delivery_id: Uuid,
) -> Result<DeliveryRecord, ApiError> {
    sqlx::query_as::<_, DeliveryRecord>(
        r#"
        SELECT id, connector_id, event_key, operation, external_issue_key,
               payload, payload_hash, status, attempts, available_at,
               delivered_at, last_error, created_by, created_at
        FROM connector_deliveries
        WHERE organization_id = $1 AND project_id = $2 AND id = $3
        "#,
    )
    .bind(organization_id)
    .bind(project_id)
    .bind(delivery_id)
    .fetch_optional(pool)
    .await
    .map_err(database_error)?
    .ok_or_else(|| ApiError::not_found("Connector delivery does not exist"))
}

async fn load_delivery_response(
    pool: &PgPool,
    principal: &crate::policy::Principal,
    project_id: Uuid,
    record: DeliveryRecord,
) -> Result<JiraDeliveryResponse, ApiError> {
    let attempt_history = sqlx::query_as::<_, JiraDeliveryAttemptResponse>(
        r#"
        SELECT id, attempt, outcome, response_status, retry_after_seconds,
               error, occurred_at
        FROM connector_delivery_attempts
        WHERE organization_id = $1 AND project_id = $2 AND delivery_id = $3
        ORDER BY attempt, id
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(record.id)
    .fetch_all(pool)
    .await
    .map_err(database_error)?;
    Ok(JiraDeliveryResponse {
        id: record.id,
        connector_id: record.connector_id,
        event_key: record.event_key,
        operation: record.operation,
        external_issue_key: record.external_issue_key,
        payload: record.payload,
        payload_hash: record.payload_hash,
        status: record.status,
        attempts: record.attempts,
        available_at: record.available_at,
        delivered_at: record.delivered_at,
        last_error: record.last_error,
        created_by: record.created_by,
        created_at: record.created_at,
        attempt_history,
    })
}

fn default_max_attempts() -> i32 {
    5
}

fn database_error(error: sqlx::Error) -> ApiError {
    tracing::warn!(%error, "connector database operation failed");
    ApiError::unavailable("Connector database operation failed")
}

#[cfg(test)]
mod tests {
    use super::{
        DispatchOutcome, EnqueueJiraDeliveryRequest, UpsertJiraConfigurationRequest,
        backoff_seconds, classify_response, jira_operation_url, payload_hash, valid_base_url,
        valid_issue_key, validate_configuration,
    };

    #[test]
    fn honors_rate_limits_and_attempt_boundaries() {
        assert_eq!(
            classify_response(429, Some(45), 1, 5),
            DispatchOutcome {
                outcome: "retry",
                response_status: Some(429),
                retry_after_seconds: Some(45),
                error: Some("Jira returned retryable HTTP 429".to_owned()),
            }
        );
        assert_eq!(classify_response(503, None, 5, 5).outcome, "dead_letter");
        assert_eq!(classify_response(400, None, 1, 5).outcome, "dead_letter");
        assert_eq!(classify_response(204, None, 1, 5).outcome, "delivered");
    }

    #[test]
    fn builds_allowlisted_jira_paths() {
        assert_eq!(
            jira_operation_url("https://jira.example", "comment_revision", "ENG-42"),
            "https://jira.example/rest/api/3/issue/ENG-42/comment"
        );
        assert_eq!(
            jira_operation_url("https://jira.example/", "link_issue", "ENG-42"),
            "https://jira.example/rest/api/3/issueLink"
        );
        assert!(valid_issue_key("ENG-42"));
        assert!(!valid_issue_key("eng-0"));
        assert!(valid_base_url("https://jira.example"));
        assert!(!valid_base_url("http://jira.example"));
        assert!(!valid_base_url("http://127.0.0.1:8081"));
        assert!(!valid_base_url("https://user:secret@jira.example"));
        assert!(!valid_base_url("https://jira.example?redirect=internal"));
    }

    #[test]
    fn connector_hash_and_backoff_are_stable() {
        let request = EnqueueJiraDeliveryRequest {
            event_key: "revision:42".to_owned(),
            operation: "comment_revision".to_owned(),
            external_issue_key: "ENG-42".to_owned(),
            payload: serde_json::json!({ "body": "revision 3" }),
        };
        assert_eq!(
            payload_hash(&request).unwrap(),
            payload_hash(&request).unwrap()
        );
        assert_eq!(payload_hash(&request).unwrap().len(), 64);
        assert_eq!(backoff_seconds(1), 2);
        assert_eq!(backoff_seconds(20), 256);
    }

    #[test]
    fn connector_credentials_remain_on_the_fixed_external_secret_boundary() {
        let request = UpsertJiraConfigurationRequest {
            expected_version: 0,
            mode: "dry_run".to_owned(),
            base_url: "https://jira.example".to_owned(),
            remote_project_key: "OPENRM".to_owned(),
            secret_ref: "env:JIRA_API_TOKEN".to_owned(),
            field_mapping: serde_json::json!({}),
            max_attempts: 5,
        };
        assert!(validate_configuration(request.clone()).is_ok());
        assert!(
            validate_configuration(UpsertJiraConfigurationRequest {
                secret_ref: "inline:never-store-a-token".to_owned(),
                ..request
            })
            .is_err()
        );
    }
}
