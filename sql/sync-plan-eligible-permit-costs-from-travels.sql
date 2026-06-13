SET @plan_id := 9599;

-- Build the exact local permit profiles needed for this plan from active eligible vehicles.
-- Each profile is keyed by:
--   - local vendor
--   - local vendor vehicle type (vendor_vehicle_type_id)
--   - base vehicle type
--   - source permit state derived from the vehicle registration prefix
DROP TEMPORARY TABLE IF EXISTS tmp_scoped_eligible_permit_profiles;
CREATE TEMPORARY TABLE tmp_scoped_eligible_permit_profiles AS
SELECT DISTINCT
  el.vendor_id AS target_vendor_id,
  el.vendor_vehicle_type_id AS target_vendor_vehicle_type_id,
  mtv.vehicle_type_id AS target_base_vehicle_type_id,
  LOWER(REPLACE(REPLACE(TRIM(vd.vendor_name), ' ', ''), '-', '')) AS target_vendor_name_key,
  vd.vendor_city AS target_vendor_city,
  src_main.permit_state_id AS target_source_state_id,
  src_main.state_code AS target_source_state_code,
  src_main.state_name AS target_source_state_name
FROM dvi_main.dvi_itinerary_plan_vendor_eligible_list el
JOIN dvi_main.dvi_vehicle v
  ON v.vehicle_id = el.vehicle_id
JOIN dvi_main.dvi_vendor_vehicle_types mtv
  ON mtv.vendor_vehicle_type_ID = el.vendor_vehicle_type_id
 AND mtv.vendor_id = el.vendor_id
 AND mtv.status = 1
 AND mtv.deleted = 0
JOIN dvi_main.dvi_vendor_details vd
  ON vd.vendor_id = el.vendor_id
 AND vd.deleted = 0
JOIN dvi_main.dvi_permit_state src_main
  ON src_main.state_code = UPPER(SUBSTRING(TRIM(v.registration_number), 1, 2))
 AND src_main.status = 1
 AND src_main.deleted = 0
WHERE el.itinerary_plan_id = @plan_id
  AND el.status = 1
  AND el.deleted = 0;

-- Collect all active legacy permit-cost templates and map their source/destination states
-- into dvi_main permit_state IDs using:
--   1. state_code match first
--   2. state_name fallback
DROP TEMPORARY TABLE IF EXISTS tmp_source_permit_templates;
CREATE TEMPORARY TABLE tmp_source_permit_templates AS
SELECT
  pc.vendor_id AS source_vendor_id,
  LOWER(REPLACE(REPLACE(TRIM(vd.vendor_name), ' ', ''), '-', '')) AS source_vendor_name_key,
  vd.vendor_city AS source_vendor_city,
  tvvt.vehicle_type_id AS source_base_vehicle_type_id,
  src_travel.state_code AS source_state_code,
  src_main.permit_state_id AS mapped_source_state_id,
  dst_main.permit_state_id AS mapped_destination_state_id,
  dst_travel.state_code AS destination_state_code,
  dst_travel.state_name AS destination_state_name,
  pc.permit_cost,
  pc.createdby,
  pc.createdon,
  pc.updatedon
FROM dvi_travels.dvi_permit_cost pc
JOIN dvi_travels.dvi_vendor_vehicle_types tvvt
  ON tvvt.vendor_vehicle_type_ID = pc.vehicle_type_id
 AND tvvt.vendor_id = pc.vendor_id
 AND tvvt.status = 1
 AND tvvt.deleted = 0
JOIN dvi_travels.dvi_vendor_details vd
  ON vd.vendor_id = pc.vendor_id
 AND vd.deleted = 0
JOIN dvi_travels.dvi_permit_state src_travel
  ON src_travel.permit_state_id = pc.source_state_id
 AND src_travel.status = 1
 AND src_travel.deleted = 0
JOIN dvi_travels.dvi_permit_state dst_travel
  ON dst_travel.permit_state_id = pc.destination_state_id
 AND dst_travel.status = 1
 AND dst_travel.deleted = 0
JOIN dvi_main.dvi_permit_state src_main
  ON (
    (src_main.state_code <> '' AND src_main.state_code = src_travel.state_code)
    OR LOWER(TRIM(src_main.state_name)) = LOWER(TRIM(src_travel.state_name))
  )
 AND src_main.status = 1
 AND src_main.deleted = 0
JOIN dvi_main.dvi_permit_state dst_main
  ON (
    (dst_main.state_code <> '' AND dst_main.state_code = dst_travel.state_code)
    OR LOWER(TRIM(dst_main.state_name)) = LOWER(TRIM(dst_travel.state_name))
  )
 AND dst_main.status = 1
 AND dst_main.deleted = 0
