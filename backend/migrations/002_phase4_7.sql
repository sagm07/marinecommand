-- Phase 4-7 database upgrade. Runner applies this file transactionally.
-- Requires PostgreSQL 14+ and PostGIS. Back up before production rollout.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Threshold state is kept per vessel so noisy boundary samples are not alerts.
CREATE TABLE IF NOT EXISTS vessel_geofence_state (
  vessel_id uuid PRIMARY KEY REFERENCES vessels(vessel_id) ON DELETE CASCADE,
  outside_count integer NOT NULL DEFAULT 0,
  breach_notified boolean NOT NULL DEFAULT false,
  restricted_notified boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE vessel_geofence_state ADD COLUMN IF NOT EXISTS breach_notified boolean NOT NULL DEFAULT false;
ALTER TABLE vessel_geofence_state ADD COLUMN IF NOT EXISTS restricted_notified boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS marine_config (
  setting text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO marine_config(setting,value) VALUES
  ('debounce_readings','3'), ('gps_tolerance_m','25')
ON CONFLICT(setting) DO NOTHING;

-- Add timestamp to alert FK so telemetry can be range partitioned by time.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS telemetry_recorded_at timestamptz;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS event_seq bigserial;
CREATE UNIQUE INDEX IF NOT EXISTS alerts_event_seq_unique ON alerts(event_seq);
UPDATE alerts a SET telemetry_recorded_at = t.recorded_at
FROM telemetry_logs t WHERE a.telemetry_id = t.telemetry_id AND a.telemetry_recorded_at IS NULL;

-- Swap in a partitioned telemetry table. The composite PK is required because
-- PostgreSQL requires every unique key on a partitioned table to include its key.
ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_telemetry_id_fkey;
ALTER TABLE telemetry_logs RENAME TO telemetry_logs_legacy;
ALTER TABLE telemetry_logs_legacy RENAME CONSTRAINT telemetry_logs_pkey TO telemetry_logs_legacy_pkey;
DROP INDEX IF EXISTS telemetry_geom_gist;
DROP INDEX IF EXISTS telemetry_vessel_time;
CREATE TABLE telemetry_logs (
  telemetry_id uuid NOT NULL DEFAULT gen_random_uuid(),
  vessel_id uuid NOT NULL REFERENCES vessels(vessel_id),
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  geom geometry(Point,4326) NOT NULL,
  speed double precision,
  heading double precision,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (telemetry_id, recorded_at)
) PARTITION BY RANGE (recorded_at);

CREATE OR REPLACE FUNCTION ensure_telemetry_month_partition(p_month date)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  lo date := date_trunc('month', p_month)::date;
  hi date := (date_trunc('month', p_month) + interval '1 month')::date;
  part text := 'telemetry_logs_' || to_char(lo, 'YYYY_MM');
BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF telemetry_logs FOR VALUES FROM (%L) TO (%L)', part, lo, hi);
END $$;

SELECT ensure_telemetry_month_partition(date_trunc('month', now() - interval '1 month')::date);
SELECT ensure_telemetry_month_partition(date_trunc('month', now())::date);
SELECT ensure_telemetry_month_partition(date_trunc('month', now() + interval '1 month')::date);
DO $$
DECLARE m date;
BEGIN
  FOR m IN SELECT DISTINCT date_trunc('month', recorded_at)::date FROM telemetry_logs_legacy LOOP
    PERFORM ensure_telemetry_month_partition(m);
  END LOOP;
END $$;

INSERT INTO telemetry_logs (telemetry_id,vessel_id,latitude,longitude,geom,speed,heading,recorded_at)
SELECT telemetry_id,vessel_id,latitude,longitude,geom,speed,heading,recorded_at FROM telemetry_logs_legacy;
ALTER TABLE alerts ADD CONSTRAINT alerts_telemetry_partition_fk
  FOREIGN KEY (telemetry_id, telemetry_recorded_at)
  REFERENCES telemetry_logs(telemetry_id, recorded_at) NOT VALID;
ALTER TABLE alerts VALIDATE CONSTRAINT alerts_telemetry_partition_fk;
DROP TABLE telemetry_logs_legacy;

CREATE INDEX telemetry_geom_gist ON telemetry_logs USING GIST (geom);
CREATE INDEX telemetry_vessel_time ON telemetry_logs (vessel_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS alerts_vessel_time ON alerts (vessel_id, created_at DESC);

CREATE OR REPLACE FUNCTION check_geofence_breach()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_name text;
  v_safe boolean;
  v_restricted boolean;
  v_restricted_notified boolean;
  v_count integer;
  v_threshold integer := 3;
  v_tolerance double precision := 25;
  v_type text;
  v_severity text;
  v_message text;
  v_alert_id uuid;
  v_event_seq bigint;
BEGIN
  SELECT value::integer INTO v_threshold FROM marine_config WHERE setting='debounce_readings';
  SELECT value::double precision INTO v_tolerance FROM marine_config WHERE setting='gps_tolerance_m';
  SELECT vessel_name INTO v_name FROM vessels WHERE vessel_id = NEW.vessel_id;
  SELECT EXISTS(SELECT 1 FROM geofences g WHERE g.zone_type='RESTRICTED' AND ST_Intersects(g.geom, NEW.geom))
    INTO v_restricted;
  SELECT EXISTS(
    SELECT 1 FROM geofences g WHERE g.zone_type='SAFE'
      AND ST_Covers(ST_Buffer(g.geom::geography, v_tolerance)::geometry, NEW.geom)
  ) INTO v_safe;

  IF v_restricted THEN
    INSERT INTO vessel_geofence_state(vessel_id,outside_count,breach_notified,restricted_notified,updated_at)
      VALUES(NEW.vessel_id,0,true,true,NEW.recorded_at)
      ON CONFLICT(vessel_id) DO UPDATE SET restricted_notified=true,breach_notified=true,updated_at=EXCLUDED.updated_at
      WHERE NOT vessel_geofence_state.restricted_notified;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count = 0 THEN RETURN NEW; END IF;
    v_type := 'GEOFENCE_BREACH'; v_severity := 'CRITICAL';
    v_message := format('%s entered a restricted zone', v_name);
  ELSIF NOT v_safe THEN
    INSERT INTO vessel_geofence_state(vessel_id,outside_count,breach_notified,updated_at)
      VALUES(NEW.vessel_id,1,false,NEW.recorded_at)
      ON CONFLICT(vessel_id) DO UPDATE SET outside_count=vessel_geofence_state.outside_count+1, updated_at=EXCLUDED.updated_at
      RETURNING outside_count INTO v_count;
    IF v_count < v_threshold THEN RETURN NEW; END IF;
    IF (SELECT breach_notified FROM vessel_geofence_state WHERE vessel_id=NEW.vessel_id) THEN RETURN NEW; END IF;
    UPDATE vessel_geofence_state SET breach_notified=true WHERE vessel_id=NEW.vessel_id;
    v_type := 'GEOFENCE_BREACH'; v_severity := 'CRITICAL';
    v_message := format('%s left the authorized safe zone (%s consecutive readings)', v_name, v_count);
  ELSE
    INSERT INTO vessel_geofence_state(vessel_id,outside_count,breach_notified,restricted_notified,updated_at) VALUES(NEW.vessel_id,0,false,false,NEW.recorded_at)
      ON CONFLICT(vessel_id) DO UPDATE SET outside_count=0, breach_notified=false, restricted_notified=false, updated_at=EXCLUDED.updated_at;
    RETURN NEW;
  END IF;

  INSERT INTO alerts(vessel_id,telemetry_id,telemetry_recorded_at,alert_type,severity,message)
    VALUES(NEW.vessel_id,NEW.telemetry_id,NEW.recorded_at,v_type,v_severity,v_message)
    RETURNING alert_id,event_seq INTO v_alert_id,v_event_seq;
  PERFORM pg_notify('marine_alerts', json_build_object(
    'alert_id',v_alert_id,'event_seq',v_event_seq,'vessel_id',NEW.vessel_id,'vessel_name',v_name,'telemetry_id',NEW.telemetry_id,
    'alert_type',v_type,'severity',v_severity,'message',v_message,'recorded_at',NEW.recorded_at
  )::text);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS telemetry_after_insert ON telemetry_logs;
CREATE TRIGGER telemetry_after_insert AFTER INSERT ON telemetry_logs
FOR EACH ROW EXECUTE FUNCTION check_geofence_breach();

-- Drift/runaway signal compares consecutive samples for the same vessel.
CREATE OR REPLACE FUNCTION detect_vessel_anomaly()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE prev_speed double precision; prev_heading double precision; v_name text; delta_heading double precision; v_alert_id uuid; v_event_seq bigint; v_message text;
BEGIN
  SELECT previous_speed,previous_heading INTO prev_speed,prev_heading
  FROM (
    SELECT vessel_id,telemetry_id,recorded_at,
           lag(speed) OVER (PARTITION BY vessel_id ORDER BY recorded_at,telemetry_id) AS previous_speed,
           lag(heading) OVER (PARTITION BY vessel_id ORDER BY recorded_at,telemetry_id) AS previous_heading
    FROM (
      SELECT vessel_id,telemetry_id,recorded_at,speed,heading
      FROM telemetry_logs WHERE vessel_id=NEW.vessel_id
        AND (recorded_at,telemetry_id) <= (NEW.recorded_at,NEW.telemetry_id)
      ORDER BY recorded_at DESC,telemetry_id DESC LIMIT 2
    ) recent
  ) history
  ORDER BY recorded_at DESC,telemetry_id DESC LIMIT 1;
  IF NOT FOUND OR (prev_speed IS NULL AND prev_heading IS NULL) THEN RETURN NEW; END IF;
  SELECT vessel_name INTO v_name FROM vessels WHERE vessel_id=NEW.vessel_id;
  IF NEW.speed IS NOT NULL AND prev_speed IS NOT NULL AND NEW.speed >= 20 AND NEW.speed-prev_speed >= 8 THEN
    v_message := format('%s speed spiked from %s to %s knots',v_name,prev_speed,NEW.speed);
    INSERT INTO alerts(vessel_id,telemetry_id,telemetry_recorded_at,alert_type,severity,message)
      VALUES(NEW.vessel_id,NEW.telemetry_id,NEW.recorded_at,'RUNAWAY','CRITICAL',v_message) RETURNING alert_id,event_seq INTO v_alert_id,v_event_seq;
    PERFORM pg_notify('marine_alerts',json_build_object('alert_id',v_alert_id,'event_seq',v_event_seq,'vessel_id',NEW.vessel_id,'vessel_name',v_name,'alert_type','RUNAWAY','severity','CRITICAL','message',v_message,'recorded_at',NEW.recorded_at)::text);
  ELSIF NEW.heading IS NOT NULL AND prev_heading IS NOT NULL THEN
    delta_heading := abs(NEW.heading-prev_heading);
    delta_heading := least(delta_heading,360-delta_heading);
    IF delta_heading >= 90 AND COALESCE(NEW.speed,0) >= 3 THEN
      v_message := format('%s changed course by %s degrees',v_name,round(delta_heading));
      INSERT INTO alerts(vessel_id,telemetry_id,telemetry_recorded_at,alert_type,severity,message)
        VALUES(NEW.vessel_id,NEW.telemetry_id,NEW.recorded_at,'DRIFT_WARNING','WARNING',v_message) RETURNING alert_id,event_seq INTO v_alert_id,v_event_seq;
      PERFORM pg_notify('marine_alerts',json_build_object('alert_id',v_alert_id,'event_seq',v_event_seq,'vessel_id',NEW.vessel_id,'vessel_name',v_name,'alert_type','DRIFT_WARNING','severity','WARNING','message',v_message,'recorded_at',NEW.recorded_at)::text);
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS telemetry_anomaly_after_insert ON telemetry_logs;
CREATE TRIGGER telemetry_anomaly_after_insert AFTER INSERT ON telemetry_logs
FOR EACH ROW EXECUTE FUNCTION detect_vessel_anomaly();

-- Local simulator fixture; it is only inserted when no SAFE zone exists.
INSERT INTO geofences(zone_name,zone_type,geom)
SELECT 'Simulator SAFE Zone','SAFE',ST_GeomFromText(
  'POLYGON((-122.001 36.999,-121.999 36.999,-121.999 37.001,-122.001 37.001,-122.001 36.999))',4326)
WHERE NOT EXISTS (SELECT 1 FROM geofences WHERE zone_type='SAFE');

-- Provision future partitions ahead of time (monthly maintenance job):
-- SELECT ensure_telemetry_month_partition((date_trunc('month', now()) + interval '2 months')::date);

GRANT SELECT ON vessel_geofence_state TO marine_app;
GRANT SELECT ON marine_config TO marine_app;
GRANT SELECT ON telemetry_logs,alerts,vessels,geofences TO marine_app;
GRANT INSERT ON vessels,telemetry_logs TO marine_app;
GRANT USAGE ON SCHEMA public TO marine_app;
REVOKE INSERT,UPDATE,DELETE ON alerts FROM marine_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE,SELECT ON SEQUENCE alerts_event_seq_seq TO marine_app;
