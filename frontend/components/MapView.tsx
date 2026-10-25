'use client';
import { Fragment, useEffect, useState } from 'react';
import { CircleMarker, GeoJSON, MapContainer, TileLayer, Tooltip, useMap } from 'react-leaflet';
import { line, curveCatmullRom } from 'd3-shape';
import type { Feature, Geometry } from 'geojson';
import type { AlertEvent, TelemetryEvent } from './useWebSocket';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';
type Zone = { geofence_id: string; zone_name: string; zone_type: string; geometry: Geometry };
type Vessel = { vessel_id: string; vessel_name: string; latitude: number | null; longitude: number | null; speed: number | null; heading: number | null; active_breach: boolean; inside_safe_zone: boolean | null; recorded_at?: string };
type TrackPoint = { vessel_id: string; vessel_name: string; latitude: number; longitude: number };

function FocusTarget({ vessel, focus }: { vessel?: Vessel; focus: string | null }) {
  const map = useMap();
  useEffect(() => { if (focus && vessel?.latitude != null && vessel.longitude != null) map.flyTo([vessel.latitude, vessel.longitude], Math.max(map.getZoom(), 15), { duration: 1.2 }); }, [focus, vessel?.latitude, vessel?.longitude, map]);
  return null;
}

function HeadingVectors({ vessels, alerts, focus }: { vessels: Vessel[]; alerts: AlertEvent[]; focus: string | null }) {
  const map = useMap(); const [, redraw] = useState(0);
  useEffect(() => { const update = () => redraw(n => n + 1); map.on('move zoom resize', update); return () => { map.off('move zoom resize', update); }; }, [map]);
  const vectors = vessels.filter(v => v.latitude != null && v.longitude != null && v.heading != null).map(v => {
    const lat = v.latitude!; const lon = v.longitude!; const bearing = v.heading! * Math.PI / 180;
    const meters = Math.max(220, Math.min(1600, (v.speed ?? 1) * 45));
    const endLat = lat + (meters / 111320) * Math.cos(bearing);
    const endLon = lon + (meters / (111320 * Math.max(.15, Math.cos(lat * Math.PI / 180)))) * Math.sin(bearing);
    const start = map.latLngToContainerPoint([lat, lon]); const end = map.latLngToContainerPoint([endLat, endLon]);
    const type = alerts.find(a => a.vessel_id === v.vessel_id)?.alert_type;
    const color = v.active_breach || (type === 'GEOFENCE_BREACH' && v.inside_safe_zone === false) ? '#ff405b' : type === 'DRIFT_WARNING' ? '#fbbf24' : type === 'RUNAWAY' ? '#c084fc' : type === 'ABNORMAL_SPEED' ? '#fb923c' : '#4de5f2';
    const dx = end.x - start.x; const dy = end.y - start.y; const angle = Math.atan2(dy, dx); const size = 10;
    const p2 = [end.x - size * Math.cos(angle - .55), end.y - size * Math.sin(angle - .55)];
    const p3 = [end.x - size * Math.cos(angle + .55), end.y - size * Math.sin(angle + .55)];
    return { id: v.vessel_id, x1: start.x, y1: start.y, x2: end.x, y2: end.y, points: `${end.x},${end.y} ${p2[0]},${p2[1]} ${p3[0]},${p3[1]}`, color, opacity: !focus || focus === v.vessel_id ? 1 : .12, duration: Math.max(.25, 2.6 / Math.max(.5, v.speed ?? 1)) };
  });
  return <svg className="pointer-events-none absolute inset-0 z-[450] h-full w-full">{vectors.map(v => <g key={v.id} opacity={v.opacity}><line x1={v.x1} y1={v.y1} x2={v.x2} y2={v.y2} stroke={v.color} strokeWidth="2.5" strokeDasharray="6 8" strokeLinecap="round" style={{ animation: `marching-vector ${v.duration}s linear infinite`, filter: `drop-shadow(0 0 4px ${v.color})` }} /><polygon points={v.points} fill={v.color} /><circle cx={v.x2} cy={v.y2} r="2" fill={v.color} /></g>)}</svg>;
}

function nearestFencePoint(geometry: Geometry, latitude: number, longitude: number): [number, number] {
  let rings: number[][][] = [];
  if (geometry.type === 'Polygon') rings = geometry.coordinates as unknown as number[][][];
  if (geometry.type === 'MultiPolygon') rings = (geometry.coordinates as unknown as number[][][][]).flat();
  const scale = Math.cos(latitude * Math.PI / 180); let best: [number, number] = [longitude, latitude]; let min = Infinity;
  for (const ring of rings) for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i]; const [x2, y2] = ring[i + 1];
    const px = longitude * scale; const py = latitude; const ax = x1 * scale; const ay = y1; const bx = x2 * scale; const by = y2;
    const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2 || 1)));
    const cx = x1 + (x2 - x1) * t; const cy = y1 + (y2 - y1) * t; const d = ((longitude - cx) * scale) ** 2 + (latitude - cy) ** 2;
    if (d < min) { min = d; best = [cx, cy]; }
  }
  return best;
}

