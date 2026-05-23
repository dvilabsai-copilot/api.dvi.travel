#!/usr/bin/env node
/*
  API-only manual hotspot add test for day 1/2/3.

  Usage:
    node scripts/test-hotspot-add-api-only.js --quote DVI20260589

  Optional env:
    API_BASE_URL=http://127.0.0.1:4006/api/v1
    DVI_EMAIL=admin@dvi.co.in
    DVI_PASSWORD=***
*/

function parseArgs(argv) {
  const out = { quote: 'DVI20260589' };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--quote' && argv[i + 1]) {
      out.quote = String(argv[i + 1]).trim();
      i += 1;
    }
  }
  return out;
}

function normalize(v) {
  return String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

async function loginAndGetToken(apiBase, email, password) {
  const url = `${apiBase.replace(/\/$/, '')}/auth/login`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  const payload = await resp.json().catch(() => null);
  const token = payload?.data?.accessToken || payload?.accessToken || null;
  if (!token) {
    throw new Error(`Auth failed. status=${resp.status}`);
  }
  return token;
}

async function run() {
  const args = parseArgs(process.argv);
  const apiBase = String(process.env.API_BASE_URL || 'http://127.0.0.1:4006/api/v1').trim();
  const email = String(process.env.DVI_EMAIL || 'admin@dvi.co.in').trim();
  const password = String(process.env.DVI_PASSWORD || 'Keerthi@2404ias').trim();

  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  const result = {
    ok: false,
    mode: 'api-only',
    quote: args.quote,
    apiBase,
    latestPlanId: null,
    days: [],
    matrix: [],
  };

  try {
    const token = await loginAndGetToken(apiBase, email, password);

    const planRows = await prisma.$queryRawUnsafe(`
      SELECT itinerary_plan_ID
      FROM dvi_itinerary_plan_details
      WHERE itinerary_quote_ID = ?
      ORDER BY itinerary_plan_ID DESC
      LIMIT 1
    `, args.quote);

    const planId = Number(planRows?.[0]?.itinerary_plan_ID || 0) || null;
    result.latestPlanId = planId;
    if (!planId) throw new Error('No plan found');

    const routeRows = await prisma.$queryRawUnsafe(`
      SELECT itinerary_route_ID
      FROM dvi_itinerary_route_details
      WHERE itinerary_plan_ID = ? AND status = 1 AND deleted = 0
      ORDER BY itinerary_route_date ASC, itinerary_route_ID ASC
    `, planId);

    const routeIds = (Array.isArray(routeRows) ? routeRows : []).map((r) => Number(r?.itinerary_route_ID || 0));

    for (const day of [1, 2, 3]) {
      const row = {
        day,
        routeId: routeIds[day - 1] || null,
        hotspotId: null,
        hotspotName: null,
        previewStatus: null,
        previewCode: null,
        previewOk: false,
        applyStatus: null,
        applyCode: null,
        applyOk: false,
        dbInsertedCount: 0,
        dbInserted: false,
        status: 'failed',
        error: null,
      };

      try {
        if (!row.routeId) throw new Error('Missing route for day');

        const candidates = await prisma.$queryRawUnsafe(`
          SELECT h.hotspot_ID, p.hotspot_name, h.route_hotspot_ID
          FROM dvi_itinerary_route_hotspot_details h
          LEFT JOIN dvi_hotspot_place p ON p.hotspot_ID = h.hotspot_ID
          WHERE h.itinerary_plan_ID = ?
            AND h.itinerary_route_ID = ?
            AND h.item_type = 4
            AND h.deleted = 0
          ORDER BY h.hotspot_order DESC, h.route_hotspot_ID DESC
          LIMIT 20
        `, planId, Number(row.routeId));

        const selected = (Array.isArray(candidates) ? candidates : []).find((c) => Number(c?.hotspot_ID || 0) > 0);
        if (!selected) {
          throw new Error('No existing route hotspot candidate found to re-add');
        }

        const hotspotId = Number(selected.hotspot_ID);
        const hotspotName = String(selected.hotspot_name || '').trim();
        row.hotspotId = hotspotId;
        row.hotspotName = hotspotName;

        const existingRows = await prisma.$queryRawUnsafe(`
          SELECT route_hotspot_ID
          FROM dvi_itinerary_route_hotspot_details
          WHERE itinerary_plan_ID = ?
            AND itinerary_route_ID = ?
            AND hotspot_ID = ?
            AND item_type = 4
            AND deleted = 0
        `, planId, Number(row.routeId), hotspotId);

        const existingIds = (Array.isArray(existingRows) ? existingRows : [])
          .map((r) => Number(r?.route_hotspot_ID || 0))
          .filter((id) => Number.isFinite(id) && id > 0);

        if (existingIds.length > 0) {
          await prisma.$queryRawUnsafe(`
            DELETE FROM dvi_itinerary_route_activity_details
            WHERE itinerary_plan_ID = ?
              AND itinerary_route_ID = ?
              AND route_hotspot_ID IN (${existingIds.join(',')})
          `, planId, Number(row.routeId));

          await prisma.$queryRawUnsafe(`
            DELETE FROM dvi_itinerary_route_hotspot_details
            WHERE itinerary_plan_ID = ?
              AND itinerary_route_ID = ?
              AND hotspot_ID = ?
              AND item_type = 4
              AND deleted = 0
          `, planId, Number(row.routeId), hotspotId);
        }

        const previewResp = await fetch(`${apiBase.replace(/\/$/, '')}/itineraries/${planId}/manual-hotspot/preview`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ routeId: row.routeId, hotspotId }),
        });

        const previewPayload = await previewResp.json().catch(() => null);
        row.previewStatus = previewResp.status;
        row.previewCode = previewPayload?.code || null;
        row.previewOk = previewResp.ok || previewPayload?.success === true || !!previewPayload?.code;

        const applyResp = await fetch(`${apiBase.replace(/\/$/, '')}/itineraries/${planId}/manual-hotspots/apply`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ routeId: row.routeId, hotspotIds: [hotspotId], forceConflictInsertion: true }),
        });

        const applyPayload = await applyResp.json().catch(() => null);
        row.applyStatus = applyResp.status;
        row.applyCode = applyPayload?.code || null;
        row.applyOk = applyResp.ok || applyPayload?.success === true;

        if (!row.applyOk) {
          throw new Error(`apply failed for hotspot ${hotspotId}`);
        }

        const dbRows = await prisma.$queryRawUnsafe(`
          SELECT COUNT(*) AS c
          FROM dvi_itinerary_route_hotspot_details
          WHERE itinerary_plan_ID = ?
            AND itinerary_route_ID = ?
            AND hotspot_ID = ?
            AND item_type = 4
            AND deleted = 0
        `, planId, Number(row.routeId), hotspotId);

        row.dbInsertedCount = Number(dbRows?.[0]?.c || 0);
        row.dbInserted = row.dbInsertedCount > 0;

        if (!row.dbInserted) {
          throw new Error(`db insert not detected for hotspot ${hotspotId}`);
        }

        row.status = (row.previewOk && row.applyOk && row.dbInserted) ? 'passed' : 'failed';
      } catch (e) {
        row.error = e?.message || String(e);
      }

      result.days.push(row);
    }

    result.ok = result.days.every((d) => d.status === 'passed');
    result.matrix = result.days.map((d) => ({
      day: d.day,
      routeId: d.routeId,
      hotspotId: d.hotspotId,
      hotspotName: d.hotspotName,
      previewOk: d.previewOk,
      previewCode: d.previewCode,
      applyOk: d.applyOk,
      applyCode: d.applyCode,
      dbInserted: d.dbInserted,
      dbInsertedCount: d.dbInsertedCount,
      status: d.status,
    }));

    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

run().catch((err) => {
  console.error('API_ONLY_TEST_FAILED');
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
