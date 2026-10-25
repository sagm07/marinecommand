-- Fresh-install equivalent of the completed Phase 1-3 database.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE TABLE vessels (
  vessel_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vessel_name text UNIQUE NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','MAINTENANCE')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE geofences (
  geofence_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_name text NOT NULL,
  zone_type text NOT NULL DEFAULT 'SAFE' CHECK (zone_type IN ('SAFE','RESTRICTED')),
  geom geometry(Polygon,4326) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ST_IsValid(geom))
);
CREATE INDEX geofences_geom_gist ON geofences USING GIST (geom);

CREATE TABLE telemetry_logs (
  telemetry_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vessel_id uuid NOT NULL REFERENCES vessels(vessel_id),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  geom geometry(Point,4326) NOT NULL,
  speed double precision CHECK (speed IS NULL OR speed >= 0),
  heading double precision CHECK (heading IS NULL OR heading BETWEEN 0 AND 360),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ST_Y(geom) = latitude AND ST_X(geom) = longitude)
);
CREATE INDEX telemetry_geom_gist ON telemetry_logs USING GIST (geom);
CREATE INDEX telemetry_vessel_time ON telemetry_logs (vessel_id, recorded_at DESC);

CREATE TABLE alerts (
  alert_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vessel_id uuid NOT NULL REFERENCES vessels(vessel_id),
  telemetry_id uuid REFERENCES telemetry_logs(telemetry_id),
  alert_type text NOT NULL,
  severity text NOT NULL DEFAULT 'WARNING' CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  message text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alerts_vessel_time ON alerts(vessel_id, created_at DESC);

CREATE OR REPLACE FUNCTION check_geofence_breach()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_name text;
BEGIN
  SELECT vessel_name INTO v_name FROM vessels WHERE vessel_id=NEW.vessel_id;
  IF NOT EXISTS (SELECT 1 FROM geofences WHERE zone_type='SAFE' AND ST_Covers(geom,NEW.geom)) THEN
    INSERT INTO alerts(vessel_id,telemetry_id,alert_type,severity,message)
      VALUES(NEW.vessel_id,NEW.telemetry_id,'GEOFENCE_BREACH','CRITICAL',v_name || ' left the safe area');
    PERFORM pg_notify('marine_alerts',json_build_object('vessel_id',NEW.vessel_id,'vessel_name',v_name,'alert_type','GEOFENCE_BREACH','severity','CRITICAL','recorded_at',NEW.recorded_at)::text);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER telemetry_after_insert AFTER INSERT ON telemetry_logs
FOR EACH ROW EXECUTE FUNCTION check_geofence_breach();

-- The runtime role is created by db/init/00-create-app-role.sh.
GRANT USAGE ON SCHEMA public TO marine_app;
GRANT SELECT ON vessels,geofences,telemetry_logs,alerts TO marine_app;
GRANT INSERT ON vessels,telemetry_logs,alerts TO marine_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO marine_app;

