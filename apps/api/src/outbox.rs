use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use uuid::Uuid;

const SOURCE_REVISED_TOPIC: &str = "relationship.source-revised";

#[derive(Debug, FromRow)]
struct OutboxMessage {
    id: Uuid,
    organization_id: Uuid,
    topic: String,
    payload: Value,
}

#[derive(Debug, Deserialize)]
struct SourceRevisedPayload {
    project_id: Uuid,
    source_artifact_id: Uuid,
    source_revision_id: Uuid,
    source_revision: i32,
}

#[derive(Debug, FromRow)]
struct ImpactCandidate {
    id: Uuid,
    relationship_type_id: Uuid,
    target_artifact_id: Uuid,
    target_revision_id: Uuid,
    current_version: i32,
}

pub async fn run(pool: PgPool) {
    loop {
        match process_next(&pool).await {
            Ok(true) => continue,
            Ok(false) => tokio::time::sleep(std::time::Duration::from_millis(250)).await,
            Err(error) => {
                tracing::warn!(%error, "outbox message processing failed");
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }
    }
}

async fn process_next(pool: &PgPool) -> Result<bool, sqlx::Error> {
    let mut transaction = pool.begin().await?;
    let message = sqlx::query_as::<_, OutboxMessage>(
        r#"
        SELECT id, organization_id, topic, payload
        FROM outbox_messages
        WHERE processed_at IS NULL AND available_at <= now() AND topic = $1
        ORDER BY occurred_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
        "#,
    )
    .bind(SOURCE_REVISED_TOPIC)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some(message) = message else {
        transaction.rollback().await?;
        return Ok(false);
    };

    debug_assert_eq!(message.topic, SOURCE_REVISED_TOPIC);
    let payload: SourceRevisedPayload = serde_json::from_value(message.payload.clone())
        .map_err(|error| sqlx::Error::Protocol(error.to_string()))?;
    propagate_source_revision(&mut transaction, message.organization_id, &payload).await?;

    sqlx::query(
        r#"
        UPDATE outbox_messages
        SET processed_at = now(), attempts = attempts + 1, last_error = NULL
        WHERE id = $1
        "#,
    )
    .bind(message.id)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(true)
}

async fn propagate_source_revision(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: Uuid,
    payload: &SourceRevisedPayload,
) -> Result<(), sqlx::Error> {
    let relationships = sqlx::query_as::<_, ImpactCandidate>(
        r#"
        SELECT r.id, r.relationship_type_id, r.target_artifact_id,
               target.current_revision_id AS target_revision_id,
               r.current_version
        FROM relationships r
        JOIN relationship_types rt
          ON rt.organization_id = r.organization_id
         AND rt.project_id = r.project_id
         AND rt.id = r.relationship_type_id
        JOIN relationship_revisions current_revision
          ON current_revision.organization_id = r.organization_id
         AND current_revision.project_id = r.project_id
         AND current_revision.relationship_id = r.id
         AND current_revision.id = r.current_revision_id
        JOIN artifacts target
          ON target.organization_id = r.organization_id
         AND target.project_id = r.project_id
         AND target.id = r.target_artifact_id
        WHERE r.organization_id = $1 AND r.project_id = $2
          AND r.source_artifact_id = $3
          AND rt.propagates_suspect
          AND current_revision.source_revision_id <> $4
        ORDER BY r.id
        FOR UPDATE OF r
        "#,
    )
    .bind(organization_id)
    .bind(payload.project_id)
    .bind(payload.source_artifact_id)
    .bind(payload.source_revision_id)
    .fetch_all(&mut **transaction)
    .await?;

    for relationship in relationships {
        let revision_id = Uuid::new_v4();
        let next_version = relationship.current_version + 1;
        sqlx::query(
            r#"
            INSERT INTO relationship_revisions (
                id, organization_id, project_id, relationship_id, version,
                relationship_type_id, source_artifact_id, source_revision_id,
                target_artifact_id, target_revision_id, suspect, suspect_reason, created_by
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true,
                    'source_revision_changed', 'system:relationship-impact')
            "#,
        )
        .bind(revision_id)
        .bind(organization_id)
        .bind(payload.project_id)
        .bind(relationship.id)
        .bind(next_version)
        .bind(relationship.relationship_type_id)
        .bind(payload.source_artifact_id)
        .bind(payload.source_revision_id)
        .bind(relationship.target_artifact_id)
        .bind(relationship.target_revision_id)
        .execute(&mut **transaction)
        .await?;
        sqlx::query(
            r#"
            UPDATE relationships
            SET current_revision_id = $4, current_version = $5, updated_at = now()
            WHERE organization_id = $1 AND project_id = $2 AND id = $3
            "#,
        )
        .bind(organization_id)
        .bind(payload.project_id)
        .bind(relationship.id)
        .bind(revision_id)
        .bind(next_version)
        .execute(&mut **transaction)
        .await?;
        sqlx::query(
            r#"
            INSERT INTO audit_events (
                organization_id, project_id, actor_subject, event_type,
                aggregate_type, aggregate_id, payload
            )
            VALUES ($1, $2, 'system:relationship-impact', 'relationship.suspect_marked',
                    'relationship', $3, $4)
            "#,
        )
        .bind(organization_id)
        .bind(payload.project_id)
        .bind(relationship.id)
        .bind(json!({
            "from_version": relationship.current_version,
            "to_version": next_version,
            "source_artifact_id": payload.source_artifact_id,
            "source_revision_id": payload.source_revision_id,
            "source_revision": payload.source_revision
        }))
        .execute(&mut **transaction)
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::SourceRevisedPayload;

    #[test]
    fn parses_source_revision_payload() {
        let payload: SourceRevisedPayload = serde_json::from_value(serde_json::json!({
            "project_id": "00000000-0000-4000-8000-000000000101",
            "source_artifact_id": "00000000-0000-4000-8000-000000000201",
            "source_revision_id": "00000000-0000-4000-8000-000000000301",
            "source_revision": 2
        }))
        .unwrap();
        assert_eq!(payload.source_revision, 2);
    }
}
