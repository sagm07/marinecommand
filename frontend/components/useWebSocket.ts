'use client';
import { useEffect, useRef, useState } from 'react';

export type AlertEvent = { event?: string; event_seq?: number; alert_id?: string; vessel_id: string; vessel_name?: string; telemetry_id?: string; alert_type: string; severity?: string; message?: string; recorded_at?: string; alert_created_at?: string; crossing_latitude?: number | null; crossing_longitude?: number | null; received_at?: string; delivery_mode?: 'live' | 'replay'; raw_payload?: string };
export type TelemetryEvent = { event: 'telemetry'; vessel_id: string; vessel_name: string; latitude: number; longitude: number; speed: number | null; heading: number | null; recorded_at: string; active_breach: boolean; inside_safe_zone: boolean; received_at: string; raw_payload: string };
const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:8000/ws/alerts';

export function useWebSocket() {
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetryEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const seenIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    let socket: WebSocket | undefined; let timer: ReturnType<typeof setTimeout>; let stopped = false;
    const connect = () => {
      if (stopped) return;
      const stored = Number(window.localStorage.getItem('marine-alert-cursor') ?? '0');
      // Replay a bounded overlap to cover a transaction that received its
      // sequence before commit and became visible after a newer sequence.
      const cursor = String(Math.max(0, stored - 500));
      socket = new WebSocket(`${WS_URL}?after=${encodeURIComponent(cursor)}`);
      socket.onopen = () => { setConnected(true); socket?.send('ready'); };
      socket.onclose = () => { setConnected(false); timer = setTimeout(connect, 1500); };
      socket.onerror = () => socket?.close();
      socket.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data) as AlertEvent;
          if (event.event === 'telemetry' && event.vessel_id) {
            const telemetryEvent = { ...event, received_at: new Date().toISOString() } as TelemetryEvent;
            telemetryEvent.raw_payload = JSON.stringify({ event: 'telemetry', vessel_id: telemetryEvent.vessel_id, vessel_name: telemetryEvent.vessel_name, latitude: telemetryEvent.latitude, longitude: telemetryEvent.longitude, speed: telemetryEvent.speed, heading: telemetryEvent.heading, recorded_at: telemetryEvent.recorded_at, inside_safe_zone: telemetryEvent.inside_safe_zone });
            setTelemetry(old => [telemetryEvent, ...old.filter(x => x.vessel_id !== telemetryEvent.vessel_id)].slice(0, 50));
            return;
          }
          if (event.event_seq) {
            const previous = Number(window.localStorage.getItem('marine-alert-cursor') ?? '0');
            window.localStorage.setItem('marine-alert-cursor', String(Math.max(previous, Number(event.event_seq))));
          }
          // Only dedupe during this page session. Persisted alerts must replay after reload.
          if (event.alert_id && seenIds.current.has(event.alert_id)) return;
          if (event.alert_id) {
            seenIds.current.add(event.alert_id);
            while (seenIds.current.size > 1000) seenIds.current.delete(seenIds.current.values().next().value!);
          }
          if (event.alert_type) setAlerts(old => [{ ...event, received_at: new Date().toISOString() }, ...old].slice(0, 80));
        }
        catch { console.warn('Ignored malformed alert event'); }
      };
    };
    connect();
    return () => { stopped = true; clearTimeout(timer); socket?.close(); };
  }, []);
  return { alerts, telemetry, connected };
}
