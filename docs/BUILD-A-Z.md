# Build A to Z

This guide assumes you want a working local environment. Commands are shown for PowerShell where Windows differs; Docker Compose commands are otherwise the same on Linux and macOS.

## A. Understand the data flow

The browser does not poll PostgreSQL. It loads API snapshots, then opens `/ws/alerts`. Each telemetry insert runs geofence and anomaly triggers. The trigger writes an `alerts` row and calls `pg_notify` in the same transaction. FastAPI's dedicated asyncpg connection listens on `marine_alerts`; if that connection drops, it queries durable alerts to catch up. See [Architecture](ARCHITECTURE.md).

## B. Install prerequisites

- Docker Desktop with Compose v2 on Windows/macOS, or Docker Engine plus Compose v2 on Linux.
- Git, if cloning or versioning the project.
- Optional for running tools outside containers: Python 3.12 and Node.js 22.
- Outbound network access for first image/package downloads and Carto map tiles.

Verify with `docker --version` and `docker compose version`. Docker Desktop must be running.

## C. Get the project files

Extract the complete ZIP into a working folder, for example `C:\work\marine-command-core`. Open a terminal in the folder containing `compose.yaml`. Do not run Compose from inside `backend` or `frontend`.

## D. Set local secrets

Copy the template:

```powershell
Copy-Item .env.example .env
```

Replace `POSTGRES_PASSWORD` and `MARINE_APP_PASSWORD` in `.env` with different, long, URL-safe values. These credentials are local development secrets; never commit `.env`. For a random 48-character hex secret in PowerShell:

```powershell
$bytes = New-Object byte[] 24
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToHexString($bytes)
```

Run it twice and use one result for each password. URL-safe hex avoids database URL escaping problems.

## E. Validate Compose configuration

```powershell
docker compose config
```

Correct any missing-variable or YAML errors before starting services. This command prints resolved environment values; avoid sharing its output if you have already entered real secrets.

## F. Build and start the services

```powershell
docker compose up --build -d
docker compose ps
```

The first build downloads the pinned PostGIS image, Python packages, and frontend packages and can take several minutes. `migrate` exits successfully after applying the SQL files in order. The API starts only after that migration job succeeds; the dashboard waits for API health.

## G. Confirm service health

```powershell
docker compose ps
Invoke-RestMethod http://localhost:8000/health
```

Expected health response: `status = ok`. If the API is unhealthy, inspect `docker compose logs --tail 100 db migrate api`.

## H. Open the dashboard