function BreachConnectors({ alerts, vessels, zones }: { alerts: AlertEvent[]; vessels: Vessel[]; zones: Zone[] }) {
  const map = useMap(); const [, redraw] = useState(0);
  useEffect(() => { const update = () => redraw(n => n + 1); map.on('move zoom resize', update); return () => { map.off('move zoom resize', update); }; }, [map]);
  const paths = alerts.filter(a => a.alert_type === 'GEOFENCE_BREACH' && a.crossing_latitude != null && a.crossing_longitude != null).flatMap(a => {
    const vessel = vessels.find(v => v.vessel_id === a.vessel_id);
    const safeZone = zones.find(z => z.zone_type === 'SAFE');
    if (!vessel || vessel.latitude == null || vessel.longitude == null || !safeZone) return [];
    const crossing: [number, number] = [a.crossing_latitude!, a.crossing_longitude!];
    const edge = nearestFencePoint(safeZone.geometry, crossing[0], crossing[1]);
    const boatPx = map.latLngToContainerPoint([vessel.latitude, vessel.longitude]);
    const edgePx = map.latLngToContainerPoint(edge); const crossPx = map.latLngToContainerPoint(crossing);
    return [{ id: a.alert_id ?? `${a.vessel_id}-${a.event_seq}`, d: `M${boatPx.x},${boatPx.y} L${edgePx.x},${edgePx.y} L${crossPx.x},${crossPx.y}`, x: crossPx.x, y: crossPx.y }];
  });
  return <svg className="pointer-events-none absolute inset-0 z-[460] h-full w-full">{paths.map(p => <g key={p.id}><path d={p.d} className="breach-connector" /><circle cx={p.x} cy={p.y} r="5" className="breach-crossing" /></g>)}</svg>;
}

function TrajectoryOverlay({ points, focus }: { points: TrackPoint[]; focus: string | null }) {
  const map = useMap(); const [, redraw] = useState(0);
  useEffect(() => { const update = () => redraw(n => n + 1); map.on('move zoom resize', update); return () => { map.off('move zoom resize', update); }; }, [map]);
  const grouped = new Map<string, TrackPoint[]>();
  for (const point of points) grouped.set(point.vessel_id, [...(grouped.get(point.vessel_id) ?? []), point]);
  const paths = Array.from(grouped.entries()).map(([id, track]: [string, TrackPoint[]]) => {
    const coords = track.map((p: TrackPoint) => { const xy = map.latLngToContainerPoint([p.latitude, p.longitude]); return [xy.x, xy.y] as [number, number]; });
    return { id, d: line<[number, number]>().x(p => p[0]).y(p => p[1]).curve(curveCatmullRom.alpha(.5))(coords) };
  });
  return <svg className="pointer-events-none absolute inset-0 z-[400] h-full w-full">{paths.map(p => p.d && <path key={p.id} d={p.d} fill="none" stroke="#43dced" strokeOpacity={focus && p.id !== focus ? '.12' : '.5'} strokeWidth="2" strokeDasharray="5 6"><animate attributeName="stroke-dashoffset" from="0" to="-22" dur="1.5s" repeatCount="indefinite" /></path>)}</svg>;
}

