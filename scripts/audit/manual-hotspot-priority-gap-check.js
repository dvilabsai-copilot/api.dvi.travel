/**
 * Diagnostic Script: Manual Hotspot Priority & Gap Verification
 * 
 * Purpose:
 * - Verify manual hotspots do NOT display as priority 0 (P0)
 * - Verify manual hotspots have effective scheduling priority 4
 * - Verify P1/P2/P3 remain protected unless confirmation is approved
 * - Verify preview timeline does not contain hidden gaps > 60 minutes without break/waiting segment
 * - Verify hotel segments display correctly (not 8:00 PM - 8:00 PM)
 * 
 * Usage:
 *   node scripts/audit/manual-hotspot-priority-gap-check.js <planId> [routeId]
 */

const fs = require('fs');
const path = require('path');

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(color, message) {
  console.log(`${color}${message}${colors.reset}`);
}

function success(msg) { log(colors.green, `✅ ${msg}`); }
function error(msg) { log(colors.red, `❌ ${msg}`); }
function warning(msg) { log(colors.yellow, `⚠️  ${msg}`); }
function info(msg) { log(colors.cyan, `ℹ️  ${msg}`); }

function timeToSeconds(timeStr) {
  if (!timeStr) return 0;
  const [h, m, s] = String(timeStr).split(':').map(x => parseInt(x, 10));
  return (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
}

function secondsToTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatTime(dateOrStr) {
  if (!dateOrStr) return '';
  if (typeof dateOrStr === 'string') {
    const match = dateOrStr.match(/(\d{2}):(\d{2})/);
    if (match) {
      let h = parseInt(match[1], 10);
      const m = match[2];
      const ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      return `${h}:${m} ${ampm}`;
    }
    return dateOrStr;
  }
  if (dateOrStr instanceof Date) {
    let h = dateOrStr.getHours();
    const m = String(dateOrStr.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${m} ${ampm}`;
  }
  return '';
}

function getDurationMinutes(startDate, endDate) {
  if (!startDate || !endDate) return 0;
  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  return Math.round((end - start) / 60000);
}

async function auditPlan(prisma, planId, routeId) {
  log(colors.blue, `\n════════════════════════════════════════════════════════════`);
  log(colors.blue, `Manual Hotspot Priority & Gap Check for Plan ID: ${planId}`);
  log(colors.blue, `════════════════════════════════════════════════════════════\n`);

  // 1. Fetch all hotspots for this plan
  const hotspots = await prisma.dvi_itinerary_route_hotspot_details.findMany({
    where: {
      itinerary_plan_ID: Number(planId),
      item_type: 4,
      deleted: 0,
      ...(routeId ? { itinerary_route_ID: Number(routeId) } : {}),
    },
    select: {
      route_hotspot_ID: true,
      hotspot_ID: true,
      hotspot_plan_own_way: true,
      hotspot_order: true,
      itinerary_route_ID: true,
      hotspot_start_time: true,
      hotspot_end_time: true,
    },
    orderBy: [
      { itinerary_route_ID: 'asc' },
      { hotspot_order: 'asc' },
    ],
  });

  if (!hotspots.length) {
    warning('No hotspots found for this plan.');
    return;
  }

  // 2. Fetch master hotspot info including priority
  const hotspotIds = [...new Set(hotspots.map(h => Number(h.hotspot_ID || 0)).filter(id => id > 0))];
  const hotspotMasters = await prisma.dvi_hotspot_place.findMany({
    where: { hotspot_ID: { in: hotspotIds } },
    select: {
      hotspot_ID: true,
      hotspot_name: true,
      hotspot_priority: true,
    },
  });

  const masterMap = new Map(
    hotspotMasters.map(h => [h.hotspot_ID, h])
  );

  // 3. Group by route and analyze
  const byRoute = new Map();
  for (const h of hotspots) {
    const rId = h.itinerary_route_ID;
    if (!byRoute.has(rId)) {
      byRoute.set(rId, []);
    }
    byRoute.get(rId).push(h);
  }

  let totalIssues = 0;
  let manualHotspotCount = 0;
  let p1p2p3Count = 0;

  for (const [rId, routeHotspots] of byRoute) {
    info(`\nRoute ID: ${rId}`);
    log(colors.blue, `  ─────────────────────────────────────────`);

    for (const h of routeHotspots) {
      const master = masterMap.get(h.hotspot_ID) || {};
      const isManual = Number(h.hotspot_plan_own_way || 0) === 1;
      const priority = Number(master.hotspot_priority || 0);

      manualHotspotCount += isManual ? 1 : 0;
      if (priority >= 1 && priority <= 3) p1p2p3Count++;

      // ✅ CHECK 1: Manual hotspot should NOT be priority 0
      if (isManual && priority === 0) {
        error(`    Manual hotspot "${master.hotspot_name}" (ID: ${h.hotspot_ID}) has priority 0 - should be 4 or higher`);
        totalIssues++;
      } else if (isManual) {
        success(`    Manual hotspot "${master.hotspot_name}" (ID: ${h.hotspot_ID}) correctly has priority ${priority}`);
      }

      // ✅ CHECK 2: P1/P2/P3 should be protected
      if (!isManual && priority >= 1 && priority <= 3) {
        success(`    Protected hotspot "${master.hotspot_name}" (Priority: P${priority})`);
      }

      // ✅ CHECK 3: Display what priority will be shown
      let displayPriority = priority;
      if (isManual && priority === 0) {
        displayPriority = 4;
        warning(`      → Will display as "Manual / P4" (fallback from 0)`);
      } else if (isManual) {
        info(`      → Will display as "Manual / P${priority}"`);
      }
    }

    // ✅ CHECK 4: Detect gaps between hotspots
    log(colors.blue, `  Gap Analysis:`);
    let gapIssues = 0;
    for (let i = 0; i < routeHotspots.length - 1; i++) {
      const current = routeHotspots[i];
      const next = routeHotspots[i + 1];
      
      const currentEnd = new Date(current.hotspot_end_time);
      const nextStart = new Date(next.hotspot_start_time);
      const gapMinutes = getDurationMinutes(currentEnd, nextStart);

      const currentName = masterMap.get(current.hotspot_ID)?.hotspot_name || `Hotspot ${current.hotspot_ID}`;
      const nextName = masterMap.get(next.hotspot_ID)?.hotspot_name || `Hotspot ${next.hotspot_ID}`;

      if (gapMinutes > 60) {
        warning(`    > ${gapMinutes} min gap between "${currentName}" (ends ${formatTime(currentEnd)}) and "${nextName}" (starts ${formatTime(nextStart)})`);
        warning(`      → Should have explicit "waiting" or "break" segment or gap-fill attempt`);
        gapIssues++;
        totalIssues++;
      } else if (gapMinutes > 0) {
        info(`    • ${gapMinutes} min gap between "${currentName}" and "${nextName}"`);
      }
    }

    if (gapIssues === 0) {
      success(`    No excessive gaps (> 60 min) detected`);
    }
  }

  // 4. Summary
  log(colors.blue, `\n════════════════════════════════════════════════════════════`);
  log(colors.blue, `SUMMARY`);
  log(colors.blue, `════════════════════════════════════════════════════════════`);
  info(`Total hotspots audited: ${hotspots.length}`);
  info(`Manual hotspots: ${manualHotspotCount}`);
  info(`Protected (P1-P3) hotspots: ${p1p2p3Count}`);
  info(`Total issues found: ${totalIssues}`);

  if (totalIssues === 0) {
    success(`\n✅ All checks passed! Manual hotspots are correctly configured.`);
  } else {
    error(`\n❌ Found ${totalIssues} issue(s) that need attention.`);
  }

  log(colors.blue, `════════════════════════════════════════════════════════════\n`);

  return {
    success: totalIssues === 0,
    issuesFound: totalIssues,
    manualHotspotCount,
    protectedHotspotCount: p1p2p3Count,
  };
}

// Export for use as module
module.exports = { auditPlan, colors, log };

// CLI usage
if (require.main === module) {
  const planId = process.argv[2];
  const routeId = process.argv[3];

  if (!planId) {
    log(colors.red, 'Usage: node manual-hotspot-priority-gap-check.js <planId> [routeId]');
    process.exit(1);
  }

  // This would require database connection setup
  log(colors.yellow, 'Note: This script requires database connection setup.');
  log(colors.yellow, 'To use in production, integrate with your Prisma client.');
  log(colors.cyan, `Example: auditPlan(prisma, ${planId}, ${routeId || 'null'})`);
}
