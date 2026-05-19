import { Prisma, PrismaClient } from '@prisma/client';
import { spawn } from 'node:child_process';
import { resolveHotspotTestIdsChennai } from './resolve-route-hotspot-test-ids-chennai';

const prisma = new PrismaClient();

type Slot = {
  fromId: number;
  toId: number;
  fromName: string;
  toName: string;
};

type Candidate = {
  id: number;
  name: string;
};

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommand(command: string, args: string[], env: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function summaryQuery(slots: Slot[], candidates: Candidate[]) {
  const fromIds = Array.from(new Set(slots.map((item) => item.fromId)));
  const toIds = Array.from(new Set(slots.map((item) => item.toId)));
  const candidateIds = Array.from(new Set(candidates.map((item) => item.id)));

  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT
      f.hotspot_name AS from_name,
      t.hotspot_name AS to_name,
      c.hotspot_name AS candidate_name,
      bm.route_fit_type,
      bm.road_detour_km,
      bm.road_detour_ratio,
      bm.ab_osrm_distance_km,
      bm.ac_osrm_distance_km,
      bm.cb_osrm_distance_km,
      bm.inserted_route_distance_km,
      bm.candidate_distance_from_ab_route_meters,
      bm.route_decision_reason
    FROM hotspot_route_between_map bm
    JOIN dvi_hotspot_place f ON f.hotspot_ID = bm.from_hotspot_id
    JOIN dvi_hotspot_place t ON t.hotspot_ID = bm.to_hotspot_id
    JOIN dvi_hotspot_place c ON c.hotspot_ID = bm.between_hotspot_id
    WHERE bm.from_hotspot_id IN (${Prisma.join(fromIds)})
      AND bm.to_hotspot_id IN (${Prisma.join(toIds)})
      AND bm.between_hotspot_id IN (${Prisma.join(candidateIds)})
    ORDER BY
      f.hotspot_name,
      t.hotspot_name,
      FIELD(bm.route_fit_type, 'ON_ROUTE', 'MINOR_DETOUR', 'BACKTRACK', 'OFF_ROUTE'),
      bm.road_detour_km ASC
  `);

  return rows;
}

async function matrixStatusQuery(slots: Slot[]) {
  if (!slots.length) return [];

  const pairConditions = slots
    .map((slot) => `(from_hotspot_id = ${slot.fromId} AND to_hotspot_id = ${slot.toId})`)
    .join(' OR ');

  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
    SELECT from_hotspot_id, to_hotspot_id, process_status, osrm_distance_km, osrm_duration_min
    FROM hotspot_route_matrix
    WHERE ${pairConditions}
    ORDER BY from_hotspot_id, to_hotspot_id
  `);
  return rows;
}

