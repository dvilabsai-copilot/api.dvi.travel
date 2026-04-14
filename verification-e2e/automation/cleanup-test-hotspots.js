const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const OUT_DIR = path.join(process.cwd(), 'verification-e2e', 'automation', 'artifacts');
const mode = process.argv.includes('--apply') ? 'apply' : 'dry-run';

const explicitNames = [
  'Live Hotspot 1775515744963',
  'PW Timing Persist 1775727492729',
  'Live Retry Hotspot 1775515791348',
  'PW Hotspot 1775516207450',
  'PW Hotspot 1775516310053',
  'PW Hotspot 1775516882039',
];

const whereSql = `
  deleted = 0
  AND (
    hotspot_name IN (${explicitNames.map(() => '?').join(',')})
    OR hotspot_name REGEXP '^(PW|Playwright|Live (Hotspot|Retry Hotspot))'
    OR hotspot_name LIKE '%Click to Add Hotspot%'
    OR hotspot_name REGEXP '^[[:space:]]*$'
    OR hotspot_name IS NULL
    OR hotspot_name = ''
  )
`;

const tables = {
  hotspot: 'dvi_hotspot_place',
  timing: 'dvi_hotspot_timing',
  gallery: 'dvi_hotspot_gallery_details',
  parking: 'dvi_hotspot_vehicle_parking_charges',
  activity: 'dvi_activity',
  activityGallery: 'dvi_activity_image_gallery_details',
  activityPriceBook: 'dvi_activity_pricebook',
  activityReview: 'dvi_activity_review_details',
  activitySlot: 'dvi_activity_time_slot_details',
};

async function fetchCandidates(conn) {
  const [rows] = await conn.query(
    `SELECT hotspot_ID, hotspot_name, hotspot_priority, status, deleted, createdby, createdon, updatedon
     FROM ${tables.hotspot}
     WHERE ${whereSql}
     ORDER BY hotspot_ID`,
    explicitNames,
  );
  return rows;
}

async function dependencyCounts(conn, hotspotIds) {
  if (!hotspotIds.length) {
    return {
      timing: [],
      gallery: [],
      parking: [],
      activity: [],
      activityGallery: [],
      activityPriceBook: [],
      activityReview: [],
      activitySlot: [],
    };
  }

  const [timing] = await conn.query(
    `SELECT hotspot_ID, COUNT(*) AS count
     FROM ${tables.timing}
     WHERE deleted = 0 AND hotspot_ID IN (?)
     GROUP BY hotspot_ID`,
    [hotspotIds],
  );

  const [gallery] = await conn.query(
    `SELECT hotspot_ID, COUNT(*) AS count
     FROM ${tables.gallery}
     WHERE deleted = 0 AND hotspot_ID IN (?)
     GROUP BY hotspot_ID`,
    [hotspotIds],
  );

  const [parking] = await conn.query(
    `SELECT hotspot_id AS hotspot_ID, COUNT(*) AS count
     FROM ${tables.parking}
     WHERE deleted = 0 AND hotspot_id IN (?)
     GROUP BY hotspot_id`,
    [hotspotIds],
  );

  const [activity] = await conn.query(
    `SELECT activity_id, hotspot_id AS hotspot_ID
     FROM ${tables.activity}
     WHERE deleted = 0 AND hotspot_id IN (?)`,
    [hotspotIds],
  );

  const activityIds = activity.map((r) => Number(r.activity_id)).filter(Boolean);

  let activityGallery = [];
  let activityPriceBook = [];
  let activityReview = [];
  let activitySlot = [];

  if (activityIds.length) {
    [activityGallery] = await conn.query(
      `SELECT activity_id, COUNT(*) AS count
       FROM ${tables.activityGallery}
       WHERE deleted = 0 AND activity_id IN (?)
       GROUP BY activity_id`,
      [activityIds],
    );

    [activityPriceBook] = await conn.query(
      `SELECT activity_id, COUNT(*) AS count
       FROM ${tables.activityPriceBook}
       WHERE deleted = 0 AND activity_id IN (?)
       GROUP BY activity_id`,
      [activityIds],
    );

    [activityReview] = await conn.query(
      `SELECT activity_id, COUNT(*) AS count
       FROM ${tables.activityReview}
       WHERE deleted = 0 AND activity_id IN (?)
       GROUP BY activity_id`,
      [activityIds],
    );

    [activitySlot] = await conn.query(
      `SELECT activity_id, COUNT(*) AS count
       FROM ${tables.activitySlot}
       WHERE deleted = 0 AND activity_id IN (?)
       GROUP BY activity_id`,
      [activityIds],
    );
  }

  return {
    timing,
    gallery,
    parking,
    activity,
    activityGallery,
    activityPriceBook,
    activityReview,
    activitySlot,
  };
}

