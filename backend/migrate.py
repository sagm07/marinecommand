"""Transactional, ordered SQL migration runner with a legacy baseline option."""
from __future__ import annotations

import argparse
import asyncio
import os
import socket
from pathlib import Path
from urllib.parse import unquote, urlsplit

import asyncpg

MIGRATIONS = Path(__file__).parent / "migrations"


async def connect_with_retry(dsn: str, attempts: int = 15) -> asyncpg.Connection:
    """Resolve Compose DNS synchronously, then retry transient DB startup failures."""
    parsed = urlsplit(dsn)
    hostname = os.getenv("MIGRATION_DATABASE_HOST") or parsed.hostname
    if not hostname:
        raise ValueError("MIGRATION_DATABASE_URL must include a database hostname")
    port = int(os.getenv("MIGRATION_DATABASE_PORT") or parsed.port or 5432)
    user = os.getenv("MIGRATION_DATABASE_USER") or unquote(parsed.username or "")
    password = os.getenv("MIGRATION_DATABASE_PASSWORD")
    if password is None:
        password = unquote(parsed.password or "")
    database = os.getenv("MIGRATION_DATABASE_NAME") or unquote(parsed.path.lstrip("/"))
    for attempt in range(1, attempts + 1):
        try:
            # Docker's IPv4 service lookup can succeed while asyncio's threaded
            # getaddrinfo lookup intermittently fails on some Windows setups.
            # Pass the resolved address to asyncpg to avoid a second DNS lookup.
            resolved_host = socket.gethostbyname(hostname)
            return await asyncpg.connect(
                host=resolved_host,
                port=port,
                user=user,
                password=password,
                database=database,
                timeout=5,
            )
        except (OSError, asyncio.TimeoutError) as exc:
            if attempt == attempts:
                raise
            delay = min(attempt, 5)
            print(
                f"Database connection attempt {attempt}/{attempts} failed "
                f"({exc}); retrying in {delay}s",
                flush=True,
            )
            await asyncio.sleep(delay)
    raise RuntimeError("Database connection retry loop ended unexpectedly")


async def run(baseline: str | None = None) -> None:
    dsn = os.environ.get("MIGRATION_DATABASE_URL") or os.environ.get("DATABASE_URL")
    if not dsn:
        raise RuntimeError("Set MIGRATION_DATABASE_URL (recommended) or DATABASE_URL")
    conn = await connect_with_retry(dsn)
    try:
        await conn.execute("SELECT pg_advisory_lock(71020407)")
        await conn.execute("""CREATE TABLE IF NOT EXISTS schema_migrations (
            version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())""")
        if baseline:
            known = {p.stem for p in MIGRATIONS.glob("*.sql")}
            if baseline not in known:
                raise ValueError(f"Unknown migration baseline: {baseline}")
            # Only record a baseline for an already-created Phase 1-3 schema.
            required = {"vessels", "geofences", "telemetry_logs", "alerts"}
            existing = await conn.fetch("SELECT tablename FROM pg_tables WHERE schemaname='public'")
            names = {row["tablename"] for row in existing}
            if not required <= names:
                raise RuntimeError("Legacy baseline requires vessels, geofences, telemetry_logs, and alerts")
            await conn.execute("INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING", baseline)
            print(f"Recorded legacy baseline: {baseline}")
        applied = {r["version"] for r in await conn.fetch("SELECT version FROM schema_migrations")}
        for path in sorted(MIGRATIONS.glob("*.sql")):
            if path.stem in applied:
                continue
            sql = path.read_text(encoding="utf-8")
            print(f"Applying {path.name} …")
            async with conn.transaction():
                await conn.execute(sql)
                await conn.execute("INSERT INTO schema_migrations(version) VALUES($1)", path.stem)
            print(f"Applied {path.name}")
    finally:
        await conn.execute("SELECT pg_advisory_unlock(71020407)")
        await conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", help="Record an existing Phase 1-3 schema before migration")
    args = parser.parse_args()
    asyncio.run(run(args.baseline))

