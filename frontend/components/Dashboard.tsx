'use client';
import dynamic from 'next/dynamic';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { line, curveMonotoneX } from 'd3-shape';
import { AlertEvent, useWebSocket } from './useWebSocket';

const MapView = dynamic(() => import('./MapView'), { ssr: false });
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';
type Analytics = { active_vessels: number; active_breaches: number; average_speed: number | null };
type Vessel = { vessel_id: string; vessel_name: string; latitude: number | null; longitude: number | null; speed: number | null; heading: number | null };
const category = (type: string) => type === 'DRIFT_WARNING' ? 'amber' : type === 'RUNAWAY' ? 'violet' : type === 'OFFLINE' ? 'slate' : 'rose';

export default function Dashboard() {
  const { alerts, telemetry, connected } = useWebSocket();
  const [stats, setStats] = useState<Analytics>({ active_vessels: 0, active_breaches: 0, average_speed: null });
  const [vessels, setVessels] = useState<Vessel[]>([]);
  const [selected, setSelected] = useState<AlertEvent | null>(null);
  const [focusedVesselId, setFocusedVesselId] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const [speeds, setSpeeds] = useState<number[]>([]);
  const [sim, setSim] = useState({ vessel_id: '', latitude: '13.0827', longitude: '80.30', speed: '5.8', heading: '90' });
  const [simMessage, setSimMessage] = useState('');

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const [a, v] = await Promise.all([fetch(`${API}/api/analytics`), fetch(`${API}/api/vessels`)]);
        if (a.ok && live) {
          const next = await a.json() as Analytics;
          setStats(next);
          if (next.average_speed != null) setSpeeds(old => [...old, next.average_speed!].slice(-32));
        }
        if (v.ok && live) {
          const next = await v.json() as Vessel[];
          setVessels(next);
          setSim(old => ({ ...old, vessel_id: old.vessel_id || next[0]?.vessel_id || '' }));
        }
      } catch { /* API health is shown by the stream and next refresh retries. */ }
    };
    void load(); const id = setInterval(load, 5000);
    return () => { live = false; clearInterval(id); };
  }, []);

  const rawLines = useMemo(() => [
    ...alerts.filter(a => a.raw_payload).map(a => ({ key: `alert-${a.alert_id}`, type: 'PG_NOTIFY', at: a.received_at ?? a.recorded_at, payload: a.raw_payload! })),
    ...telemetry.map(t => ({ key: `telemetry-${t.vessel_id}-${t.recorded_at}`, type: 'WEBSOCKET_FIX', at: t.received_at, payload: t.raw_payload })),
  ].sort((a, b) => Date.parse(b.at ?? '') - Date.parse(a.at ?? '')).slice(0, 30), [alerts, telemetry]);
  const submitTelemetry = async (e: FormEvent) => {
    e.preventDefault(); setSimMessage('Sending telemetry through PostgreSQL…');
    try {
      const response = await fetch(`${API}/api/dev/telemetry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vessel_id: sim.vessel_id, latitude: Number(sim.latitude), longitude: Number(sim.longitude), speed: Number(sim.speed), heading: Number(sim.heading) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail ?? `HTTP ${response.status}`);
      setFocusedVesselId(sim.vessel_id);
      setSimMessage(`Inserted ${result.telemetry_id}. WebSocket position update sent; PostGIS evaluation: ${result.inside_safe_zone ? 'inside SAFE zone' : 'outside SAFE zone'}.`);
    } catch (err) { setSimMessage(`Simulator unavailable: ${err instanceof Error ? err.message : 'request failed'}`); }
  };

  return <main className="fixed inset-0 z-0 overflow-hidden bg-slate-950">
    <MapView alerts={alerts} telemetry={telemetry} focusedVesselId={focusedVesselId} />
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col">
      <header className="pointer-events-none absolute inset-x-4 top-4 flex items-start justify-between gap-3 md:inset-x-6"><div className="glass pointer-events-auto rounded-xl px-4 py-3"><div className="text-[10px] tracking-[.35em] text-cyan">MARINE COMMAND / BAY OF BENGAL</div><h1 className="mt-1 text-xl font-semibold">Autonomous Fleet Monitor</h1><p className="mt-1 font-mono text-[9px] text-slate-400">CHENNAI SECTOR · 13.0827°N 80.2707°E</p></div><div className="pointer-events-auto flex items-center gap-2"><button className="hud-button glass" onClick={() => setDiagnostics(v => !v)}>{diagnostics ? 'Close diagnostics' : 'System diagnostics'}</button><div className="glass rounded-full px-4 py-2 text-xs"><span className={`mr-2 inline-block h-2 w-2 rounded-full ${connected ? 'bg-emerald-400 shadow-[0_0_10px_#34d399]' : 'animate-pulse bg-rose-400'}`} />{connected ? 'STREAM ONLINE' : 'RECONNECTING'}</div></div></header>
      <div className="glass pointer-events-auto absolute left-4 top-[112px] grid grid-cols-3 gap-4 rounded-xl p-3 sm:left-6 sm:gap-6 sm:p-4"><Metric label="ACTIVE VESSELS" value={stats.active_vessels} values={[]} /><Metric label="ACTIVE BREACHES" value={stats.active_breaches} danger={stats.active_breaches > 0} values={[]} /><Metric label="AVG SPEED (KN)" value={stats.average_speed == null ? 0 : Number(stats.average_speed.toFixed(1))} values={speeds} /></div>
      <aside className="glass pointer-events-auto absolute right-3 top-[112px] bottom-[204px] flex w-[min(92vw,360px)] flex-col rounded-2xl p-4 sm:right-6"><div className="mb-3 flex items-center justify-between"><div><p className="text-xs tracking-[.25em] text-cyan">EVENT STREAM</p><h2 className="text-lg">Alert Feed</h2></div><span className="font-mono text-xs text-slate-400">{alerts.length} alerts</span></div><div className="min-h-0 flex-1 overflow-y-auto pr-1"><AnimatePresence initial={false}>{alerts.map((alert, i) => { const hue = category(alert.alert_type); const key = alert.alert_id ?? `${alert.vessel_id}-${alert.recorded_at}-${i}`; return <motion.article key={key} layout initial={{ opacity: 0, x: 28 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ type: 'spring', stiffness: 360, damping: 32 }} className={`alert-${hue} mb-2 rounded-xl border bg-slate-950/65 p-3 backdrop-blur-md`}><button className="w-full text-left" onClick={() => { setSelected(selected?.alert_id === alert.alert_id ? null : alert); setFocusedVesselId(alert.vessel_id); }}><div className="flex justify-between text-xs font-semibold tracking-wider"><span>{alert.alert_type.replaceAll('_', ' ')}</span><time className="font-mono text-slate-500">{alert.recorded_at ? new Date(alert.recorded_at).toLocaleTimeString() : 'LIVE'}</time></div><p className="mt-1 text-sm text-slate-100">{alert.message ?? `${alert.vessel_name ?? alert.vessel_id} alert`}</p><p className="mt-1 font-mono text-[11px] text-slate-400">{alert.vessel_name ?? alert.vessel_id} · {alert.severity ?? 'WARNING'}</p></button>{selected?.alert_id === alert.alert_id && <div className="mt-3 border-t border-white/10 pt-3"><div className="flex justify-between text-[10px] uppercase tracking-widest text-cyan"><span>PostGIS trigger inspection</span><span className="font-mono normal-case text-amber-300">duration not instrumented</span></div><pre className="mt-2 overflow-x-auto rounded bg-black/60 p-2 text-[10px] leading-relaxed text-emerald-200">{`ST_Covers(\n  ST_Buffer(zone.geom::geography, gps_tolerance_m)::geometry,\n  ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)\n)`}</pre><p className="mt-2 text-[10px] text-slate-500">Spatial evaluation runs in the PostgreSQL telemetry trigger.</p></div>}</motion.article>; })}</AnimatePresence>{alerts.length === 0 && <div className="flex h-48 flex-col items-center justify-center text-center text-sm text-slate-400"><div className="radar mb-4"><span /></div><p>{connected ? 'Listening on marine_alerts' : 'Reconnecting to event bridge…'}</p><p className="mt-1 text-xs text-slate-500">Persisted alerts replay when the stream connects.</p></div>}</div></aside>
      <div className="pointer-events-none absolute inset-x-3 bottom-3 grid gap-3 sm:inset-x-6 sm:grid-cols-2 sm:gap-4 lg:right-[408px]">
        <section className="glass pointer-events-auto rounded-xl p-3 backdrop-blur-md"><div className="flex items-center justify-between"><div><p className="text-[9px] tracking-[.22em] text-cyan">DEVELOPMENT TOOL</p><h2 className="text-sm font-medium">Chaos simulator · Chennai sector</h2></div><span className="text-[9px] text-slate-400">real DB trigger</span></div><form onSubmit={submitTelemetry} className="mt-2 grid grid-cols-4 gap-2"><select aria-label="Vessel" className="hud-input col-span-4 sm:col-span-1" value={sim.vessel_id} onChange={e => setSim({ ...sim, vessel_id: e.target.value })}>{vessels.map(v => <option key={v.vessel_id} value={v.vessel_id}>{v.vessel_name}</option>)}</select>{(['latitude','longitude','speed','heading'] as const).map(k => <label key={k} className="hud-input-label"><span>{k}</span><input className="hud-input" type="number" step="any" value={sim[k]} onChange={e => setSim({ ...sim, [k]: e.target.value })} /></label>)}<button disabled={!sim.vessel_id} className="hud-button col-span-4" type="submit">Insert test position → publish live fix</button></form>{simMessage && <p className="mt-1 break-all font-mono text-[9px] text-slate-300">{simMessage}</p>}</section>
        <section className="glass pointer-events-auto rounded-xl p-3 backdrop-blur-md"><div className="flex items-center justify-between"><div><p className="text-[9px] tracking-[.22em] text-cyan">POSTGRESQL LISTEN / NOTIFY</p><h2 className="text-sm font-medium">Raw event stream</h2></div><button className="hud-button" onClick={() => setTerminal(v => !v)}>{terminal ? 'Collapse' : 'Expand'}</button></div>{terminal && <div className="terminal mt-2 max-h-28 overflow-auto rounded-lg p-2 font-mono text-[9px] leading-relaxed">{rawLines.length ? rawLines.map(a => <div key={a.key} className="break-all"><span className="text-cyan">[{a.type}] </span><span className="text-slate-500">{a.at ? new Date(a.at).toLocaleTimeString() : '—'} </span><span className="text-emerald-300">{a.payload}</span></div>) : <span className="text-slate-400">Waiting for telemetry and pg_notify events…</span>}</div>}<p className="mt-2 text-[9px] text-slate-500">Raw notification payloads and simulator WebSocket fixes.</p></section>
      </div>
      <div className="pointer-events-none absolute bottom-3 left-3 rounded bg-slate-950/75 px-2 py-1 font-mono text-[9px] tracking-widest text-cyan sm:bottom-[190px] sm:left-6">CHENNAI HUD · BAY OF BENGAL · UI BUILD 03</div>
      {diagnostics && <div className="pointer-events-auto absolute inset-0 z-30"><Diagnostics pulse={alerts.length > 0 || telemetry.length > 0} /></div>}
    </div>
  </main>;
}

function Metric({ label, value, danger = false, values }: { label: string; value: number; danger?: boolean; values: number[] }) {
  const d = line<number>().x((_, i) => i * 5).y(v => 28 - v * 3).curve(curveMonotoneX)(values);
  return <div className="relative min-w-[78px]"><div className="text-[9px] tracking-[.14em] text-slate-400">{label}</div><div className={`relative z-10 mt-1 font-mono text-2xl font-semibold ${danger ? 'text-rose-400 drop-shadow-[0_0_8px_rgba(251,113,133,.6)]' : 'text-white'}`}>{value}</div>{values.length > 1 && <svg className="absolute bottom-0 right-0 h-7 w-20 opacity-25" viewBox="0 0 155 32" preserveAspectRatio="none"><path d={d ?? ''} fill="none" stroke={danger ? '#fb7185' : '#4de5f2'} strokeWidth="2" /></svg>}</div>;
}

function Diagnostics({ pulse }: { pulse: boolean }) { const labels = ['Edge simulator', 'PostgreSQL ingest', 'PostGIS trigger', 'FastAPI WebSocket', 'Operator UI']; return <div className="absolute inset-0 z-[600] flex items-center justify-center bg-slate-950/75 p-5 backdrop-blur-sm"><div className="w-full max-w-4xl rounded-2xl border border-cyan/30 bg-slate-950/90 p-5 shadow-[0_0_45px_rgba(34,211,238,.13)]"><p className="text-[10px] tracking-[.25em] text-cyan">SYSTEM DIAGNOSTICS · EVENT PATH</p><div className="mt-8 grid grid-cols-1 gap-8 sm:grid-cols-5 sm:gap-3">{labels.map((label, i) => <div className="relative" key={label}><div className="rounded-lg border border-cyan/30 bg-cyan/5 p-3 text-center text-xs">{label}</div>{i < labels.length - 1 && <div className="absolute left-full top-1/2 hidden w-8 border-t border-cyan/50 sm:block"><motion.i className="absolute -top-[3px] h-1.5 w-1.5 rounded-full bg-cyan shadow-[0_0_10px_#4de5f2]" animate={pulse ? { x: [0, 32] } : { x: 0 }} transition={{ duration: 1.8, repeat: pulse ? Infinity : 0, repeatDelay: .5 }} /></div>}</div>)}</div><p className="mt-6 text-center font-mono text-[10px] text-slate-500">Telemetry → INSERT → trigger → pg_notify → LISTEN → WebSocket</p></div></div>; }