async function softDeleteAll(conn, hotspotIds, activityIds) {
  const result = {
    hotspotRows: 0,
    timingRows: 0,
    galleryRows: 0,
    parkingRows: 0,
    activityRows: 0,
    activityGalleryRows: 0,
    activityPriceBookRows: 0,
    activityReviewRows: 0,
    activitySlotRows: 0,
  };

  if (!hotspotIds.length) return result;

  const now = new Date();

  const [timing] = await conn.query(
    `UPDATE ${tables.timing}
     SET deleted = 1, status = 0, updatedon = ?
     WHERE deleted = 0 AND hotspot_ID IN (?)`,
    [now, hotspotIds],
  );
  result.timingRows = timing.affectedRows || 0;

  const [gallery] = await conn.query(
    `UPDATE ${tables.gallery}
     SET deleted = 1, status = 0, updatedon = ?
     WHERE deleted = 0 AND hotspot_ID IN (?)`,
    [now, hotspotIds],
  );
  result.galleryRows = gallery.affectedRows || 0;

  const [parking] = await conn.query(
    `UPDATE ${tables.parking}
     SET deleted = 1, status = 0, updatedon = ?
     WHERE deleted = 0 AND hotspot_id IN (?)`,
    [now, hotspotIds],
  );
  result.parkingRows = parking.affectedRows || 0;

  if (activityIds.length) {
    const [activityGallery] = await conn.query(
      `UPDATE ${tables.activityGallery}
       SET deleted = 1, status = 0, updatedon = ?
       WHERE deleted = 0 AND activity_id IN (?)`,
      [now, activityIds],
    );
    result.activityGalleryRows = activityGallery.affectedRows || 0;

    const [activityPriceBook] = await conn.query(
      `UPDATE ${tables.activityPriceBook}
       SET deleted = 1, status = 0, updatedon = ?
       WHERE deleted = 0 AND activity_id IN (?)`,
      [now, activityIds],
    );
    result.activityPriceBookRows = activityPriceBook.affectedRows || 0;

    const [activityReview] = await conn.query(
      `UPDATE ${tables.activityReview}
       SET deleted = 1, status = 0, updatedon = ?
       WHERE deleted = 0 AND activity_id IN (?)`,
      [now, activityIds],
    );
    result.activityReviewRows = activityReview.affectedRows || 0;

    const [activitySlot] = await conn.query(
      `UPDATE ${tables.activitySlot}
       SET deleted = 1, status = 0, updatedon = ?
       WHERE deleted = 0 AND activity_id IN (?)`,
      [now, activityIds],
    );
    result.activitySlotRows = activitySlot.affectedRows || 0;

    const [activity] = await conn.query(
      `UPDATE ${tables.activity}
       SET deleted = 1, status = 0, updatedon = ?
       WHERE deleted = 0 AND activity_id IN (?)`,
      [now, activityIds],
    );
    result.activityRows = activity.affectedRows || 0;
  }

  const [hotspot] = await conn.query(
    `UPDATE ${tables.hotspot}
     SET deleted = 1, status = 0, updatedon = ?
     WHERE deleted = 0 AND hotspot_ID IN (?)`,
    [now, hotspotIds],
  );
  result.hotspotRows = hotspot.affectedRows || 0;

  return result;
}

async function countCurrent(conn) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS count FROM ${tables.hotspot} WHERE ${whereSql}`,
    explicitNames,
  );
  return Number(rows[0]?.count || 0);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const ts = Date.now();
  const outPath = path.join(OUT_DIR, `hotspot-cleanup-${ts}.json`);

  const conn = await mysql.createConnection({
    host: 'localhost',
    user: 'dvi_user',
    password: 'myDvi123!',
    database: 'dvi_main',
  });

  try {
    const beforeCount = await countCurrent(conn);
    const candidates = await fetchCandidates(conn);
    const hotspotIds = candidates.map((r) => Number(r.hotspot_ID)).filter(Boolean);
    const depsBefore = await dependencyCounts(conn, hotspotIds);
    const activityIds = (depsBefore.activity || []).map((r) => Number(r.activity_id)).filter(Boolean);

    let deleteResult = null;
    if (mode === 'apply' && hotspotIds.length) {
      await conn.beginTransaction();
      try {
        deleteResult = await softDeleteAll(conn, hotspotIds, activityIds);
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      }
    }

    const afterCount = await countCurrent(conn);
    const depsAfter = await dependencyCounts(conn, hotspotIds);

    const report = {
      generatedAt: new Date().toISOString(),
      mode,
      beforeCount,
      afterCount,
      explicitNames,
      removedHotspots: candidates.map((r) => ({
        hotspot_ID: Number(r.hotspot_ID),
        hotspot_name: r.hotspot_name,
        hotspot_priority: Number(r.hotspot_priority || 0),
        status: Number(r.status || 0),
        deleted: Number(r.deleted || 0),
      })),
      dependencyCountsBefore: depsBefore,
      dependencyCountsAfter: depsAfter,
      deleteResult,
      notes: [
        'Soft-delete strategy used: set deleted=1 and status=0.',
        'Only explicit Playwright/PW/Live test names and clear placeholder patterns were targeted.',
      ],
    };

    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

    console.log(`MODE ${mode}`);
    console.log(`BEFORE_COUNT ${beforeCount}`);
    console.log(`CANDIDATE_COUNT ${candidates.length}`);
    console.log(`AFTER_COUNT ${afterCount}`);
    console.log(`REPORT ${outPath}`);
    for (const row of report.removedHotspots) {
      console.log(`HOTSPOT ${row.hotspot_ID} | ${row.hotspot_name}`);
    }
    if (deleteResult) {
      console.log(`DELETE_RESULT ${JSON.stringify(deleteResult)}`);
    }
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('FAILED', err && err.stack ? err.stack : String(err));
  process.exit(1);
});
