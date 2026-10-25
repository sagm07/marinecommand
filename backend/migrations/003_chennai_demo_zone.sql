-- Synthetic demonstration polygon for the Chennai map. This is not a
-- navigational, legal, or regulatory boundary.
INSERT INTO geofences(zone_name, zone_type, geom)
SELECT 'DEMO · CHENNAI SAFE ZONE', 'SAFE', ST_GeomFromText(
  'POLYGON((80.285 13.05,80.315 13.05,80.315 13.115,80.285 13.115,80.285 13.05))', 4326
)
WHERE NOT EXISTS (
  SELECT 1 FROM geofences WHERE zone_name='DEMO · CHENNAI SAFE ZONE'
);
