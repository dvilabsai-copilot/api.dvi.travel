import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

type RouteFitType = 'ON_ROUTE' | 'MINOR_DETOUR' | 'BACKTRACK' | 'OFF_ROUTE' | 'UNKNOWN';

type RouteHotspot = {
  hotspotId: number;
  hotspotOrder: number;
  hotspotName: string;
};

type MatrixRow = {
  from_hotspot_id: number;
  to_hotspot_id: number;
  between_hotspot_id: number;
  route_fit_type: string | null;
  route_decision_reason: string | null;
  road_detour_km: number | null;
  road_detour_ratio: number | null;
  candidate_distance_from_ab_route_meters: number | null;
};

const prisma = new PrismaClient();

function toInt(raw: string | undefined, fallback = 0): number {
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) return n;
  return fallback;
}

function parseArgs(): { routeId: number; candidateHotspotId: number } {
  const args = process.argv.slice(2);
  const out: Record<string, string> = {};

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith('--')) continue;

    if (token.includes('=')) {
      const [k, v] = token.slice(2).split('=', 2);
      out[k] = String(v || '').trim();
      continue;
    }

    const key = token.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = String(next).trim();
      i += 1;
    }
  }

  const routeId = toInt(out.routeId || process.env.ROUTE_ID, 0);
  const candidateHotspotId = toInt(out.candidateHotspotId || process.env.CANDIDATE_HOTSPOT_ID, 0);

  if (!routeId || !candidateHotspotId) {
    throw new Error('Usage: npx tsx scripts/debug-manual-hotspot-insertion-gaps.ts --routeId <id> --candidateHotspotId <id>');
  }

  return { routeId, candidateHotspotId };
}

function normalizeFitType(raw: string | null | undefined): RouteFitType {
  const t = String(raw || '').toUpperCase();
  if (t === 'ON_ROUTE' || t === 'MINOR_DETOUR' || t === 'BACKTRACK' || t === 'OFF_ROUTE') return t;
  return 'UNKNOWN';
}

function fitRank(type: RouteFitType): number {
  if (type === 'ON_ROUTE') return 1;
  if (type === 'MINOR_DETOUR') return 2;
  if (type === 'BACKTRACK') return 3;
  if (type === 'OFF_ROUTE') return 4;
  return 5;
}

function safeNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const { routeId, candidateHotspotId } = parseArgs();

  const routeRows = await (prisma as any).dvi_itinerary_route_hotspot_details.findMany({
    where: {
      itinerary_route_ID: Number(routeId),
      item_type: 4,
      deleted: 0,
      status: 1,
    },
    orderBy: { hotspot_order: 'asc' },
    select: {
      hotspot_ID: true,
      hotspot_order: true,
    },
  });

  const baselineHotspotIds = (routeRows as any[])
    .map((r) => Number(r.hotspot_ID || 0))
    .filter((id) => id > 0 && id !== Number(candidateHotspotId));

  const uniqueIds = Array.from(new Set([...baselineHotspotIds, Number(candidateHotspotId)]));

  const hotspotMasters = await (prisma as any).dvi_hotspot_place.findMany({
    where: {
      hotspot_ID: { in: uniqueIds },
      deleted: 0,
    },
    select: {
      hotspot_ID: true,
      hotspot_name: true,
    },
  });

  const nameById = new Map<number, string>(
    (hotspotMasters as any[]).map((m) => [Number(m.hotspot_ID || 0), String(m.hotspot_name || '')]),
  );

  const ordered: RouteHotspot[] = baselineHotspotIds.map((id, idx) => ({
    hotspotId: id,
    hotspotOrder: Number((routeRows[idx] as any)?.hotspot_order || idx + 1),
    hotspotName: nameById.get(id) || `Hotspot #${id}`,
  }));

  const candidateName = nameById.get(Number(candidateHotspotId)) || `Hotspot #${candidateHotspotId}`;

  console.log('Manual Hotspot Insertion Gap Diagnostic');
  console.log('-------------------------------------');
  console.log(`routeId=${routeId}`);
  console.log(`candidateHotspotId=${candidateHotspotId} (${candidateName})`);
  console.log('');

  if (ordered.length < 2) {
    console.log('Not enough baseline hotspots to build hotspot-to-hotspot insertion gaps.');
    console.log(`baselineHotspots=${ordered.length}`);
    return;
  }

  console.log('Baseline route hotspot chain (candidate excluded):');
  for (const hs of ordered) {
    console.log(`  order=${hs.hotspotOrder} id=${hs.hotspotId} name=${hs.hotspotName}`);
  }
  console.log('');

  type GapResult = {
    slotIndex: number;
    anchorIndex: number;
    fromId: number;
    toId: number;
    fromName: string;
    toName: string;
    fitType: RouteFitType;
    detourKm: number | null;
    detourRatio: number | null;
    distFromRouteM: number | null;
    reason: string | null;
    hasMatrixRow: boolean;
  };

  const gaps: GapResult[] = [];

  for (let i = 0; i < ordered.length - 1; i += 1) {
    const from = ordered[i];
    const to = ordered[i + 1];

    const rows = await (prisma as any).$queryRawUnsafe(
      `
      SELECT
        from_hotspot_id,
        to_hotspot_id,
        between_hotspot_id,
        route_fit_type,
        route_decision_reason,
        road_detour_km,
        road_detour_ratio,
        candidate_distance_from_ab_route_meters
      FROM hotspot_route_between_map
      WHERE (
        (from_hotspot_id = ? AND to_hotspot_id = ? AND between_hotspot_id = ?)
        OR
        (from_hotspot_id = ? AND to_hotspot_id = ? AND between_hotspot_id = ?)
      )
      LIMIT 1
      `,
      Number(from.hotspotId),
      Number(to.hotspotId),
      Number(candidateHotspotId),
      Number(to.hotspotId),
      Number(from.hotspotId),
      Number(candidateHotspotId),
    ) as MatrixRow[];

    const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    const fitType = normalizeFitType(row?.route_fit_type);

    gaps.push({
      slotIndex: i,
      anchorIndex: i + 1,
      fromId: from.hotspotId,
      toId: to.hotspotId,
      fromName: from.hotspotName,
      toName: to.hotspotName,
      fitType,
      detourKm: safeNum(row?.road_detour_km),
      detourRatio: safeNum(row?.road_detour_ratio),
      distFromRouteM: safeNum(row?.candidate_distance_from_ab_route_meters),
      reason: row?.route_decision_reason ?? null,
      hasMatrixRow: !!row,
    });
  }

  const usable = gaps.filter((g) => g.fitType !== 'UNKNOWN');
  const feasible = gaps.filter((g) => g.fitType === 'ON_ROUTE' || g.fitType === 'MINOR_DETOUR');

  const sorted = [...usable].sort((a, b) => {
    const rankDiff = fitRank(a.fitType) - fitRank(b.fitType);
    if (rankDiff !== 0) return rankDiff;

    const da = a.detourKm ?? 99999;
    const db = b.detourKm ?? 99999;
    if (da !== db) return da - db;

    const ra = a.detourRatio ?? 99999;
    const rb = b.detourRatio ?? 99999;
    if (ra !== rb) return ra - rb;

    const xa = a.distFromRouteM ?? 99999;
    const xb = b.distFromRouteM ?? 99999;
    return xa - xb;
  });

  const best = sorted.length > 0 ? sorted[0] : null;

  console.log('Gap-by-gap matrix lookup:');
  for (const g of gaps) {
    const detourText = g.detourKm == null ? 'n/a' : g.detourKm.toFixed(3);
    const ratioText = g.detourRatio == null ? 'n/a' : g.detourRatio.toFixed(3);
    const distText = g.distFromRouteM == null ? 'n/a' : g.distFromRouteM.toFixed(1);
    console.log(
      [
        `  slotIndex=${g.slotIndex}`,
        `anchorIndex=${g.anchorIndex}`,
        `from=${g.fromName} (${g.fromId})`,
        `to=${g.toName} (${g.toId})`,
        `fitType=${g.fitType}`,
        `matrix=${g.hasMatrixRow ? 'YES' : 'NO'}`,
        `detourKm=${detourText}`,
        `detourRatio=${ratioText}`,
        `distFromRouteM=${distText}`,
      ].join(' | '),
    );
    if (g.reason) {
      console.log(`    reason: ${g.reason}`);
    }
  }

  console.log('');
  console.log('Summary:');
  console.log(`  hasAnyMatrixData=${usable.length > 0}`);
  console.log(`  hasFeasibleMatrixSlot=${feasible.length > 0}`);

  if (!best) {
    console.log('  bestSlot=NONE (matrix data missing across all hotspot-to-hotspot gaps)');
  } else {
    console.log(
      `  bestSlot=slotIndex ${best.slotIndex} (anchorIndex ${best.anchorIndex}) | ${best.fromName} -> ${best.toName} | fitType=${best.fitType}`,
    );
  }

  if (best && (best.fitType === 'ON_ROUTE' || best.fitType === 'MINOR_DETOUR')) {
    console.log('  backendWouldRequireMatrixBuild=false');
  } else {
    console.log('  backendWouldRequireMatrixBuild=true (or no feasible slot)');
  }

  console.log('');
  console.log('Note: anchorIndex=0 is hotel/source segment and is not evaluated by hotspot_route_between_map.');
}

main()
  .catch((err) => {
    console.error('Script failed:', err?.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
