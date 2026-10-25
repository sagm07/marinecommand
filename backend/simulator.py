"""Repeatable SAFE-zone exit scenario. Run: python simulator.py"""
import asyncio
import os
import socket
import asyncpg

DSN = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/marine")
VESSEL_NAME = os.getenv("SIM_VESSEL", "SIM-001")


def database_connect_kwargs() -> dict[str, object]:
    """Use the same Compose DNS workaround and credentials as the API service."""
    hostname = os.getenv("DATABASE_HOST")
    if not hostname:
        return {}
    return {
        "host": socket.gethostbyname(hostname),
        "port": int(os.getenv("DATABASE_PORT", "5432")),
        "user": os.environ["DATABASE_USER"],
        "password": os.environ["DATABASE_PASSWORD"],
        "database": os.environ["DATABASE_NAME"],
    }


async def main() -> None:
    conn = await asyncpg.connect(DSN, **database_connect_kwargs())
    try:
        vessel_id = await conn.fetchval("SELECT vessel_id FROM vessels WHERE vessel_name=$1", VESSEL_NAME)
        if vessel_id is None:
            vessel_id = await conn.fetchval(
                "INSERT INTO vessels(vessel_name,status) VALUES($1,'ACTIVE') RETURNING vessel_id", VESSEL_NAME
            )
        # The migration seeds a demo SAFE polygon around this track. The final
        # three readings are clearly outside its edge, beyond the GPS tolerance.
        track = [
            (37.0000, -122.0000, 4.2, 90),
            (37.0000, -121.9997, 4.4, 90),
            (37.0000, -121.9994, 4.6, 90),
            (37.0000, -121.9991, 5.0, 90),
            (37.0000, -121.9988, 5.2, 90),
            (37.0000, -121.9985, 5.4, 90),
            (37.0000, -121.9982, 5.6, 90),
            (37.0000, -121.9979, 5.8, 90),
        ]
        for lat, lon, speed, heading in track:
            await conn.execute(
                """INSERT INTO telemetry_logs
                   (vessel_id, latitude, longitude, geom, speed, heading)
                   VALUES ($1,$2,$3,ST_SetSRID(ST_MakePoint($3,$2),4326),$4,$5)""",
                vessel_id, lat, lon, speed, heading,
            )
            print(f"inserted lat={lat:.5f} lon={lon:.5f} speed={speed:.1f} heading={heading}")
            await asyncio.sleep(1)
        recent = await conn.fetch(
            "SELECT alert_type, severity, message, created_at FROM alerts WHERE vessel_id=$1 ORDER BY created_at DESC LIMIT 5",
            vessel_id,
        )
        print("Recent alerts:")
        for row in recent:
            print(dict(row))
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())

