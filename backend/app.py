"""Database-driven marine alert bridge."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
from collections import deque
from contextlib import asynccontextmanager, suppress
from typing import Any

import asyncpg
from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = logging.getLogger("marine-bridge")
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/marine")


def database_connect_kwargs() -> dict[str, object]:
    """Use separate Compose credentials to avoid parsing secrets from a URL."""
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
REPLAY_LIMIT = int(os.getenv("ALERT_REPLAY_LIMIT", "100"))
ALLOWED_ORIGINS = {origin.strip() for origin in os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",") if origin.strip()}
MAX_WEBSOCKET_CLIENTS = int(os.getenv("MAX_WEBSOCKET_CLIENTS", "250"))
APP_ENV = os.getenv("APP_ENV", "development").lower()
AUTH_MODE = os.getenv("AUTH_MODE", "local").lower()
if APP_ENV == "production" and AUTH_MODE != "trusted_proxy":
    raise RuntimeError("Production requires AUTH_MODE=trusted_proxy with an identity-aware reverse proxy")
if APP_ENV == "production" and "*" in ALLOWED_ORIGINS:
    raise RuntimeError("Wildcard CORS origins are forbidden in production")
if APP_ENV == "production" and (not ALLOWED_ORIGINS or any("localhost" in origin for origin in ALLOWED_ORIGINS)):
    raise RuntimeError("Production must configure its exact HTTPS browser origins")


async def require_operator(request: Request) -> None:
    if AUTH_MODE == "trusted_proxy" and not request.headers.get("x-authenticated-user"):
        raise HTTPException(status_code=401, detail="Authentication required")


class Broker:
    def __init__(self) -> None:
        self.clients: dict[WebSocket, int] = {}
        self.client_seen: dict[WebSocket, set[str]] = {}
        self.client_seen_order: dict[WebSocket, deque[str]] = {}
        self.lock = asyncio.Lock()
        self.pool: asyncpg.Pool | None = None
        self.listener_task: asyncio.Task[None] | None = None
        self.last_event_seq = 0
        self.ready = asyncio.Event()

    async def publish(self, event: dict[str, Any]) -> None:
        event = json.loads(json.dumps(event, default=str))
        event_seq = int(event.get("event_seq", 0))
        if event_seq <= 0:
            log.error("Discarded marine alert without event_seq")
            return
        async with self.lock:
            self.last_event_seq = max(self.last_event_seq, event_seq)
            failed: list[WebSocket] = []
            for ws, cursor in tuple(self.clients.items()):
                event_id = str(event.get("alert_id", ""))
                if event_id and event_id in self.client_seen.get(ws, set()):
                    continue
                try:
                    await asyncio.wait_for(ws.send_json(event), timeout=5)
                    self.clients[ws] = max(cursor, event_seq)
                    self.remember_for_client(ws, event)
                except Exception:
                    failed.append(ws)
            for ws in failed:
                self.remove_client(ws)

    async def publish_telemetry(self, event: dict[str, Any]) -> None:
        """Push a committed simulator fix to connected maps without advancing alert cursors."""
        message = json.loads(json.dumps({"event": "telemetry", **event}, default=str))
        async with self.lock:
            failed: list[WebSocket] = []
            for ws in tuple(self.clients):
                try:
                    await asyncio.wait_for(ws.send_json(message), timeout=5)
                except Exception:
                    failed.append(ws)
            for ws in failed:
                self.remove_client(ws)

    def remember_for_client(self, ws: WebSocket, event: dict[str, Any]) -> None:
        event_id = str(event.get("alert_id", ""))
        if not event_id:
            return
        seen = self.client_seen.setdefault(ws, set())
        order = self.client_seen_order.setdefault(ws, deque())
        if event_id in seen:
            return
        seen.add(event_id)
        order.append(event_id)
        while len(order) > 1000:
            seen.discard(order.popleft())

    def remove_client(self, ws: WebSocket) -> None:
        self.clients.pop(ws, None)
        self.client_seen.pop(ws, None)
        self.client_seen_order.pop(ws, None)

    async def fetch_after(self, cursor: int, limit: int) -> list[dict[str, Any]]:
        assert self.pool
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT a.event_seq, a.alert_id, a.vessel_id, v.vessel_name, a.telemetry_id,
                          a.alert_type, a.severity, a.message, t.recorded_at,
                          t.latitude AS crossing_latitude, t.longitude AS crossing_longitude,
                          a.created_at AS alert_created_at
                   FROM alerts a JOIN vessels v USING (vessel_id)
                   LEFT JOIN telemetry_logs t ON t.telemetry_id=a.telemetry_id
                     AND t.recorded_at=a.telemetry_recorded_at
                   WHERE a.event_seq > $1 ORDER BY a.event_seq LIMIT $2""", cursor, limit
            )
        result = []
        for row in rows:
            item = json.loads(json.dumps(dict(row), default=str))
            item["raw_payload"] = json.dumps({k: item[k] for k in (
                "alert_id", "event_seq", "vessel_id", "vessel_name", "telemetry_id",
                "alert_type", "severity", "message", "recorded_at"
            ) if k in item}, separators=(",", ":"))
            item["delivery_mode"] = "replay"
            result.append(item)
        return result

    async def catch_up(self) -> None:
        """Replay alerts persisted while the dedicated LISTEN connection was down."""
        while True:
            rows = await self.fetch_after(self.last_event_seq, 500)
            if not rows:
                return
            for row in rows:
                await self.publish({"event": "alert", **row})

    async def on_notification(self, _conn: asyncpg.Connection, _pid: int,
                              _channel: str, payload: str) -> None:
        try:
            event = json.loads(payload)
            if self.pool and event.get("alert_id"):
                try:
                    row = await self.pool.fetchrow(
                        """SELECT a.created_at AS alert_created_at, t.latitude AS crossing_latitude,
                                  t.longitude AS crossing_longitude
                           FROM alerts a LEFT JOIN telemetry_logs t ON t.telemetry_id=a.telemetry_id
                             AND t.recorded_at=a.telemetry_recorded_at
                           WHERE a.alert_id=$1::uuid""", event["alert_id"]
                    )
                    if row:
                        event.update(dict(row))
                except Exception:
                    log.exception("Could not load alert creation timestamp")
            await self.publish({"event": "alert", **event, "raw_payload": payload, "delivery_mode": "live"})
        except (json.JSONDecodeError, TypeError):
            log.exception("Invalid marine_alerts payload")

    async def listen_forever(self) -> None:
        """Keep the dedicated LISTEN socket alive and recover alerts after reconnect."""
        while True:
            conn = None
            try:
                conn = await asyncpg.connect(DATABASE_URL, **database_connect_kwargs())
                await conn.add_listener("marine_alerts", self.on_notification)
                terminated = asyncio.Event()
                conn.add_termination_listener(lambda _conn: terminated.set())
                # LISTEN is active before catch-up, closing the query/listen race.
                if self.last_event_seq == 0:
                    async with self.pool.acquire() as pool_conn:  # type: ignore[union-attr]
                        latest = await pool_conn.fetchval("SELECT COALESCE(max(event_seq),0) FROM alerts")
                        # Prime the bridge with persisted alerts created during
                        # downtime; WebSocket clients also replay from their own cursor.
                        self.last_event_seq = max(0, latest - REPLAY_LIMIT)
                await self.catch_up()
                self.ready.set()
                log.info("Listening on marine_alerts")
                await terminated.wait()
                raise ConnectionError("PostgreSQL listener connection closed")
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Alert listener disconnected; retrying")
                await asyncio.sleep(2)
            finally:
                if conn:
                    with suppress(Exception):
                        await conn.remove_listener("marine_alerts", self.on_notification)
                    with suppress(Exception):
                        await conn.close()


