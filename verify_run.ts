import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const m1 = await prisma.SELECT process_status, osrm_distance_km, osrm_duration_min FROM hotspot_road_matrix WHERE from_hotspot_id = 228 AND to_hotspot_id = 218;
  const m2 = await prisma.SELECT process_status, osrm_distance_km, osrm_duration_min FROM hotspot_road_matrix WHERE from_hotspot_id = 218 AND to_hotspot_id = 220;
  const b1 = await prisma.SELECT route_fit_type, road_detour_km, road_detour_ratio, ac_osrm_distance_km, cb_osrm_distance_km, ab_osrm_distance_km, route_decision_reason FROM hotspot_between_road_matrix WHERE from_hotspot_id = 228 AND to_hotspot_id = 218 AND between_hotspot_id = 219;
  const b2 = await prisma.SELECT route_fit_type, road_detour_km, road_detour_ratio, ac_osrm_distance_km, cb_osrm_distance_km, ab_osrm_distance_km, route_decision_reason FROM hotspot_between_road_matrix WHERE from_hotspot_id = 218 AND to_hotspot_id = 220 AND between_hotspot_id = 219;
  console.log(JSON.stringify({
    matrix_228_218: m1[0] || 'No rows found',
    matrix_218_220: m2[0] || 'No rows found',
    between_228_218_219: b1[0] || 'No rows found',
    between_218_220_219: b2[0] || 'No rows found'
  }, (key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
}
main().catch(err => { console.error(err); process.exit(1); }).finally(() => prisma.());
