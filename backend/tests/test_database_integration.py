"""Database checks run in CI and when TEST_DATABASE_URL points to a migrated DB."""
import os
import uuid

import asyncpg
import pytest

pytestmark = [pytest.mark.integration, pytest.mark.skipif(not os.getenv("TEST_DATABASE_URL"), reason="TEST_DATABASE_URL is not set")]


@pytest.mark.asyncio
async def test_postgis_partitioning_and_debounced_breach():
    conn = await asyncpg.connect(os.environ["TEST_DATABASE_URL"])
    vessel_id = uuid.uuid4()
    restricted_vessel_id = uuid.uuid4()
    anomaly_vessel_id = uuid.uuid4()
    fence_id = restricted_fence_id = None
    try:
        assert await conn.fetchval("SELECT postgis_version()")
        assert await conn.fetchval("SELECT EXISTS(SELECT 1 FROM pg_partitioned_table p JOIN pg_class c ON c.oid=p.partrelid WHERE c.relname='telemetry_logs')")
        fence_id = await conn.fetchval(
            """INSERT INTO geofences(zone_name,zone_type,geom)
               VALUES($1,'SAFE',ST_GeomFromText($2,4326)) RETURNING geofence_id""",
            f"test-{vessel_id}", "POLYGON((9.999 9.999,10.001 9.999,10.001 10.001,9.999 10.001,9.999 9.999))",
        )
        await conn.execute("INSERT INTO vessels(vessel_id,vessel_name) VALUES($1,$2)", vessel_id, f"test-{vessel_id}")
        for lon in (10.0, 10.01, 10.011, 10.012):
            await conn.execute(
                """INSERT INTO telemetry_logs(vessel_id,latitude,longitude,geom,speed,heading)
                   VALUES($1,10,$2,ST_SetSRID(ST_MakePoint($2,10),4326),5,90)""", vessel_id, lon
            )
        alerts = await conn.fetch("SELECT alert_type,severity,event_seq FROM alerts WHERE vessel_id=$1 ORDER BY event_seq", vessel_id)
        breaches = [a for a in alerts if a["alert_type"] == "GEOFENCE_BREACH"]
        assert len(breaches) == 1
        assert breaches[0]["severity"] == "CRITICAL"
        assert breaches[0]["event_seq"] > 0

        restricted_fence_id = await conn.fetchval(
            """INSERT INTO geofences(zone_name,zone_type,geom)
               VALUES($1,'RESTRICTED',ST_GeomFromText($2,4326)) RETURNING geofence_id""",
            f"restricted-{vessel_id}", "POLYGON((9.9995 9.9995,10.0005 9.9995,10.0005 10.0005,9.9995 10.0005,9.9995 9.9995))",
        )
        await conn.execute("INSERT INTO vessels(vessel_id,vessel_name) VALUES($1,$2)", restricted_vessel_id, f"restricted-test-{vessel_id}")
        await conn.execute(
            """INSERT INTO telemetry_logs(vessel_id,latitude,longitude,geom,speed,heading)
               VALUES($1,10,10,ST_SetSRID(ST_MakePoint(10,10),4326),5,90)""", restricted_vessel_id
        )
        restricted_alerts = await conn.fetch("SELECT alert_type FROM alerts WHERE vessel_id=$1", restricted_vessel_id)
        assert [row["alert_type"] for row in restricted_alerts] == ["GEOFENCE_BREACH"]

        await conn.execute("INSERT INTO vessels(vessel_id,vessel_name) VALUES($1,$2)", anomaly_vessel_id, f"anomaly-test-{vessel_id}")
        for speed, heading in ((5, 90), (26, 120), (26, 240)):
            await conn.execute(
                """INSERT INTO telemetry_logs(vessel_id,latitude,longitude,geom,speed,heading)
                   VALUES($1,10.0008,10.0008,ST_SetSRID(ST_MakePoint(10.0008,10.0008),4326),$2,$3)""",
                anomaly_vessel_id, speed, heading,
            )
        anomaly_types = {row["alert_type"] for row in await conn.fetch("SELECT alert_type FROM alerts WHERE vessel_id=$1", anomaly_vessel_id)}
        assert {"RUNAWAY", "DRIFT_WARNING"} <= anomaly_types
    finally:
        vessel_ids = [vessel_id, restricted_vessel_id, anomaly_vessel_id]
        await conn.execute("DELETE FROM alerts WHERE vessel_id=ANY($1::uuid[])", vessel_ids)
        await conn.execute("DELETE FROM telemetry_logs WHERE vessel_id=ANY($1::uuid[])", vessel_ids)
        await conn.execute("DELETE FROM vessel_geofence_state WHERE vessel_id=ANY($1::uuid[])", vessel_ids)
        await conn.execute("DELETE FROM vessels WHERE vessel_id=ANY($1::uuid[])", vessel_ids)
        if fence_id:
            await conn.execute("DELETE FROM geofences WHERE geofence_id=$1", fence_id)
        if restricted_fence_id:
            await conn.execute("DELETE FROM geofences WHERE geofence_id=$1", restricted_fence_id)
        await conn.close()
