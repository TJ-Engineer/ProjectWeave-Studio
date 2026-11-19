pub mod agent_runs;
pub mod auth;
pub mod config;
pub mod connectors;
pub mod controlled_change;
pub mod error;
pub mod evidence;
pub mod observability;
pub mod outbox;
pub mod policy;
pub mod projects;
pub mod relationships;
pub mod requirements;
pub mod reviews;
pub mod storage;
pub mod users;
pub mod verification;

use std::time::Duration;

use auth::{AuthVerifier, AuthenticatedPrincipal};
use axum::{
    Json, Router,
    extract::DefaultBodyLimit,
    extract::State,
    http::{HeaderName, HeaderValue, Method, StatusCode},
    middleware,
    routing::get,
};
use chrono::{DateTime, Utc};
use config::Config;
use error::ApiError;
use evidence::EvidenceSigner;
use policy::{Action, PolicyEngine, Principal};
use serde::Serialize;
use sqlx::{PgPool, postgres::PgPoolOptions};
use tower_http::{
    catch_panic::CatchPanicLayer,
    cors::CorsLayer,
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    sensitive_headers::SetSensitiveRequestHeadersLayer,
    set_header::SetResponseHeaderLayer,
    timeout::TimeoutLayer,
    trace::TraceLayer,
};

const REQUEST_ID_HEADER: &str = "x-request-id";

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub auth: AuthVerifier,
    pub policy: PolicyEngine,
    pub build: BuildInfo,
    pub evidence_signer: EvidenceSigner,
    pub metrics: observability::OperationsMetrics,
    pub user_directory: users::UserDirectory,
    pub object_store: storage::ObjectStore,
}

#[derive(Clone, Serialize)]
pub struct BuildInfo {
    pub service: &'static str,
    pub version: &'static str,
    pub git_sha: &'static str,
    pub profile: &'static str,
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    build: BuildInfo,
    timestamp: DateTime<Utc>,
}

#[derive(Serialize)]
struct ReadinessResponse {
    status: &'static str,
    database: &'static str,
    timestamp: DateTime<Utc>,
}

#[derive(Serialize)]
struct SessionResponse {
    subject: String,
    organization_id: uuid::Uuid,
    roles: Vec<String>,
    database: &'static str,
}

impl BuildInfo {
    pub fn current() -> Self {
        Self {
            service: "openrm-api",
            version: env!("CARGO_PKG_VERSION"),
            git_sha: option_env!("OPENRM_GIT_SHA").unwrap_or("development"),
            profile: option_env!("OPENRM_BUILD_PROFILE").unwrap_or("development"),
        }
    }
}

pub async fn connect(config: &Config) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&config.database_url)
        .await
}

pub async fn migrate(pool: &PgPool) -> Result<(), sqlx::migrate::MigrateError> {
    // Compile the complete forward-migration set into the API and migration binary.
    sqlx::migrate!("../../db/migrations").run(pool).await
}