broker = Broker()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    broker.pool = await asyncpg.create_pool(
        DATABASE_URL, min_size=1, max_size=10, **database_connect_kwargs()
    )
    try:
        broker.listener_task = asyncio.create_task(broker.listen_forever())
        await broker.ready.wait()
        yield
    finally:
        if broker.listener_task:
            broker.listener_task.cancel()
            with suppress(asyncio.CancelledError):
                await broker.listener_task
        await broker.pool.close()


app = FastAPI(title="Marine Drift Command Core", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:3000").split(","),
                   allow_credentials=True, allow_methods=["*"], allow_headers=["*"])


class TelemetryInput(BaseModel):
    vessel_id: str
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    speed: float = Field(ge=0, le=100)
    heading: float = Field(ge=0, le=360)


@app.post("/api/dev/telemetry")
async def inject_telemetry(data: TelemetryInput, _user: None = Depends(require_operator)) -> dict[str, Any]:
    """Local development control that inserts telemetry through the real DB triggers."""
    if APP_ENV != "development":
        raise HTTPException(status_code=404, detail="Not found")
    assert broker.pool
    async with broker.pool.acquire() as conn:
        inserted = await conn.fetchrow(
            """INSERT INTO telemetry_logs(vessel_id,latitude,longitude,geom,speed,heading)
               VALUES($1::uuid,$2,$3,ST_SetSRID(ST_MakePoint($3,$2),4326),$4,$5)
               RETURNING telemetry_id,vessel_id,latitude,longitude,speed,heading,recorded_at""",
            data.vessel_id, data.latitude, data.longitude, data.speed, data.heading,
        )
        state = await conn.fetchrow(
            """SELECT v.vessel_name, COALESCE(s.breach_notified,false) AS active_breach,
                      EXISTS(SELECT 1 FROM geofences g WHERE g.zone_type='SAFE'
                        AND ST_Covers(ST_Buffer(g.geom::geography,COALESCE((
                          SELECT value::double precision FROM marine_config WHERE setting='gps_tolerance_m'
                        ),25))::geometry,ST_SetSRID(ST_MakePoint($2,$1),4326))
                      ) AS inside_safe_zone
               FROM vessels v LEFT JOIN vessel_geofence_state s USING(vessel_id)
               WHERE v.vessel_id=$3::uuid""",
            data.latitude, data.longitude, data.vessel_id,
        )
    event = {**dict(inserted), **dict(state)}
    await broker.publish_telemetry(event)
    return event