Open [http://localhost:3000](http://localhost:3000). The map starts centered on Chennai at latitude 13.0827, longitude 80.2707 and uses Carto dark tiles, which require browser network access. The migration seeds a clearly labeled synthetic SAFE demo zone near Chennai; it is only for exercising the dashboard and does not represent a real maritime boundary. The connection badge should read `STREAM ONLINE`.

## I. Generate a synthetic breach

In a second terminal from the project root:

```powershell
docker compose run --rm api python -m backend.simulator
```

The simulator reuses vessel `SIM-001`, sends readings once per second, and prints recent alerts. The SAFE boundary has a 25 m tolerance and needs three consecutive readings outside that buffer before a breach is recorded. The first three reports are inside the SAFE zone; the later reports cross beyond its buffered edge.

## J. Trace a live event

Watch the API and database logs:

```powershell
docker compose logs -f api db
```

Insert a telemetry row with `simulator.py` or a trusted device. The alert card should arrive without refreshing the page. `alerts.event_seq` is persisted; a reconnecting browser requests events after its last cursor.

## K. Inspect the database

```powershell
docker compose exec db psql -U postgres -d marine -c "SELECT vessel_name,status FROM vessels ORDER BY vessel_name;"
docker compose exec db psql -U postgres -d marine -c "SELECT alert_type,severity,message,created_at FROM alerts ORDER BY event_seq DESC LIMIT 10;"
docker compose exec db psql -U postgres -d marine -c "SELECT inhrelid::regclass AS partition FROM pg_inherits WHERE inhparent='telemetry_logs'::regclass ORDER BY 1;"
```

The web/API containers bind ports only to `127.0.0.1` on the host.

## L. Run automated checks

Frontend type check and production build:

```powershell
cd frontend
npm ci
npm run lint
npm run build
cd ..
```

Backend unit and PostGIS integration checks run in the CI workflow. To run locally, create a Python virtual environment, install `backend/requirements-dev.txt`, start a migrated PostGIS database, and set `TEST_DATABASE_URL` to an admin/test database URL:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r backend/requirements-dev.txt
$env:TEST_DATABASE_URL = "postgresql://postgres:YOUR_PASSWORD@localhost:5432/marine"
python -m pytest backend/tests -v
```

## M. Work with a pre-existing Phase 1–3 database

The default Compose flow is for a **fresh local database**. Do not start it with a production data volume. The migration converts the telemetry table to time partitions and can lock/rewrite a large table.

For an existing database, take and verify a restorable backup first. Create the non-superuser role `marine_app` and grant it login. Set `MIGRATION_DATABASE_URL` to a schema-owner/admin URL and `DATABASE_URL` to the runtime role URL. From a Python environment with backend requirements installed, record the baseline and apply migration 002:

```powershell
$env:MIGRATION_DATABASE_URL = "postgresql://DB_OWNER:OWNER_PASSWORD@HOST:5432/DATABASE"
python -m backend.migrate --baseline 001_initial_schema
python -m backend.migrate
```

The baseline command checks that `vessels`, `geofences`, `telemetry_logs`, and `alerts` exist; it records the initial schema as already present. It does not run migration 001 against those tables. Migration 002 then upgrades them. Create `marine_app` before applying because migration 002 grants access to it. Review `backend/migrations/002_phase4_7.sql` and rehearse on a restored copy before running against valuable data.

Example role creation from an admin `psql` session (replace the placeholder with a long URL-safe hex value generated in section D):

```sql
CREATE ROLE marine_app LOGIN PASSWORD 'PASTE_LONG_URL_SAFE_PASSWORD_HERE'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
```

Then use the same role password in `DATABASE_URL`; use only the separate database-owner URL as `MIGRATION_DATABASE_URL`.

## Run without the full Compose stack

If you already have a compatible PostgreSQL/PostGIS instance and local Python/Node installed:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r backend/requirements-dev.txt
$env:MIGRATION_DATABASE_URL = "postgresql://DB_OWNER:OWNER_PASSWORD@localhost:5432/marine"
python -m backend.migrate
$env:DATABASE_URL = "postgresql://marine_app:APP_PASSWORD@localhost:5432/marine"
uvicorn backend.app:app --reload --port 8000
```

In another terminal, activate the same environment, set the same `DATABASE_URL`, then run `python -m backend.simulator`. In a third terminal, copy `frontend/.env.local.example` to `frontend/.env.local`, run `npm ci` and `npm run dev` from `frontend`, then open `http://localhost:3000`. For an existing Phase 1–3 schema, use the baseline procedure in section M instead of applying migration 001.

## N. Change GPS tolerance or debounce threshold

The migration stores both values in `marine_config`. An administrator can update them:

```sql
UPDATE marine_config SET value='4', updated_at=now() WHERE setting='debounce_readings';
UPDATE marine_config SET value='35', updated_at=now() WHERE setting='gps_tolerance_m';
```

These values apply to subsequent telemetry inserts. Choose them using measured receiver accuracy and operating rules; the defaults are demonstration values.

## O. Keep time partitions ahead

Migration 002 creates partitions for existing months and nearby months. Schedule this SQL at least one month before a new month begins:

```sql
SELECT ensure_telemetry_month_partition((date_trunc('month', now()) + interval '2 months')::date);
```

If a partition is missing, PostgreSQL rejects inserts for that month. Monitor for this condition and alert on failed telemetry ingest.

## P. Stop and start safely

```powershell
docker compose stop
docker compose start
```

To remove containers but preserve database data: `docker compose down`. To destroy the local database and start fresh: `docker compose down -v` (this permanently deletes the Compose volume). Only use `-v` when you intend to discard that local data.

## Q. Update dependencies

Review changelogs and security advisories, change direct dependency versions deliberately, regenerate `frontend/package-lock.json` with `npm install`, run `npm ci`, checks, and a deployment rehearsal. Python direct versions are pinned in `backend/requirements.txt`; update them in a branch and rebuild the container. Avoid floating tags for production image deployment; promote reviewed immutable digests.

## R. Read the rest of the docs

- [Architecture and delivery guarantees](ARCHITECTURE.md)
- [Security checklist](SECURITY.md)
- [Operations, backup, restore, and scaling](OPERATIONS.md)
- [GitHub repositories and design references](REPOSITORY-REVIEW.md)

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `migrate` exits nonzero | `docker compose logs migrate db`; check `.env`, role creation, and SQL error. |
| API cannot connect | `docker compose ps`; inspect database health and `DATABASE_URL` service hostname (`db`, not `localhost`). |
| UI shows API offline | Check `/health`, ports 8000/3000, and browser console. |
| No simulated breach | Confirm migration 002 is applied, a SAFE zone exists, simulator positions are beyond buffer, and `marine_config` is `3` / `25`. |
| Map has no tiles | Verify browser network access; the API and data overlays do not depend on map tiles. |
| Port conflict | Change host-side port mappings in `compose.yaml` and update the public frontend API/WS URLs before building. |