pub fn router(state: AppState) -> Router {
    let metrics = state.metrics.clone();
    let request_id_header = HeaderName::from_static(REQUEST_ID_HEADER);
    let cors = CorsLayer::new()
        .allow_origin(
            "http://127.0.0.1:5173"
                .parse::<HeaderValue>()
                .expect("valid local origin"),
        )
        .allow_headers([
            http::header::AUTHORIZATION,
            http::header::CONTENT_TYPE,
            HeaderName::from_static("x-openrm-organization"),
            HeaderName::from_static("x-idempotency-key"),
        ])
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE]);

    Router::new()
        .route("/health", get(health))
        .route("/ready", get(ready))
        .route("/metrics", get(observability::prometheus_metrics))
        .route("/api/v1/session", get(session))
        .route(
            "/api/v1/users",
            get(users::list_users).post(users::invite_user),
        )
        .route(
            "/api/v1/profile",
            get(users::get_profile).put(users::update_profile),
        )
        .route(
            "/api/v1/operations/status",
            get(observability::operations_status),
        )
        .route(
            "/api/v1/projects",
            get(requirements::list_projects).post(projects::create_project),
        )
        .route(
            "/api/v1/projects/{project_id}/members",
            get(projects::list_memberships).post(projects::upsert_membership),
        )
        .route(
            "/api/v1/projects/{project_id}/workspace/{resource}",
            get(projects::list_workspace_resources).post(projects::create_workspace_resource),
        )
        .route(
            "/api/v1/projects/{project_id}/requirements",
            get(requirements::list_requirements).post(requirements::create_requirement),
        )
        .route(
            "/api/v1/projects/{project_id}/requirements/import",
            axum::routing::post(requirements::import_requirements),
        )
        .route(
            "/api/v1/projects/{project_id}/requirements/export",
            get(requirements::export_requirements),
        )
        .route(
            "/api/v1/projects/{project_id}/requirements/{requirement_id}",
            get(requirements::get_requirement).put(requirements::revise_requirement),
        )
        .route(
            "/api/v1/projects/{project_id}/requirements/{requirement_id}/derived",
            axum::routing::post(requirements::create_derived_requirement),
        )
        .route(
            "/api/v1/projects/{project_id}/requirements/{requirement_id}/revisions",
            get(requirements::list_requirement_revisions),
        )
        .route(
            "/api/v1/projects/{project_id}/requirements/{requirement_id}/compare",
            get(requirements::compare_requirement_revisions),
        )
        .route(
            "/api/v1/projects/{project_id}/agent-runs",
            get(agent_runs::list_agent_runs).post(agent_runs::create_agent_run),
        )
        .route(
            "/api/v1/projects/{project_id}/agent-runs/{agent_run_id}",
            get(agent_runs::get_agent_run),
        )
        .route(
            "/api/v1/projects/{project_id}/storage/objects",
            get(storage::list_objects).delete(storage::delete_object),
        )
        .route(
            "/api/v1/projects/{project_id}/relationship-types",
            get(relationships::list_relationship_types),
        )
        .route(
            "/api/v1/projects/{project_id}/relationships",
            get(relationships::list_relationships).post(relationships::create_relationship),
        )
        .route(
            "/api/v1/projects/{project_id}/relationships/{relationship_id}/resolve",
            axum::routing::post(relationships::resolve_relationship),
        )
        .route(
            "/api/v1/projects/{project_id}/relationships/{relationship_id}/revisions",
            get(relationships::list_relationship_revisions),
        )
        .route(
            "/api/v1/projects/{project_id}/trace/summary",
            get(controlled_change::get_trace_summary),
        )
        .route(
            "/api/v1/projects/{project_id}/trace/matrix",
            get(controlled_change::get_trace_matrix),
        )
        .route(
            "/api/v1/projects/{project_id}/trace/graph",
            get(controlled_change::get_trace_graph),
        )
        .route(
            "/api/v1/projects/{project_id}/changesets",
            get(controlled_change::list_changesets).post(controlled_change::create_changeset),
        )
        .route(
            "/api/v1/projects/{project_id}/changesets/{changeset_id}",
            get(controlled_change::get_changeset),
        )
        .route(
            "/api/v1/projects/{project_id}/baselines",
            get(controlled_change::list_baselines).post(controlled_change::create_baseline),
        )
        .route(
            "/api/v1/projects/{project_id}/baselines/compare",
            get(controlled_change::compare_baselines),
        )
        .route(
            "/api/v1/projects/{project_id}/baselines/{baseline_id}/evidence",
            get(controlled_change::export_evidence),
        )
        .route(
            "/api/v1/projects/{project_id}/reviews",
            get(reviews::list_reviews).post(reviews::create_review),
        )
        .route(
            "/api/v1/projects/{project_id}/reviews/{review_id}",
            get(reviews::get_review),
        )
        .route(
            "/api/v1/projects/{project_id}/reviews/{review_id}/participants",
            axum::routing::post(reviews::add_participant),
        )
        .route(
            "/api/v1/projects/{project_id}/reviews/{review_id}/start",
            axum::routing::post(reviews::start_review),
        )
        .route(
            "/api/v1/projects/{project_id}/reviews/{review_id}/comments",
            axum::routing::post(reviews::add_comment),
        )
        .route(
            "/api/v1/projects/{project_id}/reviews/{review_id}/comments/{comment_id}/resolve",
            axum::routing::post(reviews::resolve_comment),
        )
        .route(
            "/api/v1/projects/{project_id}/reviews/{review_id}/decisions",
            axum::routing::post(reviews::record_decision),
        )
        .route(
            "/api/v1/projects/{project_id}/reviews/{review_id}/evidence",
            get(verification::export_gate_evidence),
        )
        .route(
            "/api/v1/projects/{project_id}/verification/cases",
            get(verification::list_cases).post(verification::create_case),
        )
        .route(
            "/api/v1/projects/{project_id}/verification/cases/{case_id}/runs",
            axum::routing::post(verification::start_run),
        )
        .route(
            "/api/v1/projects/{project_id}/verification/runs/{run_id}/results",
            axum::routing::post(verification::record_result),
        )
        .route(
            "/api/v1/projects/{project_id}/verification/coverage",
            get(verification::get_coverage),
        )
        .route(
            "/api/v1/projects/{project_id}/verification/readiness",
            get(verification::get_readiness),
        )
        .route(
            "/api/v1/projects/{project_id}/verification/due-events",
            get(verification::list_due_events).post(verification::generate_due_events),
        )
        .route(
            "/api/v1/projects/{project_id}/connectors/jira",
            get(connectors::get_jira_connector).put(connectors::upsert_jira_connector),
        )
        .route(
            "/api/v1/projects/{project_id}/connectors/jira/deliveries",
            get(connectors::list_jira_deliveries).post(connectors::enqueue_jira_delivery),
        )
        .route(
            "/api/v1/projects/{project_id}/connectors/jira/deliveries/{delivery_id}/replay",
            axum::routing::post(connectors::replay_jira_delivery),
        )
        .fallback(not_found)
        .with_state(state)
        .layer(CatchPanicLayer::new())
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(30),
        ))
        .layer(SetSensitiveRequestHeadersLayer::new(std::iter::once(
            http::header::AUTHORIZATION,
        )))
        .layer(cors)
        .layer(middleware::from_fn(observability::propagate_trace_context))
        .layer(TraceLayer::new_for_http())
        .layer(PropagateRequestIdLayer::new(request_id_header.clone()))
        .layer(SetRequestIdLayer::new(request_id_header, MakeRequestUuid))
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("content-security-policy"),
            HeaderValue::from_static("default-src 'none'; frame-ancestors 'none'"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("referrer-policy"),
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("x-content-type-options"),
            HeaderValue::from_static("nosniff"),
        ))
        .layer(middleware::from_fn_with_state(
            metrics,
            observability::observe_request,
        ))
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        build: state.build,
        timestamp: Utc::now(),
    })
}

