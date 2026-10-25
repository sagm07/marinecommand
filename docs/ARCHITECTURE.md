# Architecture and delivery guarantees

## Runtime flow

```text
GPS producer / simulator
        │ INSERT telemetry_logs
        ▼
PostgreSQL + PostGIS ── trigger evaluates zones/anomalies ── INSERT alerts
        │                                                   │
        │ LISTEN marine_alerts                              └─ durable event_seq
        ▼                                                        │
FastAPI / asyncpg listener ─────────────── WebSocket ────────────┘
        ▲                                                        │
        └──── replay query after client cursor ◄─────────────────┘
                                      Next.js dashboard
```

The database owns the decision and durable alert row. `NOTIFY` is a prompt to the bridge, not the event store. WebSocket clients use the `event_seq` cursor to ask the API for rows they have not observed. FastAPI registers a dedicated listener connection outside its request pool, connects before serving requests, retries after disconnects, and queries the alerts table after reconnecting.

## Zone policy

- `RESTRICTED` polygons take priority and raise an immediate critical alert, even inside a SAFE polygon.
- A `SAFE` reading includes the configured GPS tolerance buffer around the safe polygon.
- The SAFE exit alert requires the configured number of consecutive readings outside that buffered region. A reading inside the buffer resets the counter and latch.
- The anomaly trigger compares each reading with the previous reading for that vessel. The example thresholds are speed at least 20 knots plus an 8-knot increase for `RUNAWAY`, or a course change of at least 90 degrees at 3 knots for `DRIFT_WARNING`.

Those thresholds are illustrative. Review the maritime operating concept and validate using recorded receiver error distributions before operational use. They are not collision-avoidance rules.

## Storage and partitions

Migration 002 range-partitions telemetry by `recorded_at` month. Each partition inherits the GiST position index and vessel/time B-tree index. The partitioned primary key is `(telemetry_id, recorded_at)`, because PostgreSQL requires unique constraints on a partitioned table to include the partition key. Alerts retain both fields to reference telemetry. A helper creates partitions, but no scheduler is bundled; deploy one and alert before a missing partition causes ingest failures.

For a large existing table, the current migration renames, copies, validates, and drops the old table in one transaction. That can take locks and temporary disk roughly proportional to the table plus indexes. Rehearse on a restored production-sized copy. For near-zero-downtime migration, use a staged shadow table, dual-write/capture, consistency check, and controlled cutover instead of running 002 directly.

## Delivery semantics

- The database transaction commits the `alerts` row and `NOTIFY` together.
- PostgreSQL `NOTIFY` is transient and payload-limited. It is not a durable queue; a database restart or disconnected listener can lose wakeups.
- The bridge catches up from the durable `alerts` table after reconnect. Browsers persist the latest event cursor and recent alert IDs in `localStorage`, replay with a 500-sequence overlap, and deduplicate by `alert_id`.
- Durable rows support replay through normal listener/browser reconnects, and clients deduplicate by `alert_id`. There is no end-to-end acknowledgement protocol: a browser reset, sequence/commit ordering race, retention, or database restore can require operator reconciliation. Do not treat a WebSocket as a safety-critical acknowledgement channel.
- The in-process connection registry is per API worker. Each worker maintains its own PostgreSQL listener, so each worker can broadcast to its own WebSockets. This avoids requiring shared process memory for fan-out, but increases database listener connections with replicas.
- `pg_notify` emits every alert payload and PostgreSQL coalesces duplicate channel/payload notifications within one transaction. Always keep the alerts table authoritative.

## Components and boundaries

`backend/app.py` contains the listener, HTTP read APIs, health check, WebSocket endpoint, and a development-only `/api/dev/telemetry` route used by the dashboard simulator to insert a fix and publish a live position update. That route is not a secure device-ingest interface and must not be exposed in production. `backend/migrate.py` acquires a PostgreSQL advisory lock and tracks ordered SQL migrations. The runtime connects as `marine_app`; migrations connect as the database owner. Frontend browser URLs are public build-time configuration, never secrets. `compose.yaml` publishes local services only on loopback.

## Production scale path

Before handling operational vessels, add an identity provider (OIDC), role/tenant authorization, immutable audit trail, authenticated device ingest, rate limits, TLS termination, durable broker/outbox, client acknowledgements, multi-region/HA database plan, partition retention policy, and measurable SLOs. Run load, failover, backup-restore, and GPS noise tests using target fleet rates. The dashboard simulator endpoint is development-only; no authenticated operational telemetry ingest endpoint is provided.
