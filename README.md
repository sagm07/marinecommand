# Marine Drift & Geofencing Command Core

An end-to-end marine telemetry prototype: PostgreSQL/PostGIS evaluates each GPS report, stores alerts durably, and signals a FastAPI event bridge. A Next.js dashboard plots zones and vessel tracks and receives live alert events.

> This is an industry-aligned reference implementation, not a certified safety system. It has no operator identity provider or authorization model, has not been load-tested against your fleet or database, and does not replace vessel-side collision avoidance or regulatory controls. Follow [Security](docs/SECURITY.md) and [Operations](docs/OPERATIONS.md) before any external or safety-critical deployment.

## A-to-Z build guide

The full beginner-to-operations walkthrough is in [Build A to Z](docs/BUILD-A-Z.md). For a fast local start on Windows, macOS, or Linux:

1. Install Docker Desktop (or Docker Engine with Compose v2) and Git.
2. Copy `.env.example` to `.env`; replace both passwords with long, URL-safe random values.
3. Run `docker compose config` to check the configuration.
4. Run `docker compose up --build -d`.
5. Open [http://localhost:3000](http://localhost:3000).
6. In another terminal run `docker compose run --rm api python -m backend.simulator`.
7. Inspect service state with `docker compose ps` and logs with `docker compose logs -f api migrate`.

The database container applies numbered migrations on first startup. The simulator creates `SIM-001`, inserts a track inside the SAFE polygon, then crosses the boundary far enough to pass the 25 m tolerance for three consecutive readings.

The dashboard map opens centered on Chennai (13.0827, 80.2707) using Carto's dark basemap. Browser access to the public map tile service is required for map imagery; vessel, zone, and alert overlays are served by the local API. The API's interactive documentation is available at [http://localhost:8000/docs](http://localhost:8000/docs).

## Included

- Ordered database migrations from an empty database and a baseline option for an existing Phase 1–3 database.
- Monthly range partitions, geometry indexes, safe-zone tolerance, restricted-zone priority, consecutive-reading debounce, and speed/course anomaly rules.
- A dedicated asyncpg `LISTEN` connection that reconnects and catches up persisted alerts; WebSocket clients can resume from an alert cursor.
- HTTP API for health, geofences, current fleet positions, trajectories, and live analytics.
- Next.js 16, React 19, Leaflet, D3 trajectories, Framer Motion alert cards, and Tailwind CSS.
- Local container orchestration, least-privilege runtime database role, locked dependency graphs, Python/TypeScript checks, integration tests, and CI workflow.
- Build, migration, backup, restore, security, and scale-out guidance in `docs/`.

## Repository map

| Path | Purpose |
| --- | --- |
| `backend/app.py` | FastAPI routes, WebSocket hub, PostgreSQL listener, and local simulator endpoint |
| `backend/migrations/` | Ordered SQL migrations |
| `backend/migrate.py` | Advisory-locked transactional migration runner |
| `backend/simulator.py` | Repeatable SAFE-zone exit track |
| `backend/tests/` | Unit tests and PostGIS integration check |
| `frontend/` | Next.js tactical dashboard |
| `db/init/` | First-run least-privilege runtime role setup |
| `compose.yaml` | Local multi-service environment |
| `docs/` | Build A-to-Z, architecture, operations, security, and repository review |

## Verification and limits

The repository includes Python unit tests, a PostGIS integration check, a frontend TypeScript check, and a production build workflow. Run the verification commands in [Build A to Z](docs/BUILD-A-Z.md) in your environment before treating a build as verified. Docker-based end-to-end delivery requires Docker Compose and PostGIS to be running. Review [Architecture](docs/ARCHITECTURE.md), [Operations](docs/OPERATIONS.md), and [Security](docs/SECURITY.md) for reliability limits, operational procedures, and deployment controls.

This is a local demonstration. The `/api/dev/telemetry` endpoint exists to drive the dashboard simulator and is not a production-authenticated device-ingest API. Do not expose the demo services to the public internet or use them for navigation, collision avoidance, or regulatory enforcement.