export default function MapView({ alerts = [], telemetry = [], focusedVesselId = null }: { alerts?: AlertEvent[]; telemetry?: TelemetryEvent[]; focusedVesselId?: string | null }) {
  const [zones, setZones] = useState<Zone[]>([]); const [vessels, setVessels] = useState<Vessel[]>([]); const [tracks, setTracks] = useState<TrackPoint[]>([]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 10000); return () => clearInterval(id); }, []);
  useEffect(() => {
    const load = async () => {
      try {
        const [z, v, t] = await Promise.all([fetch(`${API}/api/geofences`), fetch(`${API}/api/vessels`), fetch(`${API}/api/trajectories`)]);
        if (z.ok) {
          const data = await z.json();
          setZones((Array.isArray(data) ? data : []).flatMap((zone: Zone) => {
            try { return [{ ...zone, geometry: (typeof zone.geometry === 'string' ? JSON.parse(zone.geometry) : zone.geometry) as Geometry }]; }
            catch { console.warn('Skipped invalid geofence GeoJSON', zone.geofence_id); return []; }
          }));
        }
        if (v.ok) setVessels(await v.json()); if (t.ok) setTracks(await t.json());
      } catch { /* API may start after the dashboard; the next refresh retries. */ }
    };
    void load(); const id = setInterval(load, 5000); return () => clearInterval(id);
  }, []);
  const liveVessels = vessels.map(v => {
    const fix = telemetry.find(t => t.vessel_id === v.vessel_id);
    return fix ? { ...v, ...fix } : v;
  });
  const palette = (type: string) => type === 'RESTRICTED' ? '#ff405b' : '#38d8bd';
  const focusVessel = liveVessels.find(v => v.vessel_id === focusedVesselId);
  const typeForVessel = (id: string) => alerts.find(a => a.vessel_id === id)?.alert_type;
  const hasGeofenceAlert = liveVessels.some(v => v.active_breach);
  const vesselColor = (v: Vessel) => now - Date.parse(String(v.recorded_at ?? 0)) > 120000 ? '#94a3b8' : v.active_breach || (typeForVessel(v.vessel_id) === 'GEOFENCE_BREACH' && v.inside_safe_zone === false) ? '#ff405b' : typeForVessel(v.vessel_id) === 'DRIFT_WARNING' ? '#fbbf24' : typeForVessel(v.vessel_id) === 'RUNAWAY' ? '#c084fc' : typeForVessel(v.vessel_id) === 'ABNORMAL_SPEED' ? '#fb923c' : '#59e5f2';
  const allTracks = [...tracks, ...telemetry.map(t => ({ vessel_id: t.vessel_id, vessel_name: t.vessel_name, latitude: t.latitude, longitude: t.longitude }))];
  return <MapContainer center={[13.0827, 80.2707]} zoom={10} zoomControl={false} className="fixed inset-0 z-0 h-screen w-screen full-bleed-map">
    <FocusTarget vessel={focusVessel} focus={focusedVesselId} />
    <TileLayer
      url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
      attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
      maxZoom={19}
    />
    {zones.map(zone => { const flashing = hasGeofenceAlert && zone.zone_type === 'SAFE'; return <GeoJSON key={zone.geofence_id} data={{ type: 'Feature', properties: {}, geometry: zone.geometry } as Feature} style={{ color: flashing ? '#ff405b' : palette(zone.zone_type), fillColor: flashing ? '#ff405b' : palette(zone.zone_type), fillOpacity: .12, weight: flashing ? 3 : 2, className: flashing ? 'zone-breach-flash' : '' }} />; })}
    <TrajectoryOverlay points={allTracks} focus={focusedVesselId} />
    <HeadingVectors vessels={liveVessels.filter(v => now - Date.parse(String(v.recorded_at ?? 0)) <= 120000)} alerts={alerts} focus={focusedVesselId} />
    <BreachConnectors alerts={alerts} vessels={liveVessels} zones={zones} />
    {liveVessels.filter(v => v.latitude != null && v.longitude != null).map(v => {
      const color = vesselColor(v);
      const isOffline = now - Date.parse(String(v.recorded_at ?? 0)) > 120000;
      const isFocused = !focusedVesselId || focusedVesselId === v.vessel_id;
      const liveAlert = alerts.find(a => a.vessel_id === v.vessel_id && a.delivery_mode === 'live' && a.alert_created_at && a.received_at);
      const latency = liveAlert ? Math.max(0, Date.parse(liveAlert.received_at!) - Date.parse(liveAlert.alert_created_at!)) : null;
      return <Fragment key={v.vessel_id}>{isOffline && <CircleMarker center={[v.latitude!, v.longitude!]} radius={18} pathOptions={{ color: '#94a3b8', fillColor: 'transparent', fillOpacity: 0, opacity: isFocused ? .7 : .15, weight: 2, className: 'vessel-offline-radius' }} />}
      <CircleMarker center={[v.latitude!, v.longitude!]} radius={isOffline ? 7 : v.active_breach ? 9 : 6} pathOptions={{ color, fillColor: color, fillOpacity: isOffline ? 0 : isFocused ? .9 : .18, opacity: isFocused ? 1 : .15, weight: isOffline ? 2 : 3, className: isOffline ? 'vessel-offline' : v.active_breach ? 'vessel-critical' : typeForVessel(v.vessel_id) === 'DRIFT_WARNING' ? 'vessel-warning' : typeForVessel(v.vessel_id) === 'RUNAWAY' ? 'vessel-runaway' : typeForVessel(v.vessel_id) === 'ABNORMAL_SPEED' ? 'vessel-abnormal' : '' }}>
        <Tooltip className="tactical-tooltip" direction="top" offset={[0, -8]}>
          <div className="tactical-hud">
            <div className="tactical-title">VESSEL DIAGNOSTICS <span>{isOffline ? 'LAST KNOWN' : v.active_breach ? 'BREACH' : 'LIVE'}</span></div>
            <div className="tactical-grid"><b>ID</b><strong>{v.vessel_name}</strong><b>SPD</b><strong>{v.speed ?? '—'} kn</strong><b>HDG</b><strong>{v.heading ?? '—'}°</strong></div>
            <div className="db-eval"><div className="tactical-title">DATABASE EVAL · POSTGIS</div>
              {v.inside_safe_zone == null ? <div className="eval-unknown">ST_Covers(SAFE_BUFFER, vessel): NO FIX</div> : <div className={v.inside_safe_zone ? 'eval-true' : 'eval-false'}>ST_Covers(SAFE_BUFFER, vessel): {v.inside_safe_zone ? 'TRUE' : 'FALSE'}</div>}
            </div>
            <div className="tactical-foot">{latency == null ? 'EVENT PROPAGATION: —' : `DB → UI EVENT: ${latency} ms`}</div>
          </div>
        </Tooltip>
      </CircleMarker></Fragment>;
    })}
  </MapContainer>;
}
