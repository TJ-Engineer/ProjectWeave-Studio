use std::collections::HashMap;

use axum::{
    Json,
    extract::{Path, Query, State},
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
const CREATE_CHANGESET_COMMAND: &str = "changeset.create";
const CREATE_BASELINE_COMMAND: &str = "baseline.create";
const POLICY_VERSION: &str = "project-policy-v1";
const EVIDENCE_SCHEMA_VERSION: &str = "openrm-evidence-v1";

#[derive(Debug, FromRow, Serialize)]
pub struct TraceMatrixRow {
    pub artifact_id: Uuid,
    pub key: String,
    pub title: String,
    pub revision: i32,
    pub upstream_count: i64,
    pub downstream_count: i64,
    pub suspect_count: i64,
    pub gap: bool,
}

#[derive(Debug, Serialize)]
pub struct TraceMatrixResponse {
    pub items: Vec<TraceMatrixRow>,
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct TraceEdge {
    pub relationship_id: Uuid,
    pub relationship_type_key: String,
    pub source_artifact_id: Uuid,
    pub target_artifact_id: Uuid,
    pub version: i32,
    pub suspect: bool,
}

#[derive(Debug, Serialize)]
pub struct TraceSummaryResponse {
    pub total_artifacts: i64,
    pub covered_artifacts: i64,
    pub orphan_artifacts: i64,
    pub relationships: i64,
    pub suspect_relationships: i64,
    pub coverage_percent: f64,
}

#[derive(Debug, Serialize)]
pub struct TraceGraphResponse {
    pub nodes: Vec<TraceMatrixRow>,
    pub edges: Vec<TraceEdge>,
    pub summary: TraceSummaryResponse,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CreateChangesetRequest {
    pub message: String,
}

#[derive(Debug, Clone, Deserialize, FromRow, Serialize)]
pub struct ChangesetEntryResponse {
    pub artifact_id: Uuid,
    pub artifact_revision_id: Uuid,
    pub artifact_key: String,
    pub revision_number: i32,
    pub change_type: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ChangesetResponse {
    pub id: Uuid,
    pub project_id: Uuid,
    pub sequence: i32,
    pub message: String,
    pub parent_changeset_id: Option<Uuid>,
    pub manifest_hash: String,
    pub added: i64,
    pub modified: i64,
    pub unchanged: i64,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
    pub entries: Vec<ChangesetEntryResponse>,
}

#[derive(Debug, Serialize)]
pub struct ChangesetListResponse {
    pub items: Vec<ChangesetResponse>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CreateBaselineRequest {
    pub name: String,
    pub changeset_id: Option<Uuid>,
    pub supersedes_baseline_id: Option<Uuid>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct BaselineResponse {
    pub id: Uuid,
    pub project_id: Uuid,
    pub sequence: i32,
    pub name: String,
    pub changeset_id: Option<Uuid>,
    pub supersedes_baseline_id: Option<Uuid>,
    pub artifact_count: i64,
    pub relationship_count: i64,
    pub manifest_hash: String,
    pub signature: String,
    pub signing_algorithm: String,
    pub signing_key_id: String,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct BaselineListResponse {
    pub items: Vec<BaselineResponse>,
}

#[derive(Debug, Deserialize)]
pub struct BaselineComparisonQuery {
    pub from_baseline_id: Uuid,
    pub to_baseline_id: Uuid,
}

#[derive(Debug, Serialize)]
pub struct BaselineComparisonResponse {
    pub from_baseline_id: Uuid,
    pub to_baseline_id: Uuid,
    pub artifacts_added: Vec<String>,
    pub artifacts_modified: Vec<String>,
    pub artifacts_removed: Vec<String>,
    pub relationships_changed: i64,
}

#[derive(Debug, Serialize)]
pub struct EvidenceExportResponse {
    pub baseline_id: Uuid,
    pub project_id: Uuid,
    pub schema_version: &'static str,
    pub manifest: Value,
    pub manifest_hash: String,
    pub signature: String,
    pub signing_algorithm: String,
    pub signing_key_id: String,
    pub signature_valid: bool,
}

#[derive(Debug, FromRow)]
struct ArtifactSnapshot {
    artifact_id: Uuid,
    artifact_revision_id: Uuid,
    artifact_key: String,
    revision_number: i32,
}

#[derive(Debug, FromRow)]
struct RelationshipSnapshot {
    relationship_id: Uuid,
    relationship_revision_id: Uuid,
    relationship_type_key: String,
    version: i32,
    source_artifact_id: Uuid,
    source_revision_id: Uuid,
    target_artifact_id: Uuid,
    target_revision_id: Uuid,
    suspect: bool,
}

#[derive(Debug, FromRow)]
struct ChangesetRecord {
    id: Uuid,
    project_id: Uuid,
    sequence: i32,
    message: String,
    parent_changeset_id: Option<Uuid>,
    manifest_hash: String,
    created_by: String,
    created_at: DateTime<Utc>,
}

#[derive(Debug, FromRow)]
struct BaselineRecord {
    id: Uuid,
    project_id: Uuid,
    sequence: i32,
    name: String,
    changeset_id: Option<Uuid>,
    supersedes_baseline_id: Option<Uuid>,
    manifest: Value,
    manifest_hash: String,
    signature: String,
    signing_algorithm: String,
    signing_key_id: String,
    created_by: String,
    created_at: DateTime<Utc>,
}

#[derive(Debug, FromRow)]
struct StoredCommand {
    request_fingerprint: String,
    response_payload: Value,
}

#[derive(Serialize)]
struct ChangesetManifest<'a> {
    schema_version: &'static str,
    project_id: Uuid,
    parent_changeset_id: Option<Uuid>,
    artifacts: &'a [ArtifactManifestItem],
}

#[derive(Clone, Serialize)]
struct ArtifactManifestItem {
    artifact_id: Uuid,
    key: String,
    revision_id: Uuid,
    revision: i32,
}

#[derive(Serialize)]
struct BaselineManifest<'a> {
    schema_version: &'static str,
    project_id: Uuid,
    policy_version: &'static str,
    changeset_id: Option<Uuid>,
    supersedes_baseline_id: Option<Uuid>,
    artifacts: &'a [ArtifactManifestItem],
    relationships: &'a [RelationshipManifestItem],
}

#[derive(Serialize)]
struct RelationshipManifestItem {
    relationship_id: Uuid,
    relationship_type: String,
    relationship_revision_id: Uuid,
    version: i32,
    source_artifact_id: Uuid,
    source_revision_id: Uuid,
    target_artifact_id: Uuid,
    target_revision_id: Uuid,
    suspect: bool,
}

pub async fn get_trace_summary(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
) -> Result<Json<TraceSummaryResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Read).await?;
    let rows = load_trace_matrix(&state.db, &principal, project_id).await?;
    let edges = load_trace_edges(&state.db, &principal, project_id).await?;
    Ok(Json(trace_summary(&rows, &edges)))
}

pub async fn get_trace_matrix(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
) -> Result<Json<TraceMatrixResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Read).await?;
    let items = load_trace_matrix(&state.db, &principal, project_id).await?;
    Ok(Json(TraceMatrixResponse { items }))
}

pub async fn get_trace_graph(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
) -> Result<Json<TraceGraphResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Read).await?;
    let nodes = load_trace_matrix(&state.db, &principal, project_id).await?;
    let edges = load_trace_edges(&state.db, &principal, project_id).await?;
    let summary = trace_summary(&nodes, &edges);
    Ok(Json(TraceGraphResponse {
        nodes,
        edges,
        summary,
    }))
}

