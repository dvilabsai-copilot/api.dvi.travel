CREATE TABLE IF NOT EXISTS dvi_main.dvi_permit_cost_backup_20260613 AS
SELECT *
FROM dvi_main.dvi_permit_cost;

DROP TEMPORARY TABLE IF EXISTS tmp_main_vendor_states;
CREATE TEMPORARY TABLE tmp_main_vendor_states AS
SELECT
  v.vendor_id,
  v.vendor_name,
  v.vendor_city,
  COALESCE(ps_city.permit_state_id, ps_state.permit_state_id, fallback.permit_state_id) AS permit_state_id
FROM dvi_main.dvi_vendor_details v
LEFT JOIN dvi_main.dvi_cities c
  ON c.id = v.vendor_city
LEFT JOIN dvi_main.dvi_states s_city
  ON s_city.id = c.state_id
LEFT JOIN dvi_main.dvi_permit_state ps_city
  ON ps_city.state_name = s_city.name
 AND ps_city.deleted = 0
 AND ps_city.status = 1
LEFT JOIN dvi_main.dvi_states s_state
  ON s_state.id = v.vendor_state
LEFT JOIN dvi_main.dvi_permit_state ps_state
  ON ps_state.state_name = s_state.name
 AND ps_state.deleted = 0
 AND ps_state.status = 1
LEFT JOIN (
  SELECT
    tv.vendor_name,
    ps_fallback.permit_state_id
  FROM dvi_travels.dvi_vendor_details tv
  LEFT JOIN dvi_travels.dvi_cities tc
    ON tc.id = tv.vendor_city
  LEFT JOIN dvi_travels.dvi_states ts_city
    ON ts_city.id = tc.state_id
  LEFT JOIN dvi_main.dvi_permit_state ps_fallback
    ON ps_fallback.state_name = ts_city.name
   AND ps_fallback.deleted = 0
   AND ps_fallback.status = 1
  WHERE tv.deleted = 0
) fallback
  ON fallback.vendor_name = v.vendor_name
WHERE v.deleted = 0;

DROP TEMPORARY TABLE IF EXISTS tmp_travels_vendor_states;
CREATE TEMPORARY TABLE tmp_travels_vendor_states AS
SELECT
  tv.vendor_id,
  tv.vendor_name,
  tv.vendor_city,
  COALESCE(ps_city.permit_state_id, ps_state.permit_state_id) AS permit_state_id
FROM dvi_travels.dvi_vendor_details tv
LEFT JOIN dvi_travels.dvi_cities c
  ON c.id = tv.vendor_city
LEFT JOIN dvi_travels.dvi_states s_city
  ON s_city.id = c.state_id
LEFT JOIN dvi_main.dvi_permit_state ps_city
  ON ps_city.state_name = s_city.name
 AND ps_city.deleted = 0
 AND ps_city.status = 1
LEFT JOIN dvi_travels.dvi_states s_state
  ON s_state.id = tv.vendor_state
LEFT JOIN dvi_main.dvi_permit_state ps_state
  ON ps_state.state_name = s_state.name
 AND ps_state.deleted = 0
 AND ps_state.status = 1
WHERE tv.deleted = 0;

DROP TEMPORARY TABLE IF EXISTS tmp_matched_vendors;
CREATE TEMPORARY TABLE tmp_matched_vendors AS
SELECT
  ranked.main_vendor_id,
  ranked.main_vendor_name,
  ranked.main_permit_state_id,
  ranked.travels_vendor_id,
  ranked.travels_vendor_name,
  ranked.match_type
FROM (
  SELECT
    m.vendor_id AS main_vendor_id,
    m.vendor_name AS main_vendor_name,
    m.permit_state_id AS main_permit_state_id,
    t.vendor_id AS travels_vendor_id,
    t.vendor_name AS travels_vendor_name,
    CASE
      WHEN m.vendor_city <> 0 AND m.vendor_city = t.vendor_city THEN 'city'
      ELSE 'name'
    END AS match_type,
    ROW_NUMBER() OVER (
      PARTITION BY m.vendor_id
      ORDER BY CASE WHEN m.vendor_city <> 0 AND m.vendor_city = t.vendor_city THEN 1 ELSE 2 END, t.vendor_id
    ) AS rn
  FROM tmp_main_vendor_states m
  JOIN tmp_travels_vendor_states t
    ON (
      (m.vendor_city <> 0 AND m.vendor_city = t.vendor_city)
      OR (
        LOWER(REPLACE(REPLACE(TRIM(m.vendor_name), ' ', ''), '-', '')) =
        LOWER(REPLACE(REPLACE(TRIM(t.vendor_name), ' ', ''), '-', ''))
      )
    )
) ranked
WHERE ranked.rn = 1;

