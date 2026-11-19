use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};

use axum::{
    Json,
    extract::{Request, State},
    http::{HeaderValue, header::CONTENT_TYPE},
    middleware::Next,
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use opentelemetry::{global, propagation::Extractor};
use serde::Serialize;
use tracing_opentelemetry::OpenTelemetrySpanExt;

use crate::{AppState, auth::AuthenticatedPrincipal, error::ApiError, policy::Action};

#[derive(Clone, Default)]
pub struct OperationsMetrics {
    inner: Arc<MetricsInner>,
}

#[derive(Default)]
struct MetricsInner {
    requests: AtomicU64,
    client_errors: AtomicU64,
    server_errors: AtomicU64,
    latency_sum_micros: AtomicU64,
    latency_le_10_ms: AtomicU64,
    latency_le_50_ms: AtomicU64,
    latency_le_100_ms: AtomicU64,
    latency_le_250_ms: AtomicU64,
    latency_le_1000_ms: AtomicU64,
}

#[derive(Serialize)]
pub struct OperationsStatusResponse {
    status: &'static str,
    database: &'static str,
    telemetry: TelemetryStatus,
    service_levels: ServiceLevelStatus,
    queues: QueueStatus,
    latest_audit_event_at: Option<DateTime<Utc>>,
    timestamp: DateTime<Utc>,
}

#[derive(Serialize)]
struct TelemetryStatus {
    structured_logs: bool,
    prometheus_metrics: bool,
    otlp_traces_configured: bool,
}

#[derive(Serialize)]
struct ServiceLevelStatus {
    availability_target_percent: f64,
    latency_p95_target_ms: u64,
    request_count: u64,
    server_error_count: u64,
    observed_server_success_percent: f64,
}

#[derive(Serialize)]
struct QueueStatus {
    outbox_pending: i64,
    connector_pending: i64,
    connector_retrying: i64,
    connector_dead_letters: i64,
    oldest_connector_age_seconds: Option<i64>,
}

impl OperationsMetrics {
    fn observe(&self, status: u16, elapsed_micros: u64) {
        self.inner.requests.fetch_add(1, Ordering::Relaxed);
        self.inner
            .latency_sum_micros
            .fetch_add(elapsed_micros, Ordering::Relaxed);
        if status >= 500 {
            self.inner.server_errors.fetch_add(1, Ordering::Relaxed);
        } else if status >= 400 {
            self.inner.client_errors.fetch_add(1, Ordering::Relaxed);
        }
        let elapsed_ms = elapsed_micros / 1_000;
        for (threshold, counter) in [
            (10, &self.inner.latency_le_10_ms),
            (50, &self.inner.latency_le_50_ms),
            (100, &self.inner.latency_le_100_ms),
            (250, &self.inner.latency_le_250_ms),
            (1_000, &self.inner.latency_le_1000_ms),
        ] {
            if elapsed_ms <= threshold {
                counter.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    fn snapshot(&self) -> MetricsSnapshot {
        MetricsSnapshot {
            requests: self.inner.requests.load(Ordering::Relaxed),
            client_errors: self.inner.client_errors.load(Ordering::Relaxed),
            server_errors: self.inner.server_errors.load(Ordering::Relaxed),
            latency_sum_micros: self.inner.latency_sum_micros.load(Ordering::Relaxed),
            latency_le_10_ms: self.inner.latency_le_10_ms.load(Ordering::Relaxed),
            latency_le_50_ms: self.inner.latency_le_50_ms.load(Ordering::Relaxed),
            latency_le_100_ms: self.inner.latency_le_100_ms.load(Ordering::Relaxed),
            latency_le_250_ms: self.inner.latency_le_250_ms.load(Ordering::Relaxed),
            latency_le_1000_ms: self.inner.latency_le_1000_ms.load(Ordering::Relaxed),
        }
    }
}

struct MetricsSnapshot {
    requests: u64,
    client_errors: u64,
    server_errors: u64,
    latency_sum_micros: u64,
    latency_le_10_ms: u64,
    latency_le_50_ms: u64,
    latency_le_100_ms: u64,
    latency_le_250_ms: u64,
    latency_le_1000_ms: u64,
}

struct HeaderExtractor<'a>(&'a axum::http::HeaderMap);

impl Extractor for HeaderExtractor<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(|value| value.to_str().ok())
    }

    fn keys(&self) -> Vec<&str> {
        self.0.keys().map(axum::http::HeaderName::as_str).collect()
    }
}

pub async fn propagate_trace_context(request: Request, next: Next) -> Response {
    let parent = global::get_text_map_propagator(|propagator| {
        propagator.extract(&HeaderExtractor(request.headers()))
    });
    let _ = tracing::Span::current().set_parent(parent);
    next.run(request).await
}

pub async fn observe_request(
    State(metrics): State<OperationsMetrics>,
    request: Request,
    next: Next,
) -> Response {
    let start = Instant::now();
    let response = next.run(request).await;
    metrics.observe(
        response.status().as_u16(),
        start.elapsed().as_micros().min(u64::MAX as u128) as u64,
    );
    response
}

pub async fn prometheus_metrics(State(state): State<AppState>) -> Result<Response, ApiError> {
    let snapshot = state.metrics.snapshot();
    let delivery_counts = sqlx::query_as::<_, (String, i64)>(
        "SELECT status, count(*) FROM connector_deliveries GROUP BY status ORDER BY status",
    )
    .fetch_all(&state.db)
    .await
    .map_err(database_error)?;
    let outbox_pending = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM outbox_messages WHERE processed_at IS NULL",
    )
    .fetch_one(&state.db)
    .await
    .map_err(database_error)?;
    let mut body = format!(
        concat!(
            "# HELP openrm_http_requests_total HTTP requests observed by the API.\n",
            "# TYPE openrm_http_requests_total counter\n",
            "openrm_http_requests_total {}\n",
            "# HELP openrm_http_client_errors_total HTTP 4xx responses.\n",
            "# TYPE openrm_http_client_errors_total counter\n",
            "openrm_http_client_errors_total {}\n",
            "# HELP openrm_http_server_errors_total HTTP 5xx responses.\n",
            "# TYPE openrm_http_server_errors_total counter\n",
            "openrm_http_server_errors_total {}\n",
            "# HELP openrm_http_request_duration_seconds Request latency histogram.\n",
            "# TYPE openrm_http_request_duration_seconds histogram\n",
            "openrm_http_request_duration_seconds_bucket{{le=\"0.01\"}} {}\n",
            "openrm_http_request_duration_seconds_bucket{{le=\"0.05\"}} {}\n",
            "openrm_http_request_duration_seconds_bucket{{le=\"0.1\"}} {}\n",
            "openrm_http_request_duration_seconds_bucket{{le=\"0.25\"}} {}\n",
            "openrm_http_request_duration_seconds_bucket{{le=\"1\"}} {}\n",
            "openrm_http_request_duration_seconds_bucket{{le=\"+Inf\"}} {}\n",
            "openrm_http_request_duration_seconds_sum {:.6}\n",
            "openrm_http_request_duration_seconds_count {}\n",
            "# HELP openrm_outbox_pending Current unprocessed transactional outbox messages.\n",
            "# TYPE openrm_outbox_pending gauge\n",
            "openrm_outbox_pending {}\n",
            "# HELP openrm_connector_deliveries Connector deliveries by state.\n",
            "# TYPE openrm_connector_deliveries gauge\n"
        ),
        snapshot.requests,
        snapshot.client_errors,
        snapshot.server_errors,
        snapshot.latency_le_10_ms,
        snapshot.latency_le_50_ms,
        snapshot.latency_le_100_ms,
        snapshot.latency_le_250_ms,
        snapshot.latency_le_1000_ms,
        snapshot.requests,
        snapshot.latency_sum_micros as f64 / 1_000_000.0,
        snapshot.requests,
        outbox_pending,
    );
    for (status, count) in delivery_counts {
        body.push_str(&format!(
            "openrm_connector_deliveries{{status=\"{status}\"}} {count}\n"
        ));
    }
    let mut response = body.into_response();
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/plain; version=0.0.4; charset=utf-8"),
    );
    Ok(response)
}