WHERE pc.status = 1
  AND pc.deleted = 0;

-- Rank candidate legacy templates for each local plan-driven permit profile.
-- Fallback priority:
--   1. same normalized vendor name in dvi_travels
--   2. same vendor city in dvi_travels
--   3. any other active legacy vendor with the same source state and base vehicle type
-- This keeps the script reusable when a local vendor does not exist in dvi_travels
-- but another legacy template is still a valid source-state/base-type match.
DROP TEMPORARY TABLE IF EXISTS tmp_ranked_legacy_templates;
CREATE TEMPORARY TABLE tmp_ranked_legacy_templates AS
SELECT
  se.target_vendor_id,
  se.target_vendor_vehicle_type_id,
  se.target_base_vehicle_type_id,
  se.target_source_state_id,
  se.target_source_state_code,
  st.mapped_destination_state_id AS target_destination_state_id,
  st.destination_state_code,
  st.destination_state_name,
  st.permit_cost,
  st.createdby,
  st.createdon,
  st.updatedon,
  st.source_vendor_id AS template_vendor_id,
  ROW_NUMBER() OVER (
    PARTITION BY
      se.target_vendor_id,
      se.target_vendor_vehicle_type_id,
      se.target_source_state_id,
      st.mapped_destination_state_id
    ORDER BY
      CASE
        WHEN st.source_vendor_name_key = se.target_vendor_name_key THEN 1
        WHEN se.target_vendor_city <> 0 AND st.source_vendor_city = se.target_vendor_city THEN 2
        ELSE 3
      END,
      st.source_vendor_id
  ) AS rn
FROM tmp_scoped_eligible_permit_profiles se
JOIN tmp_source_permit_templates st
  ON st.source_base_vehicle_type_id = se.target_base_vehicle_type_id
 AND st.source_state_code = se.target_source_state_code
 AND st.mapped_source_state_id = se.target_source_state_id;

-- Keep only the best-ranked legacy template per local vendor/type/source-state/destination-state.
DROP TEMPORARY TABLE IF EXISTS tmp_selected_legacy_permit_rows;
CREATE TEMPORARY TABLE tmp_selected_legacy_permit_rows AS
SELECT
  target_vendor_id,
  target_vendor_vehicle_type_id,
  target_source_state_id,
  target_source_state_code,
  target_destination_state_id,
  destination_state_code,
  destination_state_name,
  permit_cost,
  createdby,
  createdon,
  updatedon,
  template_vendor_id
FROM tmp_ranked_legacy_templates
WHERE rn = 1;

-- Dry-run: show which active permit-cost rows are still missing in dvi_main for this plan.
-- Safe to run repeatedly; after a successful sync this result should be empty.
SELECT
  selected.target_vendor_id AS vendor_id,
  selected.target_vendor_vehicle_type_id AS vehicle_type_id,
  selected.target_source_state_code AS source_state_code,
  selected.destination_state_code,
  selected.destination_state_name,
  selected.permit_cost,
  selected.template_vendor_id
FROM tmp_selected_legacy_permit_rows selected
LEFT JOIN dvi_main.dvi_permit_cost existing
  ON existing.vendor_id = selected.target_vendor_id
 AND existing.vehicle_type_id = selected.target_vendor_vehicle_type_id
 AND existing.source_state_id = selected.target_source_state_id
 AND existing.destination_state_id = selected.target_destination_state_id
 AND existing.status = 1
 AND existing.deleted = 0
WHERE existing.permit_cost_id IS NULL
ORDER BY
  selected.target_vendor_id,
  selected.target_vendor_vehicle_type_id,
  selected.destination_state_code;

-- Apply only the missing rows. Existing active rows are left untouched, so this script
-- is safe to run multiple times without duplicating permit-cost records.
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
  selected.target_vendor_id,
  selected.target_vendor_vehicle_type_id,
  selected.target_source_state_id,
  selected.target_destination_state_id,
  selected.permit_cost,
  selected.createdby,
  COALESCE(selected.createdon, NOW()),
  selected.updatedon,
  1,
  0
FROM tmp_selected_legacy_permit_rows selected
LEFT JOIN dvi_main.dvi_permit_cost existing
  ON existing.vendor_id = selected.target_vendor_id
 AND existing.vehicle_type_id = selected.target_vendor_vehicle_type_id
 AND existing.source_state_id = selected.target_source_state_id
 AND existing.destination_state_id = selected.target_destination_state_id
 AND existing.status = 1
 AND existing.deleted = 0
WHERE existing.permit_cost_id IS NULL;