@app.get("/health")
async def health() -> dict[str, str]:
    if broker.pool is None:
        return {"status": "starting"}
    async with broker.pool.acquire() as conn:
        await conn.fetchval("SELECT 1")
    return {"status": "ok"}


@app.get("/api/geofences")
async def geofences(_user: None = Depends(require_operator)) -> list[dict[str, Any]]:
    assert broker.pool
    async with broker.pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT geofence_id, zone_name, zone_type,
                      ST_AsGeoJSON(geom)::json AS geometry FROM geofences"""
        )
    return [dict(r) for r in rows]


@app.get("/api/vessels")
async def vessels(_user: None = Depends(require_operator)) -> list[dict[str, Any]]:
    assert broker.pool
    async with broker.pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT DISTINCT ON (v.vessel_id) v.vessel_id, v.vessel_name, v.status,
                      COALESCE(s.breach_notified,false) AS active_breach,
                      t.latitude, t.longitude, t.speed, t.heading, t.recorded_at,
                      CASE WHEN t.telemetry_id IS NULL THEN NULL ELSE EXISTS(
                        SELECT 1 FROM geofences g WHERE g.zone_type='SAFE'
                          AND ST_Covers(
                            ST_Buffer(g.geom::geography, COALESCE((
                              SELECT value::double precision FROM marine_config WHERE setting='gps_tolerance_m'
                            ),25))::geometry,t.geom
                          )
                      ) END AS inside_safe_zone
               FROM vessels v LEFT JOIN telemetry_logs t USING (vessel_id)
               LEFT JOIN vessel_geofence_state s USING (vessel_id)
               ORDER BY v.vessel_id, t.recorded_at DESC NULLS LAST"""
        )
    return [dict(r) for r in rows]


@app.get("/api/trajectories")
async def trajectories(_user: None = Depends(require_operator)) -> list[dict[str, Any]]:
    assert broker.pool
    async with broker.pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT vessel_id, vessel_name, latitude, longitude, speed, heading, recorded_at
               FROM (SELECT v.vessel_id, v.vessel_name, t.latitude, t.longitude, t.speed,
                            t.heading, t.recorded_at,
                            row_number() OVER (PARTITION BY v.vessel_id ORDER BY t.recorded_at DESC) AS rn
                     FROM vessels v JOIN telemetry_logs t USING (vessel_id)) q
               WHERE rn <= 40 ORDER BY vessel_id, recorded_at"""
        )
    return [dict(r) for r in rows]


@app.get("/api/analytics")
async def analytics(_user: None = Depends(require_operator)) -> dict[str, Any]:
    assert broker.pool
    async with broker.pool.acquire() as conn:
        row = await conn.fetchrow(
            """WITH latest AS (SELECT DISTINCT ON (vessel_id) vessel_id,speed FROM telemetry_logs ORDER BY vessel_id,recorded_at DESC)
               SELECT (SELECT count(*) FROM vessels WHERE status='ACTIVE') AS active_vessels,
                      (SELECT count(*) FROM vessel_geofence_state WHERE breach_notified) AS active_breaches,
                      (SELECT avg(speed) FROM latest WHERE speed IS NOT NULL) AS average_speed"""
        )
    return dict(row)


@app.websocket("/ws/alerts")
async def alert_stream(ws: WebSocket) -> None:
    if AUTH_MODE == "trusted_proxy" and not ws.headers.get("x-authenticated-user"):
        await ws.close(code=1008, reason="Authentication required")
        return
    origin = ws.headers.get("origin")
    if origin and origin not in ALLOWED_ORIGINS:
        await ws.close(code=1008, reason="Origin not allowed")
        return
    if APP_ENV == "production" and not origin:
        await ws.close(code=1008, reason="Origin header required")
        return
    await ws.accept()
    try:
        cursor = max(0, int(ws.query_params.get("after", "0")))
    except ValueError:
        await ws.close(code=1008, reason="Invalid event cursor")
        return
    try:
        async with broker.lock:
            if len(broker.clients) >= MAX_WEBSOCKET_CLIENTS:
                await ws.close(code=1013, reason="Connection capacity reached")
                return
            # No notification can be broadcast while this replay runs. The LISTEN
            # callback waits on the same lock, so events committed during replay
            # are delivered after the client is registered.
            async with broker.pool.acquire() as conn:  # type: ignore[union-attr]
                latest = await conn.fetchval("SELECT COALESCE(max(event_seq),0) FROM alerts")
            if cursor > latest:
                cursor = 0
            if cursor == 0:
                cursor = max(0, latest - REPLAY_LIMIT)
            while True:
                rows = await broker.fetch_after(cursor, min(REPLAY_LIMIT, 500))
                if not rows:
                    break
                for event in rows:
                    await ws.send_json({"event": "alert", **event})
                    cursor = int(event["event_seq"])
                    broker.remember_for_client(ws, event)
                if len(rows) < min(REPLAY_LIMIT, 500):
                    break
            broker.clients[ws] = cursor
        while True:
            # Keep the connection alive and allow clients to send optional pings.
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        async with broker.lock:
            broker.remove_client(ws)

