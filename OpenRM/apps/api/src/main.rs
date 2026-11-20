use std::process::ExitCode;

use openrm_api::{
    AppState, BuildInfo, auth::AuthVerifier, config::Config, connect, evidence::EvidenceSigner,
    migrate, policy::PolicyEngine, router,
};
use opentelemetry::{global, trace::TracerProvider as _};
use opentelemetry_otlp::{Protocol, WithExportConfig};
use opentelemetry_sdk::{Resource, propagation::TraceContextPropagator, trace::SdkTracerProvider};
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> ExitCode {
    dotenvy::dotenv().ok();
    let telemetry = match init_tracing() {
        Ok(telemetry) => telemetry,
        Err(error) => {
            eprintln!("OpenRM telemetry initialization failed: {error}");
            return ExitCode::FAILURE;
        }
    };

    let result = if let Err(error) = run().await {
        tracing::error!(%error, "OpenRM API stopped");
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    };
    if let Some(provider) = telemetry
        && let Err(error) = provider.shutdown()
    {
        tracing::warn!(%error, "OpenTelemetry provider shutdown was incomplete");
    }

    result
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    let db = connect(&config).await?;
    if config.run_migrations {
        migrate(&db).await?;
    }
    let auth = AuthVerifier::from_config(&config).await?;
    let user_directory = openrm_api::users::UserDirectory::from_config(&config).await?;
    let object_store = openrm_api::storage::ObjectStore::from_config(&config).await?;
    let mut evidence_signer = EvidenceSigner::new(
        config.evidence_signing_key.as_bytes(),
        config.evidence_signing_key_id.clone(),
    );
    for (key_id, key) in &config.evidence_verification_keys {
        evidence_signer = evidence_signer.with_verification_key(key.as_bytes(), key_id.clone());
    }
    let jira_dispatcher =
        openrm_api::connectors::JiraDispatcher::new(config.jira_api_token.clone())?;
    let outbox_worker = tokio::spawn(openrm_api::outbox::run(db.clone()));
    let connector_worker = tokio::spawn(openrm_api::connectors::run(db.clone(), jira_dispatcher));
    let app = router(AppState {
        db,
        auth,
        policy: PolicyEngine,
        build: BuildInfo::current(),
        evidence_signer,
        metrics: openrm_api::observability::OperationsMetrics::default(),
        user_directory,
        object_store,
    });
    let listener = tokio::net::TcpListener::bind(config.bind_address).await?;
    tracing::info!(address = %config.bind_address, environment = %config.app_env, "OpenRM API listening");
    let serve_result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await;
    outbox_worker.abort();
    connector_worker.abort();
    serve_result?;
    Ok(())
}

fn init_tracing() -> Result<Option<SdkTracerProvider>, Box<dyn std::error::Error>> {
    global::set_text_map_propagator(TraceContextPropagator::new());
    let telemetry = if std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").is_ok() {
        let exporter = opentelemetry_otlp::SpanExporter::builder()
            .with_http()
            .with_protocol(Protocol::HttpBinary)
            .build()?;
        let provider = SdkTracerProvider::builder()
            .with_batch_exporter(exporter)
            .with_resource(Resource::builder().with_service_name("openrm-api").build())
            .build();
        global::set_tracer_provider(provider.clone());
        let tracer = provider.tracer("openrm-api");
        Some((provider, tracing_opentelemetry::layer().with_tracer(tracer)))
    } else {
        None
    };
    let (provider, telemetry_layer) = match telemetry {
        Some((provider, layer)) => (Some(provider), Some(layer)),
        None => (None, None),
    };
    tracing_subscriber::registry()
        .with(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "openrm_api=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer().json())
        .with(telemetry_layer)
        .init();
    Ok(provider)
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install termination handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}