pub async fn create_changeset(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<CreateChangesetRequest>,
) -> Result<(StatusCode, Json<ChangesetResponse>), ApiError> {
    authorize_project(&state, &principal, project_id, Action::Write).await?;
    let message = request.message.trim();
    if message.is_empty() || message.chars().count() > 2_000 {
        return Err(ApiError::bad_request(
            "changeset message must contain 1-2000 characters",
        ));
    }
    let idempotency_key = parse_idempotency_key(&headers)?;
    let fingerprint = serde_json::to_string(&(project_id, message))
        .map_err(|_| ApiError::internal("Could not fingerprint changeset command"))?;
    if let Some(stored) = find_command(
        &state.db,
        &principal,
        CREATE_CHANGESET_COMMAND,
        idempotency_key,
    )
    .await?
    {
        if stored.request_fingerprint != fingerprint {
            return Err(ApiError::conflict(
                "Idempotency key was already used with a different changeset request",
            ));
        }
        let response = serde_json::from_value(stored.response_payload)
            .map_err(|_| ApiError::internal("Stored changeset response is invalid"))?;
        return Ok((StatusCode::OK, Json(response)));
    }

    let mut transaction = state.db.begin().await.map_err(database_error)?;
    lock_project(&mut transaction, &principal, project_id).await?;
    if let Some(stored) = find_command_tx(
        &mut transaction,
        &principal,
        CREATE_CHANGESET_COMMAND,
        idempotency_key,
    )
    .await?
    {
        if stored.request_fingerprint != fingerprint {
            return Err(ApiError::conflict(
                "Idempotency key was already used with a different changeset request",
            ));
        }
        let response = serde_json::from_value(stored.response_payload)
            .map_err(|_| ApiError::internal("Stored changeset response is invalid"))?;
        return Ok((StatusCode::OK, Json(response)));
    }
    let parent = sqlx::query_as::<_, ChangesetRecord>(
        r#"
        SELECT id, project_id, sequence, message, parent_changeset_id,
               manifest_hash, created_by, created_at
        FROM changesets
        WHERE organization_id = $1 AND project_id = $2
        ORDER BY sequence DESC
        LIMIT 1
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?;
    let parent_entries = if let Some(parent) = &parent {
        load_changeset_entries_tx(&mut transaction, &principal, project_id, parent.id).await?
    } else {
        Vec::new()
    };
    let previous: HashMap<Uuid, Uuid> = parent_entries
        .into_iter()
        .map(|entry| (entry.artifact_id, entry.artifact_revision_id))
        .collect();
    let artifacts = load_artifact_snapshot_tx(&mut transaction, &principal, project_id).await?;
    let manifest_items = artifact_manifest_items(&artifacts);
    let (manifest, manifest_hash) = canonical_manifest(&ChangesetManifest {
        schema_version: EVIDENCE_SCHEMA_VERSION,
        project_id,
        parent_changeset_id: parent.as_ref().map(|item| item.id),
        artifacts: &manifest_items,
    })?;
    let entries: Vec<ChangesetEntryResponse> = artifacts
        .iter()
        .map(|artifact| {
            let change_type = match previous.get(&artifact.artifact_id) {
                None => "added",
                Some(revision) if *revision != artifact.artifact_revision_id => "modified",
                Some(_) => "unchanged",
            };
            ChangesetEntryResponse {
                artifact_id: artifact.artifact_id,
                artifact_revision_id: artifact.artifact_revision_id,
                artifact_key: artifact.artifact_key.clone(),
                revision_number: artifact.revision_number,
                change_type: change_type.to_owned(),
            }
        })
        .collect();
    let changeset_id = Uuid::new_v4();
    let sequence = parent.as_ref().map_or(1, |item| item.sequence + 1);
    let record = sqlx::query_as::<_, ChangesetRecord>(
        r#"
        INSERT INTO changesets (
            id, organization_id, project_id, sequence, message,
            parent_changeset_id, manifest, manifest_hash, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id, project_id, sequence, message, parent_changeset_id,
                  manifest_hash, created_by, created_at
        "#,
    )
    .bind(changeset_id)
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(sequence)
    .bind(message)
    .bind(parent.as_ref().map(|item| item.id))
    .bind(manifest)
    .bind(&manifest_hash)
    .bind(&principal.subject)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?;
    insert_changeset_entries(
        &mut transaction,
        &principal,
        project_id,
        changeset_id,
        &entries,
    )
    .await?;
    insert_audit(
        &mut transaction,
        &principal,
        project_id,
        "changeset.created",
        "changeset",
        changeset_id,
        serde_json::json!({
            "sequence": sequence,
            "parent_changeset_id": parent.as_ref().map(|item| item.id),
            "manifest_hash": manifest_hash,
            "message": message
        }),
    )
    .await?;
    let response = changeset_response(record, entries);
    store_command(
        &mut transaction,
        &principal,
        CREATE_CHANGESET_COMMAND,
        idempotency_key,
        &fingerprint,
        "changeset",
        changeset_id,
        sequence,
        &response,
    )
    .await?;
    transaction.commit().await.map_err(database_error)?;
    Ok((StatusCode::CREATED, Json(response)))
}

pub async fn list_changesets(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
) -> Result<Json<ChangesetListResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Read).await?;
    let records = load_changesets(&state.db, &principal, project_id).await?;
    let mut items = Vec::with_capacity(records.len());
    for record in records {
        let entries = load_changeset_entries(&state.db, &principal, project_id, record.id).await?;
        items.push(changeset_response(record, entries));
    }
    Ok(Json(ChangesetListResponse { items }))
}