async fn ready(State(state): State<AppState>) -> Result<Json<ReadinessResponse>, ApiError> {
    database_check(&state.db).await?;
    Ok(Json(ReadinessResponse {
        status: "ready",
        database: "available",
        timestamp: Utc::now(),
    }))
}

async fn session(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
) -> Result<Json<SessionResponse>, ApiError> {
    authorize_read(&state, &principal)?;
    database_check(&state.db).await?;
    Ok(Json(SessionResponse {
        subject: principal.subject,
        organization_id: principal.organization_id,
        roles: principal.roles,
        database: "available",
    }))
}

fn authorize_read(state: &AppState, principal: &Principal) -> Result<(), ApiError> {
    authorize(state, principal, Action::Read)
}

fn authorize(state: &AppState, principal: &Principal, action: Action) -> Result<(), ApiError> {
    state
        .policy
        .allows(principal, action, principal.organization_id)
        .then_some(())
        .ok_or_else(|| ApiError::forbidden("Principal is not authorized for this action"))
}

async fn database_check(pool: &PgPool) -> Result<(), ApiError> {
    let value = sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(pool)
        .await
        .map_err(|error| {
            tracing::warn!(%error, "database readiness check failed");
            ApiError::unavailable("Database is not available")
        })?;
    if value != 1 {
        return Err(ApiError::unavailable(
            "Database readiness check returned an invalid result",
        ));
    }
    Ok(())
}

async fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "not_found", "Route does not exist")
}

#[cfg(test)]
mod tests {
    use super::{AppState, BuildInfo, router};
    use crate::{
        auth::AuthVerifier, evidence::EvidenceSigner, observability::OperationsMetrics,
        policy::PolicyEngine,
    };
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use sqlx::postgres::PgPoolOptions;
    use tower::ServiceExt;

    fn test_state() -> AppState {
        AppState {
            db: PgPoolOptions::new()
                .connect_lazy("postgres://openrm:openrm@127.0.0.1:1/openrm")
                .expect("lazy pool should be valid"),
            auth: AuthVerifier::dev(),
            policy: PolicyEngine,
            build: BuildInfo::current(),
            evidence_signer: EvidenceSigner::development(),
            metrics: OperationsMetrics::default(),
            user_directory: crate::users::UserDirectory::development(),
            object_store: crate::storage::ObjectStore::disabled(),
        }
    }

    #[tokio::test]
    async fn health_is_public_and_reports_build_metadata() {
        let response = router(test_state())
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["status"], "ok");
        assert_eq!(body["build"]["service"], "openrm-api");
    }

    #[tokio::test]
    async fn protected_session_requires_authentication() {
        let response = router(test_state())
            .oneshot(
                Request::builder()
                    .uri("/api/v1/session")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 401);
    }
}