DROP TEMPORARY TABLE IF EXISTS tmp_mapped_permit_costs;
CREATE TEMPORARY TABLE tmp_mapped_permit_costs AS
SELECT
  mv.main_vendor_id AS vendor_id,
  mv.main_vendor_name AS vendor_name,
  mv.travels_vendor_id,
  mv.travels_vendor_name,
  mv.match_type,
  mtv.vendor_vehicle_type_ID AS target_vendor_vehicle_type_id,
  pc.source_state_id,
  pc.destination_state_id,
  pc.permit_cost,
  pc.createdby,
  pc.createdon,
  pc.updatedon,
  pc.status
FROM tmp_matched_vendors mv
JOIN dvi_travels.dvi_permit_cost pc
  ON pc.vendor_id = mv.travels_vendor_id
 AND pc.deleted = 0
 AND pc.status = 1
JOIN dvi_travels.dvi_vendor_vehicle_types tvvt
  ON tvvt.vendor_vehicle_type_ID = pc.vehicle_type_id
 AND tvvt.vendor_id = pc.vendor_id
 AND tvvt.deleted = 0
 AND tvvt.status = 1
JOIN dvi_main.dvi_vendor_vehicle_types mtv
  ON mtv.vendor_id = mv.main_vendor_id
 AND mtv.vehicle_type_id = tvvt.vehicle_type_id
 AND mtv.deleted = 0
 AND mtv.status = 1
;

START TRANSACTION;

UPDATE dvi_main.dvi_permit_cost target
JOIN tmp_mapped_permit_costs mapped
  ON target.vendor_id = mapped.vendor_id
 AND target.vehicle_type_id = mapped.target_vendor_vehicle_type_id
 AND target.source_state_id = mapped.source_state_id
 AND target.destination_state_id = mapped.destination_state_id
 AND target.deleted = 0
SET
  target.permit_cost = mapped.permit_cost,
  target.status = 1,
  target.deleted = 0,
  target.updatedon = NOW()
WHERE IFNULL(target.permit_cost, 0) <> IFNULL(mapped.permit_cost, 0);

INSERT INTO dvi_main.dvi_permit_cost (
  vendor_id,
  vehicle_type_id,
  source_state_id,
  destination_state_id,
  permit_cost,
  createdby,
  createdon,
  updatedon,
  status,
  deleted
)
SELECT
  mapped.vendor_id,
  mapped.target_vendor_vehicle_type_id,
  mapped.source_state_id,
  mapped.destination_state_id,
  mapped.permit_cost,
  mapped.createdby,
  COALESCE(mapped.createdon, NOW()),
  mapped.updatedon,
  1,
  0
FROM tmp_mapped_permit_costs mapped
LEFT JOIN dvi_main.dvi_permit_cost existing
  ON existing.vendor_id = mapped.vendor_id
 AND existing.vehicle_type_id = mapped.target_vendor_vehicle_type_id
 AND existing.source_state_id = mapped.source_state_id
 AND existing.destination_state_id = mapped.destination_state_id
 AND existing.deleted = 0
WHERE existing.permit_cost_id IS NULL;

COMMIT;

SELECT
  COUNT(*) AS total_mapped_rows,
  SUM(CASE WHEN existing.permit_cost_id IS NULL THEN 1 ELSE 0 END) AS missing_rows_after_sync,
  SUM(CASE WHEN existing.permit_cost_id IS NOT NULL AND IFNULL(existing.permit_cost, 0) <> IFNULL(mapped.permit_cost, 0) THEN 1 ELSE 0 END) AS remaining_cost_differences
FROM tmp_mapped_permit_costs mapped
LEFT JOIN dvi_main.dvi_permit_cost existing
  ON existing.vendor_id = mapped.vendor_id
 AND existing.vehicle_type_id = mapped.target_vendor_vehicle_type_id
 AND existing.source_state_id = mapped.source_state_id
 AND existing.destination_state_id = mapped.destination_state_id
 AND existing.deleted = 0;