pub async fn get_changeset(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path((project_id, changeset_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<ChangesetResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Read).await?;
    let record = fetch_changeset(&state.db, &principal, project_id, changeset_id).await?;
    let entries = load_changeset_entries(&state.db, &principal, project_id, changeset_id).await?;
    Ok(Json(changeset_response(record, entries)))
}

pub async fn create_baseline(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<CreateBaselineRequest>,
) -> Result<(StatusCode, Json<BaselineResponse>), ApiError> {
    authorize_project(&state, &principal, project_id, Action::Review).await?;
    let name = request.name.trim();
    if name.is_empty() || name.chars().count() > 200 {
        return Err(ApiError::bad_request(
            "baseline name must contain 1-200 characters",
        ));
    }
    let idempotency_key = parse_idempotency_key(&headers)?;
    let fingerprint = serde_json::to_string(&(
        project_id,
        name,
        request.changeset_id,
        request.supersedes_baseline_id,
    ))
    .map_err(|_| ApiError::internal("Could not fingerprint baseline command"))?;
    if let Some(stored) = find_command(
        &state.db,
        &principal,
        CREATE_BASELINE_COMMAND,
        idempotency_key,
    )
    .await?
    {
        if stored.request_fingerprint != fingerprint {
            return Err(ApiError::conflict(
                "Idempotency key was already used with a different baseline request",
            ));
        }
        let response = serde_json::from_value(stored.response_payload)
            .map_err(|_| ApiError::internal("Stored baseline response is invalid"))?;
        return Ok((StatusCode::OK, Json(response)));
    }

    let mut transaction = state.db.begin().await.map_err(database_error)?;
    lock_project(&mut transaction, &principal, project_id).await?;
    if let Some(stored) = find_command_tx(
        &mut transaction,
        &principal,
        CREATE_BASELINE_COMMAND,
        idempotency_key,
    )
    .await?
    {
        if stored.request_fingerprint != fingerprint {
            return Err(ApiError::conflict(
                "Idempotency key was already used with a different baseline request",
            ));
        }
        let response = serde_json::from_value(stored.response_payload)
            .map_err(|_| ApiError::internal("Stored baseline response is invalid"))?;
        return Ok((StatusCode::OK, Json(response)));
    }
    validate_optional_changeset(
        &mut transaction,
        &principal,
        project_id,
        request.changeset_id,
    )
    .await?;
    validate_optional_baseline(
        &mut transaction,
        &principal,
        project_id,
        request.supersedes_baseline_id,
    )
    .await?;
    let artifacts = load_artifact_snapshot_tx(&mut transaction, &principal, project_id).await?;
    if let Some(changeset_id) = request.changeset_id {
        let entries =
            load_changeset_entries_tx(&mut transaction, &principal, project_id, changeset_id)
                .await?;
        let snapshot_matches = entries.len() == artifacts.len()
            && entries.iter().all(|entry| {
                artifacts.iter().any(|artifact| {
                    artifact.artifact_id == entry.artifact_id
                        && artifact.artifact_revision_id == entry.artifact_revision_id
                })
            });
        if !snapshot_matches {
            return Err(ApiError::conflict(
                "Project state has advanced beyond the selected changeset; create a new changeset before baselining",
            ));
        }
    }
    let relationships =
        load_relationship_snapshot_tx(&mut transaction, &principal, project_id).await?;
    let artifact_items = artifact_manifest_items(&artifacts);
    let relationship_items = relationships
        .iter()
        .map(|item| RelationshipManifestItem {
            relationship_id: item.relationship_id,
            relationship_type: item.relationship_type_key.clone(),
            relationship_revision_id: item.relationship_revision_id,
            version: item.version,
            source_artifact_id: item.source_artifact_id,
            source_revision_id: item.source_revision_id,
            target_artifact_id: item.target_artifact_id,
            target_revision_id: item.target_revision_id,
            suspect: item.suspect,
        })
        .collect::<Vec<_>>();
    let (manifest, manifest_hash) = canonical_manifest(&BaselineManifest {
        schema_version: EVIDENCE_SCHEMA_VERSION,
        project_id,
        policy_version: POLICY_VERSION,
        changeset_id: request.changeset_id,
        supersedes_baseline_id: request.supersedes_baseline_id,
        artifacts: &artifact_items,
        relationships: &relationship_items,
    })?;
    let signature = state.evidence_signer.sign(&manifest_hash);
    let sequence = sqlx::query_scalar::<_, Option<i32>>(
        r#"
        SELECT max(sequence)
        FROM baselines
        WHERE organization_id = $1 AND project_id = $2
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?
    .unwrap_or(0)
        + 1;
    let baseline_id = Uuid::new_v4();
    let record = sqlx::query_as::<_, BaselineRecord>(
        r#"
        INSERT INTO baselines (
            id, organization_id, project_id, sequence, name, changeset_id,
            supersedes_baseline_id, manifest, manifest_hash, signature,
            signing_algorithm, signing_key_id, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING id, project_id, sequence, name, changeset_id,
                  supersedes_baseline_id, manifest, manifest_hash, signature,
                  signing_algorithm, signing_key_id, created_by, created_at
        "#,
    )
    .bind(baseline_id)
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(sequence)
    .bind(name)
    .bind(request.changeset_id)
    .bind(request.supersedes_baseline_id)
    .bind(manifest)
    .bind(&manifest_hash)
    .bind(&signature)
    .bind(EvidenceSigner::ALGORITHM)
    .bind(state.evidence_signer.key_id())
    .bind(&principal.subject)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?;
    insert_baseline_artifacts(
        &mut transaction,
        &principal,
        project_id,
        baseline_id,
        &artifacts,
    )
    .await?;
    insert_baseline_relationships(
        &mut transaction,
        &principal,
        project_id,
        baseline_id,
        &relationships,
    )
    .await?;
    insert_audit(
        &mut transaction,
        &principal,
        project_id,
        "baseline.created",
        "baseline",
        baseline_id,
        serde_json::json!({
            "sequence": sequence,
            "manifest_hash": manifest_hash,
            "signature": signature,
            "signing_algorithm": EvidenceSigner::ALGORITHM,
            "signing_key_id": state.evidence_signer.key_id()
        }),
    )
    .await?;
    let response = baseline_response(record, artifacts.len() as i64, relationships.len() as i64);
    store_command(
        &mut transaction,
        &principal,
        CREATE_BASELINE_COMMAND,
        idempotency_key,
        &fingerprint,
        "baseline",
        baseline_id,
        sequence,
        &response,
    )
    .await?;
    transaction.commit().await.map_err(database_error)?;
    Ok((StatusCode::CREATED, Json(response)))
}

pub async fn list_baselines(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
) -> Result<Json<BaselineListResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Read).await?;
    let records = load_baselines(&state.db, &principal, project_id).await?;
    let mut items = Vec::with_capacity(records.len());
    for record in records {
        let (artifact_count, relationship_count) =
            baseline_counts(&state.db, &principal, project_id, record.id).await?;
        items.push(baseline_response(
            record,
            artifact_count,
            relationship_count,
        ));
    }
    Ok(Json(BaselineListResponse { items }))
}

pub async fn compare_baselines(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path(project_id): Path<Uuid>,
    Query(query): Query<BaselineComparisonQuery>,
) -> Result<Json<BaselineComparisonResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Read).await?;
    fetch_baseline(&state.db, &principal, project_id, query.from_baseline_id).await?;
    fetch_baseline(&state.db, &principal, project_id, query.to_baseline_id).await?;
    let from_artifacts =
        load_baseline_artifacts(&state.db, &principal, project_id, query.from_baseline_id).await?;
    let to_artifacts =
        load_baseline_artifacts(&state.db, &principal, project_id, query.to_baseline_id).await?;
    let from_map: HashMap<Uuid, &ArtifactSnapshot> = from_artifacts
        .iter()
        .map(|item| (item.artifact_id, item))
        .collect();
    let to_map: HashMap<Uuid, &ArtifactSnapshot> = to_artifacts
        .iter()
        .map(|item| (item.artifact_id, item))
        .collect();
    let mut added = Vec::new();
    let mut modified = Vec::new();
    let mut removed = Vec::new();
    for item in &to_artifacts {
        match from_map.get(&item.artifact_id) {
            None => added.push(item.artifact_key.clone()),
            Some(previous) if previous.artifact_revision_id != item.artifact_revision_id => {
                modified.push(item.artifact_key.clone());
            }
            Some(_) => {}
        }
    }
    for item in &from_artifacts {
        if !to_map.contains_key(&item.artifact_id) {
            removed.push(item.artifact_key.clone());
        }
    }
    let from_relationships =
        load_baseline_relationship_map(&state.db, &principal, project_id, query.from_baseline_id)
            .await?;
    let to_relationships =
        load_baseline_relationship_map(&state.db, &principal, project_id, query.to_baseline_id)
            .await?;
    let relationship_ids = from_relationships
        .keys()
        .chain(to_relationships.keys())
        .copied()
        .collect::<std::collections::HashSet<_>>();
    let relationships_changed = relationship_ids
        .iter()
        .filter(|id| from_relationships.get(id) != to_relationships.get(id))
        .count() as i64;
    Ok(Json(BaselineComparisonResponse {
        from_baseline_id: query.from_baseline_id,
        to_baseline_id: query.to_baseline_id,
        artifacts_added: added,
        artifacts_modified: modified,
        artifacts_removed: removed,
        relationships_changed,
    }))
}

