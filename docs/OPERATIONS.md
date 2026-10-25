# Operations runbook

## Startup and readiness

Migration job completes before the API starts. API readiness requires a healthy database and a live LISTEN connection. Check `GET /health`, `docker compose ps`, and service logs. Alert on repeated listener reconnects, database pool exhaustion, WebSocket send timeouts, telemetry insert errors, and missing future partitions.

## Backups

Use a scheduled, encrypted `pg_dump` plus WAL archiving/PITR for production. A backup is not proven until restore is rehearsed. For local data export:

```powershell
docker compose exec -T db pg_dump -U postgres -d marine -Fc > marine.dump
```

Restore to an isolated PostGIS-compatible database and validate row counts, constraints, partitions, geofence geometry, and trigger behavior before using it. Keep encryption keys separate from backup files. Define and test RPO/RTO; the demo has no configured backup scheduler.

## Retention and partitions

Create monthly partitions ahead of the data month. Monitor at least two months forward. Define telemetry retention and archive/drop partitions only after legal/operational retention approval and verified backups. Never drop a partition just to fix a disk alert without checking its range and data disposition.

For volume estimates, measure actual ingest rows/day, average row + index bytes, and retention duration. Test GiST and B-tree sizes, autovacuum, checkpoint behavior, WAL rate, replication lag, and query plans under representative telemetry rates.

## Upgrade and rollback

Back up, restore to staging, run migrations and integration tests, measure locks/disk, rehearse API rollout, and document rollback. SQL migrations are tracked and transactional, but schema rollback is not automatically generated. Migration 002 replaces/drops the legacy telemetry table after copy; rollback requires a verified backup or a separately engineered reverse migration.

Promote the same immutable application image through environments. Do not build different code images for production and staging. Drain WebSockets during rolling deployments and expect browser reconnect/replay.

## Monitoring

Add metrics before scale-out: telemetry ingest rate/errors, alert insert count by type, listener up/down and reconnect count, catch-up rows/lag, event delivery latency, connected WebSockets, send timeouts, DB pool use, query latency, partition age, disk/WAL use, replication/backup health. Avoid putting vessel identifiers or exact positions in high-cardinality metric labels.

## Incident response

1. Preserve database and API logs; record UTC incident time and affected services.
2. Confirm whether telemetry rows and alert rows committed. Query durable `alerts` independently of WebSocket logs.
3. If the listener was down, restart/repair it and compare the durable event sequence to browser cursors.
4. If partition insertion failed, create the missing month partition, then have the trusted producer retry safely with an idempotency strategy.
5. Reconcile vessel state before resuming operator use. Do not infer no breach from an empty in-memory UI feed.