async function aurovilleFocusedQuery(slots: Slot[], candidates: Candidate[]) {
  const auroville = candidates.find((item) => item.name.toLowerCase().includes('auroville'));
  if (!auroville || !slots.length) return [];

  const pairConditions = slots
    .map((slot) => `(bm.from_hotspot_id = ${slot.fromId} AND bm.to_hotspot_id = ${slot.toId})`)
    .join(' OR ');

  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
    SELECT
      f.hotspot_name AS from_name,
      t.hotspot_name AS to_name,
      c.hotspot_name AS candidate_name,
      bm.route_fit_type,
      bm.road_detour_km,
      bm.road_detour_ratio,
      bm.route_decision_reason
    FROM hotspot_route_between_map bm
    JOIN dvi_hotspot_place f ON f.hotspot_ID = bm.from_hotspot_id
    JOIN dvi_hotspot_place t ON t.hotspot_ID = bm.to_hotspot_id
    JOIN dvi_hotspot_place c ON c.hotspot_ID = bm.between_hotspot_id
    WHERE bm.between_hotspot_id = ${auroville.id}
      AND (${pairConditions})
    ORDER BY f.hotspot_name, t.hotspot_name
  `);

  return rows;
}

async function main() {
  const resolved = await resolveHotspotTestIdsChennai();

  if (resolved.ambiguousNames.length) {
    console.error('Ambiguous names found. Resolve before running matrix generation.');
    for (const item of resolved.ambiguousNames) {
      console.error(`- ${item.inputName}`);
      for (const row of item.matches) {
        console.error(`  hotspot_ID=${row.hotspot_ID} hotspot_name="${row.hotspot_name ?? ''}"`);
      }
    }
    process.exitCode = 1;
    return;
  }

  if (resolved.unresolvedRequiredNames.length) {
    console.error('Unresolved required names found. Resolve before running matrix generation.');
    for (const name of resolved.unresolvedRequiredNames) {
      console.error(`- ${name}`);
    }
    process.exitCode = 1;
    return;
  }

  const slots: Slot[] = resolved.routeSlotsResolved.map((slot) => ({
    fromId: slot.from.hotspot_ID,
    toId: slot.to.hotspot_ID,
    fromName: slot.from.hotspot_name,
    toName: slot.to.hotspot_name,
  }));

  const candidates: Candidate[] = resolved.candidatesResolved.map((item) => ({
    id: item.hotspot_ID,
    name: item.hotspot_name,
  }));

  const osrmBaseUrl = (process.env.OSRM_BASE_URL || 'http://localhost:5000/route/v1/driving').toLowerCase();
  const isPublicOsrm = osrmBaseUrl.includes('router.project-osrm.org');
  const delayMs = isPublicOsrm ? 1200 : 200;

  let totalAttempted = 0;
  let totalSuccessful = 0;
  let totalFailed = 0;

  const totalSlots = slots.length;
  const totalCandidates = candidates.length;

  for (let slotIndex = 0; slotIndex < totalSlots; slotIndex += 1) {
    const slot = slots[slotIndex];

    for (let candidateIndex = 0; candidateIndex < totalCandidates; candidateIndex += 1) {
      const candidate = candidates[candidateIndex];

      if (candidate.id === slot.fromId || candidate.id === slot.toId) {
        continue;
      }

      totalAttempted += 1;

      console.log(
        `[slot ${slotIndex + 1}/${totalSlots} candidate ${candidateIndex + 1}/${totalCandidates}] ${slot.fromName} -> ${slot.toName} via ${candidate.name}`,
      );

      const exitCode = await runCommand(
        'npx',
        ['tsx', '--no-cache', 'scripts/build-hotspot-route-matrix.ts', '--apply', '--limit=1', '--rebuild-done'],
        {
          FROM_HOTSPOT_ID: String(slot.fromId),
          TO_HOTSPOT_ID: String(slot.toId),
          BETWEEN_HOTSPOT_ID: String(candidate.id),
          MAX_PAIR_HAVERSINE_KM: '250',
        },
      );

      if (exitCode === 0) {
        totalSuccessful += 1;
      } else {
        totalFailed += 1;
      }

      await sleep(delayMs);
    }
  }

  const summaryRows = await summaryQuery(slots, candidates);
  const matrixRows = await matrixStatusQuery(slots);
  const aurovilleRows = await aurovilleFocusedQuery(slots, candidates);

  const routeFitCounts = summaryRows.reduce<Record<string, number>>((acc, row) => {
    const key = String(row.route_fit_type ?? 'UNKNOWN');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  console.log('\nResolved Route Slot IDs:');
  for (const slot of slots) {
    console.log(`- ${slot.fromName} (${slot.fromId}) -> ${slot.toName} (${slot.toId})`);
  }

  console.log('\nResolved Candidate IDs:');
  for (const candidate of candidates) {
    console.log(`- ${candidate.name} (${candidate.id})`);
  }

  console.log('\nExecution Counters:');
  console.log(
    JSON.stringify(
      {
        totalAttempted,
        totalSuccessful,
        totalFailed,
        routeFitCounts,
      },
      null,
      2,
    ),
  );

  console.log('\nMatrix Status (slot pairs):');
  console.log(JSON.stringify(matrixRows, null, 2));

  console.log('\nSummary Query Rows:');
  console.log(JSON.stringify(summaryRows, null, 2));

  console.log('\nAuroville Focused Rows:');
  console.log(JSON.stringify(aurovilleRows, null, 2));
}

main()
  .catch((error) => {
    console.error('Failed running Chennai hotspot fit test matrix:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