pub async fn export_evidence(
    State(state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
    Path((project_id, baseline_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<EvidenceExportResponse>, ApiError> {
    authorize_project(&state, &principal, project_id, Action::Read).await?;
    let baseline = fetch_baseline(&state.db, &principal, project_id, baseline_id).await?;
    let (_, calculated_hash) = canonical_manifest(&baseline.manifest)?;
    if calculated_hash != baseline.manifest_hash {
        return Err(ApiError::internal(
            "Baseline manifest hash does not match stored evidence",
        ));
    }
    let signature_valid = state.evidence_signer.verify_with_key_id(
        &baseline.signing_key_id,
        &baseline.manifest_hash,
        &baseline.signature,
    );
    Ok(Json(EvidenceExportResponse {
        baseline_id,
        project_id,
        schema_version: EVIDENCE_SCHEMA_VERSION,
        manifest: baseline.manifest,
        manifest_hash: baseline.manifest_hash,
        signature: baseline.signature,
        signing_algorithm: baseline.signing_algorithm,
        signing_key_id: baseline.signing_key_id,
        signature_valid,
    }))
}

async fn load_trace_matrix(
    pool: &PgPool,
    principal: &Principal,
    project_id: Uuid,
) -> Result<Vec<TraceMatrixRow>, ApiError> {
    sqlx::query_as::<_, TraceMatrixRow>(
        r#"
        SELECT a.id AS artifact_id, a.key, a.title,
               a.current_revision_number AS revision,
               (SELECT count(*) FROM relationships r
                WHERE r.organization_id = a.organization_id
                  AND r.project_id = a.project_id
                  AND r.target_artifact_id = a.id) AS upstream_count,
               (SELECT count(*) FROM relationships r
                WHERE r.organization_id = a.organization_id
                  AND r.project_id = a.project_id
                  AND r.source_artifact_id = a.id) AS downstream_count,
               (SELECT count(*)
                FROM relationships r
                JOIN relationship_revisions rr
                  ON rr.organization_id = r.organization_id
                 AND rr.project_id = r.project_id
                 AND rr.relationship_id = r.id
                 AND rr.id = r.current_revision_id
                WHERE r.organization_id = a.organization_id
                  AND r.project_id = a.project_id
                  AND (r.source_artifact_id = a.id OR r.target_artifact_id = a.id)
                  AND rr.suspect) AS suspect_count,
               NOT EXISTS (
                 SELECT 1 FROM relationships r
                 WHERE r.organization_id = a.organization_id
                   AND r.project_id = a.project_id
                   AND (r.source_artifact_id = a.id OR r.target_artifact_id = a.id)
               ) AS gap
        FROM artifacts a
        JOIN artifact_types t
          ON t.organization_id = a.organization_id
         AND t.project_id = a.project_id
         AND t.id = a.artifact_type_id
        WHERE a.organization_id = $1 AND a.project_id = $2
          AND t.key = 'REQUIREMENT'
        ORDER BY a.key, a.id
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .fetch_all(pool)
    .await
    .map_err(database_error)
}

async fn load_trace_edges(
    pool: &PgPool,
    principal: &Principal,
    project_id: Uuid,
) -> Result<Vec<TraceEdge>, ApiError> {
    sqlx::query_as::<_, TraceEdge>(
        r#"
        SELECT r.id AS relationship_id, rt.key AS relationship_type_key,
               r.source_artifact_id, r.target_artifact_id,
               rr.version, rr.suspect
        FROM relationships r
        JOIN relationship_types rt
          ON rt.organization_id = r.organization_id
         AND rt.project_id = r.project_id
         AND rt.id = r.relationship_type_id
        JOIN relationship_revisions rr
          ON rr.organization_id = r.organization_id
         AND rr.project_id = r.project_id
         AND rr.relationship_id = r.id
         AND rr.id = r.current_revision_id
        WHERE r.organization_id = $1 AND r.project_id = $2
        ORDER BY r.id
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .fetch_all(pool)
    .await
    .map_err(database_error)
}

fn trace_summary(rows: &[TraceMatrixRow], edges: &[TraceEdge]) -> TraceSummaryResponse {
    let total_artifacts = rows.len() as i64;
    let orphan_artifacts = rows.iter().filter(|row| row.gap).count() as i64;
    let covered_artifacts = total_artifacts - orphan_artifacts;
    let coverage_percent = if total_artifacts == 0 {
        0.0
    } else {
        (covered_artifacts as f64 / total_artifacts as f64 * 10_000.0).round() / 100.0
    };
    TraceSummaryResponse {
        total_artifacts,
        covered_artifacts,
        orphan_artifacts,
        relationships: edges.len() as i64,
        suspect_relationships: edges.iter().filter(|edge| edge.suspect).count() as i64,
        coverage_percent,
    }
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

async fn load_artifact_snapshot_tx(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    project_id: Uuid,
) -> Result<Vec<ArtifactSnapshot>, ApiError> {
    sqlx::query_as::<_, ArtifactSnapshot>(
        r#"
        SELECT id AS artifact_id, current_revision_id AS artifact_revision_id,
               key AS artifact_key, current_revision_number AS revision_number
        FROM artifacts
        WHERE organization_id = $1 AND project_id = $2
        ORDER BY key, id
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .fetch_all(&mut **transaction)
    .await
    .map_err(database_error)
}

async fn load_relationship_snapshot_tx(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    project_id: Uuid,
) -> Result<Vec<RelationshipSnapshot>, ApiError> {
    sqlx::query_as::<_, RelationshipSnapshot>(
        r#"
        SELECT r.id AS relationship_id,
               r.current_revision_id AS relationship_revision_id,
               rt.key AS relationship_type_key, rr.version,
               rr.source_artifact_id, rr.source_revision_id,
               rr.target_artifact_id, rr.target_revision_id, rr.suspect
        FROM relationships r
        JOIN relationship_types rt
          ON rt.organization_id = r.organization_id
         AND rt.project_id = r.project_id
         AND rt.id = r.relationship_type_id
        JOIN relationship_revisions rr
          ON rr.organization_id = r.organization_id
         AND rr.project_id = r.project_id
         AND rr.relationship_id = r.id
         AND rr.id = r.current_revision_id
        WHERE r.organization_id = $1 AND r.project_id = $2
        ORDER BY r.id
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .fetch_all(&mut **transaction)
    .await
    .map_err(database_error)
}

fn artifact_manifest_items(artifacts: &[ArtifactSnapshot]) -> Vec<ArtifactManifestItem> {
    artifacts
        .iter()
        .map(|item| ArtifactManifestItem {
            artifact_id: item.artifact_id,
            key: item.artifact_key.clone(),
            revision_id: item.artifact_revision_id,
            revision: item.revision_number,
        })
        .collect()
}

fn canonical_manifest<T: Serialize>(value: &T) -> Result<(Value, String), ApiError> {
    let value = serde_json::to_value(value)
        .map_err(|_| ApiError::internal("Could not serialize evidence manifest"))?;
    let bytes = serde_json::to_vec(&value)
        .map_err(|_| ApiError::internal("Could not canonicalize evidence manifest"))?;
    let hash = hex::encode(Sha256::digest(bytes));
    Ok((value, hash))
}

async fn insert_changeset_entries(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    project_id: Uuid,
    changeset_id: Uuid,
    entries: &[ChangesetEntryResponse],
) -> Result<(), ApiError> {
    for entry in entries {
        sqlx::query(
            r#"
            INSERT INTO changeset_entries (
                organization_id, project_id, changeset_id, artifact_id,
                artifact_revision_id, artifact_key, revision_number, change_type
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            "#,
        )
        .bind(principal.organization_id)
        .bind(project_id)
        .bind(changeset_id)
        .bind(entry.artifact_id)
        .bind(entry.artifact_revision_id)
        .bind(&entry.artifact_key)
        .bind(entry.revision_number)
        .bind(&entry.change_type)
        .execute(&mut **transaction)
        .await
        .map_err(database_error)?;
    }
    Ok(())
}

async fn load_changesets(
    pool: &PgPool,
    principal: &Principal,
    project_id: Uuid,
) -> Result<Vec<ChangesetRecord>, ApiError> {
    sqlx::query_as::<_, ChangesetRecord>(
        r#"
        SELECT id, project_id, sequence, message, parent_changeset_id,
               manifest_hash, created_by, created_at
        FROM changesets
        WHERE organization_id = $1 AND project_id = $2
        ORDER BY sequence DESC
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .fetch_all(pool)
    .await
    .map_err(database_error)
}

async fn fetch_changeset(
    pool: &PgPool,
    principal: &Principal,
    project_id: Uuid,
    changeset_id: Uuid,
) -> Result<ChangesetRecord, ApiError> {
    sqlx::query_as::<_, ChangesetRecord>(
        r#"
        SELECT id, project_id, sequence, message, parent_changeset_id,
               manifest_hash, created_by, created_at
        FROM changesets
        WHERE organization_id = $1 AND project_id = $2 AND id = $3
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(changeset_id)
    .fetch_optional(pool)
    .await
    .map_err(database_error)?
    .ok_or_else(|| ApiError::not_found("Changeset does not exist"))
}

async fn load_changeset_entries(
    pool: &PgPool,
    principal: &Principal,
    project_id: Uuid,
    changeset_id: Uuid,
) -> Result<Vec<ChangesetEntryResponse>, ApiError> {
    sqlx::query_as::<_, ChangesetEntryResponse>(
        r#"
        SELECT artifact_id, artifact_revision_id, artifact_key,
               revision_number, change_type
        FROM changeset_entries
        WHERE organization_id = $1 AND project_id = $2 AND changeset_id = $3
        ORDER BY artifact_key, artifact_id
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(changeset_id)
    .fetch_all(pool)
    .await
    .map_err(database_error)
}

async fn load_changeset_entries_tx(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    project_id: Uuid,
    changeset_id: Uuid,
) -> Result<Vec<ChangesetEntryResponse>, ApiError> {
    sqlx::query_as::<_, ChangesetEntryResponse>(
        r#"
        SELECT artifact_id, artifact_revision_id, artifact_key,
               revision_number, change_type
        FROM changeset_entries
        WHERE organization_id = $1 AND project_id = $2 AND changeset_id = $3
        ORDER BY artifact_key, artifact_id
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(changeset_id)
    .fetch_all(&mut **transaction)
    .await
    .map_err(database_error)
}

fn changeset_response(
    record: ChangesetRecord,
    entries: Vec<ChangesetEntryResponse>,
) -> ChangesetResponse {
    ChangesetResponse {
        id: record.id,
        project_id: record.project_id,
        sequence: record.sequence,
        message: record.message,
        parent_changeset_id: record.parent_changeset_id,
        manifest_hash: record.manifest_hash,
        added: entries
            .iter()
            .filter(|entry| entry.change_type == "added")
            .count() as i64,
        modified: entries
            .iter()
            .filter(|entry| entry.change_type == "modified")
            .count() as i64,
        unchanged: entries
            .iter()
            .filter(|entry| entry.change_type == "unchanged")
            .count() as i64,
        created_by: record.created_by,
        created_at: record.created_at,
        entries,
    }
}

async fn validate_optional_changeset(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    project_id: Uuid,
    changeset_id: Option<Uuid>,
) -> Result<(), ApiError> {
    let Some(changeset_id) = changeset_id else {
        return Ok(());
    };
    let exists = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM changesets
            WHERE organization_id = $1 AND project_id = $2 AND id = $3
        )
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(changeset_id)
    .fetch_one(&mut **transaction)
    .await
    .map_err(database_error)?;
    if !exists {
        return Err(ApiError::not_found("Changeset does not exist"));
    }
    Ok(())
}

async fn validate_optional_baseline(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    project_id: Uuid,
    baseline_id: Option<Uuid>,
) -> Result<(), ApiError> {
    let Some(baseline_id) = baseline_id else {
        return Ok(());
    };
    let exists = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM baselines
            WHERE organization_id = $1 AND project_id = $2 AND id = $3
        )
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(baseline_id)
    .fetch_one(&mut **transaction)
    .await
    .map_err(database_error)?;
    if !exists {
        return Err(ApiError::not_found("Superseded baseline does not exist"));
    }
    Ok(())
}

async fn insert_baseline_artifacts(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    project_id: Uuid,
    baseline_id: Uuid,
    artifacts: &[ArtifactSnapshot],
) -> Result<(), ApiError> {
    for artifact in artifacts {
        sqlx::query(
            r#"
            INSERT INTO baseline_artifacts (
                organization_id, project_id, baseline_id, artifact_id,
                artifact_revision_id, artifact_key, revision_number
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            "#,
        )
        .bind(principal.organization_id)
        .bind(project_id)
        .bind(baseline_id)
        .bind(artifact.artifact_id)
        .bind(artifact.artifact_revision_id)
        .bind(&artifact.artifact_key)
        .bind(artifact.revision_number)
        .execute(&mut **transaction)
        .await
        .map_err(database_error)?;
    }
    Ok(())
}

async fn insert_baseline_relationships(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    project_id: Uuid,
    baseline_id: Uuid,
    relationships: &[RelationshipSnapshot],
) -> Result<(), ApiError> {
    for relationship in relationships {
        sqlx::query(
            r#"
            INSERT INTO baseline_relationships (
                organization_id, project_id, baseline_id, relationship_id,
                relationship_revision_id, relationship_type_key, version,
                source_artifact_id, source_revision_id,
                target_artifact_id, target_revision_id, suspect
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            "#,
        )
        .bind(principal.organization_id)
        .bind(project_id)
        .bind(baseline_id)
        .bind(relationship.relationship_id)
        .bind(relationship.relationship_revision_id)
        .bind(&relationship.relationship_type_key)
        .bind(relationship.version)
        .bind(relationship.source_artifact_id)
        .bind(relationship.source_revision_id)
        .bind(relationship.target_artifact_id)
        .bind(relationship.target_revision_id)
        .bind(relationship.suspect)
        .execute(&mut **transaction)
        .await
        .map_err(database_error)?;
    }
    Ok(())
}

async fn load_baselines(
    pool: &PgPool,
    principal: &Principal,
    project_id: Uuid,
) -> Result<Vec<BaselineRecord>, ApiError> {
    sqlx::query_as::<_, BaselineRecord>(
        r#"
        SELECT id, project_id, sequence, name, changeset_id,
               supersedes_baseline_id, manifest, manifest_hash, signature,
               signing_algorithm, signing_key_id, created_by, created_at
        FROM baselines
        WHERE organization_id = $1 AND project_id = $2
        ORDER BY sequence DESC
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .fetch_all(pool)
    .await
    .map_err(database_error)
}

async fn fetch_baseline(
    pool: &PgPool,
    principal: &Principal,
    project_id: Uuid,
    baseline_id: Uuid,
) -> Result<BaselineRecord, ApiError> {
    sqlx::query_as::<_, BaselineRecord>(
        r#"
        SELECT id, project_id, sequence, name, changeset_id,
               supersedes_baseline_id, manifest, manifest_hash, signature,
               signing_algorithm, signing_key_id, created_by, created_at
        FROM baselines
        WHERE organization_id = $1 AND project_id = $2 AND id = $3
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(baseline_id)
    .fetch_optional(pool)
    .await
    .map_err(database_error)?
    .ok_or_else(|| ApiError::not_found("Baseline does not exist"))
}

async fn baseline_counts(
    pool: &PgPool,
    principal: &Principal,
    project_id: Uuid,
    baseline_id: Uuid,
) -> Result<(i64, i64), ApiError> {
    let artifacts = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT count(*) FROM baseline_artifacts
        WHERE organization_id = $1 AND project_id = $2 AND baseline_id = $3
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(baseline_id)
    .fetch_one(pool)
    .await
    .map_err(database_error)?;
    let relationships = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT count(*) FROM baseline_relationships
        WHERE organization_id = $1 AND project_id = $2 AND baseline_id = $3
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(baseline_id)
    .fetch_one(pool)
    .await
    .map_err(database_error)?;
    Ok((artifacts, relationships))
}

fn baseline_response(
    record: BaselineRecord,
    artifact_count: i64,
    relationship_count: i64,
) -> BaselineResponse {
    BaselineResponse {
        id: record.id,
        project_id: record.project_id,
        sequence: record.sequence,
        name: record.name,
        changeset_id: record.changeset_id,
        supersedes_baseline_id: record.supersedes_baseline_id,
        artifact_count,
        relationship_count,
        manifest_hash: record.manifest_hash,
        signature: record.signature,
        signing_algorithm: record.signing_algorithm,
        signing_key_id: record.signing_key_id,
        created_by: record.created_by,
        created_at: record.created_at,
    }
}

async fn load_baseline_artifacts(
    pool: &PgPool,
    principal: &Principal,
    project_id: Uuid,
    baseline_id: Uuid,
) -> Result<Vec<ArtifactSnapshot>, ApiError> {
    sqlx::query_as::<_, ArtifactSnapshot>(
        r#"
        SELECT artifact_id, artifact_revision_id, artifact_key, revision_number
        FROM baseline_artifacts
        WHERE organization_id = $1 AND project_id = $2 AND baseline_id = $3
        ORDER BY artifact_key, artifact_id
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(baseline_id)
    .fetch_all(pool)
    .await
    .map_err(database_error)
}

async fn load_baseline_relationship_map(
    pool: &PgPool,
    principal: &Principal,
    project_id: Uuid,
    baseline_id: Uuid,
) -> Result<HashMap<Uuid, Uuid>, ApiError> {
    let rows = sqlx::query_as::<_, (Uuid, Uuid)>(
        r#"
        SELECT relationship_id, relationship_revision_id
        FROM baseline_relationships
        WHERE organization_id = $1 AND project_id = $2 AND baseline_id = $3
        "#,
    )
    .bind(principal.organization_id)
    .bind(project_id)
    .bind(baseline_id)
    .fetch_all(pool)
    .await
    .map_err(database_error)?;
    Ok(rows.into_iter().collect())
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

async fn find_command_tx(
    transaction: &mut Transaction<'_, Postgres>,
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
    .fetch_optional(&mut **transaction)
    .await
    .map_err(database_error)
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
        .map_err(|_| ApiError::internal("Could not store controlled command response"))?;
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

fn database_error(error: sqlx::Error) -> ApiError {
    tracing::warn!(%error, "controlled change database operation failed");
    ApiError::unavailable("Controlled change database operation failed")
}

#[cfg(test)]
mod tests {
    use super::{ArtifactManifestItem, ChangesetManifest, canonical_manifest, trace_summary};
    use uuid::Uuid;

    #[test]
    fn canonical_manifests_are_stable() {
        let project_id = Uuid::new_v4();
        let items = vec![ArtifactManifestItem {
            artifact_id: Uuid::nil(),
            key: "REQ-1".to_owned(),
            revision_id: Uuid::nil(),
            revision: 1,
        }];
        let manifest = ChangesetManifest {
            schema_version: "openrm-evidence-v1",
            project_id,
            parent_changeset_id: None,
            artifacts: &items,
        };
        let (_, first) = canonical_manifest(&manifest).unwrap();
        let (_, second) = canonical_manifest(&manifest).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
    }

    #[test]
    fn empty_trace_has_zero_coverage() {
        let summary = trace_summary(&[], &[]);
        assert_eq!(summary.coverage_percent, 0.0);
    }
}