pub async fn operations_status(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
) -> Result<Json<OperationsStatusResponse>, ApiError> {
    if !state
        .policy
        .allows(&principal, Action::Administer, principal.organization_id)
    {
        return Err(ApiError::forbidden(
            "Administrator role is required for operational status",
        ));
    }
    sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.db)
        .await
        .map_err(database_error)?;
    let outbox_pending = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM outbox_messages WHERE organization_id = $1 AND processed_at IS NULL",
    )
    .bind(principal.organization_id)
    .fetch_one(&state.db)
    .await
    .map_err(database_error)?;
    let (
        connector_pending,
        connector_retrying,
        connector_dead_letters,
        oldest_connector_age_seconds,
    ) = sqlx::query_as::<_, (i64, i64, i64, Option<i64>)>(
        r#"
            SELECT count(*) FILTER (WHERE status IN ('pending', 'processing')),
                   count(*) FILTER (WHERE status = 'retry'),
                   count(*) FILTER (WHERE status = 'dead_letter'),
                   extract(epoch FROM now() - min(created_at)
                       FILTER (WHERE status IN ('pending', 'processing', 'retry')))::bigint
            FROM connector_deliveries
            WHERE organization_id = $1
            "#,
    )
    .bind(principal.organization_id)
    .fetch_one(&state.db)
    .await
    .map_err(database_error)?;
    let latest_audit_event_at = sqlx::query_scalar::<_, Option<DateTime<Utc>>>(
        "SELECT max(occurred_at) FROM audit_events WHERE organization_id = $1",
    )
    .bind(principal.organization_id)
    .fetch_one(&state.db)
    .await
    .map_err(database_error)?;
    let snapshot = state.metrics.snapshot();
    let observed_server_success_percent = if snapshot.requests == 0 {
        100.0
    } else {
        ((snapshot.requests - snapshot.server_errors) as f64 / snapshot.requests as f64) * 100.0
    };
    let queue_healthy = connector_dead_letters == 0
        && outbox_pending <= 100
        && oldest_connector_age_seconds.is_none_or(|age| age <= 900);
    Ok(Json(OperationsStatusResponse {
        status: if queue_healthy {
            "healthy"
        } else {
            "attention_required"
        },
        database: "available",
        telemetry: TelemetryStatus {
            structured_logs: true,
            prometheus_metrics: true,
            otlp_traces_configured: std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").is_ok(),
        },
        service_levels: ServiceLevelStatus {
            availability_target_percent: 99.9,
            latency_p95_target_ms: 250,
            request_count: snapshot.requests,
            server_error_count: snapshot.server_errors,
            observed_server_success_percent,
        },
        queues: QueueStatus {
            outbox_pending,
            connector_pending,
            connector_retrying,
            connector_dead_letters,
            oldest_connector_age_seconds,
        },
        latest_audit_event_at,
        timestamp: Utc::now(),
    }))
}

fn database_error(error: sqlx::Error) -> ApiError {
    tracing::warn!(%error, "operational telemetry query failed");
    ApiError::unavailable("Operational telemetry is unavailable")
}

#[cfg(test)]
mod tests {
    use super::OperationsMetrics;

    #[test]
    fn records_request_service_levels() {
        let metrics = OperationsMetrics::default();
        metrics.observe(200, 8_000);
        metrics.observe(404, 80_000);
        metrics.observe(503, 1_200_000);
        let snapshot = metrics.snapshot();
        assert_eq!(snapshot.requests, 3);
        assert_eq!(snapshot.client_errors, 1);
        assert_eq!(snapshot.server_errors, 1);
        assert_eq!(snapshot.latency_le_10_ms, 1);
        assert_eq!(snapshot.latency_le_100_ms, 2);
        assert_eq!(snapshot.latency_le_1000_ms, 2);
    }
}
