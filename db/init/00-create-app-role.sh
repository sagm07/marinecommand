#!/usr/bin/env bash
set -euo pipefail
: "${MARINE_APP_PASSWORD:?Set MARINE_APP_PASSWORD in the project .env}"
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 --set=app_password="$MARINE_APP_PASSWORD" <<'SQL'
CREATE ROLE marine_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
SQL
