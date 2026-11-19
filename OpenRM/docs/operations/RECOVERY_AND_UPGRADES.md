# Recovery and upgrade procedure

## Objectives

- Pilot recovery point objective: 24 hours or better.
- Pilot recovery time objective: 60 minutes or better.
- Controlled evidence must be restored without row-count loss or migration drift.

## Backup and restore rehearsal

Set `DATABASE_URL` to the source and `RECOVERY_DATABASE_URL` to an empty isolated PostgreSQL database, then run:

```bash
bash scripts/rehearse-recovery.sh
```

The rehearsal creates a custom-format dump with restrictive permissions, verifies the archive, restores it with owner/privilege stripping, reapplies current migrations, compares controlled-row and migration counts, and checks all critical evidence tables.

## Upgrade rehearsal

Restore the most recent backup into an isolated database and set `UPGRADE_DATABASE_URL`, then run:

```bash
bash scripts/rehearse-upgrade.sh
```

The script applies the migration set twice, proves idempotence, verifies the expected migration count, and queries the newest schema. Record elapsed restore time, backup age, database version, source/target migration counts, and operator identity.

## Disaster declaration

Declare a disaster if the primary database cannot meet the service objective, evidence integrity is uncertain, or recovery requires a new environment. Freeze writes, preserve telemetry, restore the last verified backup, replay only idempotent external deliveries, and require an administrator plus reviewer to accept evidence integrity before service resumes.
