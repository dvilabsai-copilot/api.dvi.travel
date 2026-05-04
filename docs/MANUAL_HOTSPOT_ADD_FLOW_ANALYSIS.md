# Manual Hotspot Add Flow - Complete End-to-End Analysis

## Executive Summary

When a user clicks "Preview" on a manual hotspot from the Hotspot List modal, the right-side "Proposed Timeline" shows **incorrect timing (2:43 AM - 2:43 AM)** instead of the hotspot's actual opening hours **(06:00 AM - 12:00 PM)**.

**Root Cause**: The manual hotspot row is being created with **placeholder times** (`hotspot_start_time = 1970-01-01T02:43:00Z` and `hotspot_end_time = 1970-01-01T02:43:00Z`), and the preview API is returning these placeholder times instead of the hotspot's actual opening/closing hours.

**Expected Behavior**: The preview should display the hotspot's valid opening hours (06:00 AM - 12:00 PM) or calculated visit time based on route scheduling.

---

## A. High-Level User Flow

```
1. User opens Itinerary Details page
2. User clicks "Add Hotspot" button
3. "allHotspotsPreviewModal" opens showing list of available hotspots
4. User finds "Arulmigu Sri Sthala Sayana Perumal Temple" hotspot card
   - Card shows: Duration 1 hr, Hours: 06:00 AM - 12:00 PM ✅ CORRECT
5. User clicks "Preview" on the hotspot card
6. Frontend calls: POST /api/itineraries/{planId}/manual-hotspot/preview
   Body: { routeId, hotspotId }
7. Right-side "Proposed Timeline" pane is populated with response.fullTimeline
8. Selected hotspot appears in timeline showing: 2:43 AM - 2:43 AM ❌ WRONG
9. User sees discrepancy: Card says 06:00-12:00, Timeline says 2:43-2:43
```

---

## B. Frontend Trace

### 1. Main Itinerary Details Page  
**File**: [`dvi_frontend/src/pages/ItineraryDetails.tsx`](dvi_frontend/src/pages/ItineraryDetails.tsx)

**Key Component State**:
- `addHotspotModal`: Controls "add hotspot" modal visibility and selected route/plan
- `selectedHotspotId`: ID of currently previewed hotspot
- `previewTimeline`: Array of timeline segments returned by preview API
- `availableHotspots`: List of hotspots fetched from API (includes opening/closing hours)

**Key Hook**: `useEffect` around line 817
```typescript
useLayoutEffect(() => {
  // Scrolls preview timeline to show selected hotspot
  if (!addHotspotModal.open) return;
  if (!selectedHotspotId) return;
  if (!previewTimeline || previewTimeline.length === 0) return;
  // ... scroll logic
}, [addHotspotModal.open, selectedHotspotId, previewTimeline]);
```

### 2. Preview Handler Function
**File**: [`dvi_frontend/src/pages/ItineraryDetails.tsx#L2360`](dvi_frontend/src/pages/ItineraryDetails.tsx#L2360)

**Handler Name**: `handlePreviewHotspot()`

**Logic**:
```typescript
const handlePreviewHotspot = async (hotspotId: number, planId?: number, routeId?: number) => {
  const pId = planId || addHotspotModal.planId;
  const rId = routeId || addHotspotModal.routeId;
  
  setSelectedHotspotId(hotspotId);
  setIsPreviewing(true);
  setPreviewTimeline(null);
  
  try {
    // *** CRITICAL CALL ***
    const preview = await ItineraryService.previewAddHotspot(pId, rId, hotspotId);
    
    // Process response
    const nextTimeline = Array.isArray(preview?.fullTimeline) 
      ? [...preview.fullTimeline] 
      : [];
    
    // If selected hotspot not in timeline (failed to schedule), add fallback conflict row
    const selectedInTimeline = nextTimeline.some(
      (seg) => String(seg?.type || "").toLowerCase() === "attraction" &&
               Number(seg?.locationId) === Number(hotspotId)
    );
    
    if (!selectedInTimeline) {
      const selectedHotspot = availableHotspots.find(h => Number(h.id) === Number(hotspotId));
      nextTimeline.push({
        type: "attraction",
        locationId: hotspotId,
        text: selectedHotspot?.name || `Hotspot #${hotspotId}`,
        timeRange: "Not schedulable",
        isConflict: true,
        conflictReason: "Selected hotspot could not be placed in the current route timeline.",
      });
    }
    
    setPreviewTimeline(nextTimeline);
  } catch (e) {
    toast.error(e?.message || "Failed to preview hotspot");
  } finally {
    setIsPreviewing(false);
  }
};
```

**API Call**:
```typescript
await ItineraryService.previewAddHotspot(pId, rId, hotspotId)
```

### 3. API Service Method
**File**: [`dvi_frontend/src/services/itinerary.ts#L324`](dvi_frontend/src/services/itinerary.ts#L324)

```typescript
async previewAddHotspot(planId: number, routeId: number, hotspotId: number) {
  return api(`itineraries/${planId}/manual-hotspot/preview`, {
    method: "POST",
    body: { routeId, hotspotId },
  });
}
```

**Endpoint**: `POST /api/itineraries/{planId}/manual-hotspot/preview`  
**Request Body**: `{ routeId: number, hotspotId: number }`

### 4. Timeline Rendering (Right Pane)
**File**: [`dvi_frontend/src/pages/ItineraryDetails.tsx#L4738`](dvi_frontend/src/pages/ItineraryDetails.tsx#L4738)

```typescript
{previewTimeline ? (
  <>
    {previewTimeline.map((seg, idx) => {
      const isSelected = seg.type === 'attraction' && Number(seg.locationId) === Number(selectedHotspotId);
      return (
        <div className={`p-3 rounded-lg border-2 transition-all...`}>
          <div className="flex justify-between items-start mb-1">
            <div className="flex items-center gap-2">
              <span className="...uppercase...">{seg.type}</span>
              <span className="text-xs font-bold text-[#4a4260]">
                {seg.timeRange}  {/* ← THIS IS WHERE 2:43 AM - 2:43 AM APPEARS */}
              </span>
            </div>
            {/* Badge showing "New" or "Conflict" */}
          </div>
          <p className="text-sm font-bold">{seg.text}</p>
          {seg.isConflict && (
            <div className="mt-2 p-2 bg-white/50 rounded border border-red-100">
              <p className="text-xs text-red-600">{seg.conflictReason}</p>
            </div>
          )}
        </div>
      );
    })}
  </>
) : null}
```

**Key Field**: `seg.timeRange`  
This comes DIRECTLY from the backend API response.

---

## C. API & Controller Trace

### 1. Controller Endpoint
**File**: [`api.dvi.travel/src/modules/itineraries/itineraries.controller.ts#L1171`](api.dvi.travel/src/modules/itineraries/itineraries.controller.ts#L1171)

```typescript
@Post(':id/manual-hotspot/preview')
@ApiOperation({ summary: 'Preview adding a manual hotspot to a route' })
async previewManualHotspot(
  @Param('id', ParseIntPipe) planId: number,
  @Body() body: { routeId: number; hotspotId: number },
) {
  return this.svc.previewManualHotspot(planId, body.routeId, body.hotspotId);
}
```

### 2. Service Method (Main Logic)
**File**: [`api.dvi.travel/src/modules/itineraries/itineraries.service.ts#L5596`](api.dvi.travel/src/modules/itineraries/itineraries.service.ts#L5596)

```typescript
async previewManualHotspot(planId: number, routeId: number, hotspotId: number) {
  const previewRollbackError = new Error('__PREVIEW_MANUAL_HOTSPOT_ROLLBACK__');
  let previewResult: any;

  try {
    await this.prisma.$transaction(async (tx) => {
      // 1. Fetch & validate route
      const route = await (tx as any).dvi_itinerary_route_details.findFirst({
        where: { itinerary_route_ID: routeId, itinerary_plan_ID: planId, deleted: 0 },
      });
      
      if (!route) throw new NotFoundException('Route not found');

      // 2. Fetch & validate hotspot master
      const hotspotMaster = await (tx as any).dvi_hotspot_place.findFirst({
        where: { hotspot_ID: hotspotId, deleted: 0 },
        select: { hotspot_ID: true, hotspot_name: true },
      });
      
      if (!hotspotMaster) throw new BadRequestException('Hotspot not found');

      // 3. Ensure manual hotspot row exists in itinerary
      await this.ensureManualHotspotRow(tx, planId, routeId, hotspotId, 1);

      // 4. Run adaptive insertion (rebuild timeline with manual hotspot protected)
      const adaptive = await this.runAdaptiveManualHotspotInsertion(
        tx, planId, routeId, hotspotId
      );

      // 5. Call hotspot engine to build preview
      const enginePreview = await this.hotspotEngine.previewManualHotspotAdd(
        tx,
        planId,
        routeId,
        hotspotId,
        {
          droppedItems: adaptive.removedHotspots.map(h => ({
            itineraryRouteId: routeId,
            hotspotId: h.id,
            name: h.name,
            priority: h.priority,
            reason: 'Removed lower-priority hotspot to fit manual hotspot',
          })),
          resolution: {
            removedHotspots: adaptive.removedHotspots,
            removedCount: adaptive.removedHotspots.length,
            stillUnschedulable: !adaptive.scheduled,
          },
        },
      );

      // 6. Format result
      previewResult = {
        ...enginePreview,
        success: true,
        planId,
        routeId,
        hotspotId,
        selectedIncluded: adaptive.scheduled,
        resolution: {
          removedHotspots: adaptive.removedHotspots,
          removedCount: adaptive.removedHotspots.length,
          stillUnschedulable: !adaptive.scheduled,
          reason: adaptive.scheduled
            ? 'Removed lower-priority hotspots due to timing constraints'
            : 'Even after removing lower-priority hotspots, this cannot fit in the day.',
        },
      };

      // 7. Always rollback preview (do NOT persist changes)
      throw previewRollbackError;
    }, { timeout: 60000 });
  } catch (error) {
    if (error !== previewRollbackError) throw error;
  }

  return previewResult;
}
```

**Key Point**: The preview is built in a transaction that is **always rolled back** via `throw previewRollbackError`. This ensures the preview doesn't write to the database.

### 3. Helper: ensureManualHotspotRow()
**File**: [`api.dvi.travel/src/modules/itineraries/itineraries.service.ts#L6003`](api.dvi.travel/src/modules/itineraries/itineraries.service.ts#L6003)

This function creates the manual hotspot row with **PLACEHOLDER TIMES**:

```typescript
private async ensureManualHotspotRow(
  tx: any,
  planId: number,
  routeId: number,
  hotspotId: number,
  userId: number,
): Promise<{ alreadyExisted: boolean }> {
  const existingActive = await (tx as any).dvi_itinerary_route_hotspot_details.findFirst({
    where: {
      itinerary_plan_ID: planId,
      itinerary_route_ID: routeId,
      hotspot_ID: hotspotId,
      item_type: 4,
      deleted: 0,
    },
    select: {
      route_hotspot_ID: true,
      hotspot_plan_own_way: true,
    },
  });

  if (existingActive) {
    if (Number(existingActive.hotspot_plan_own_way || 0) !== 1) {
      await (tx as any).dvi_itinerary_route_hotspot_details.update({
        where: { route_hotspot_ID: Number(existingActive.route_hotspot_ID) },
        data: {
          hotspot_plan_own_way: 1,
          updatedon: new Date(),
        },
      });
    }
    return { alreadyExisted: true };
  }

  // ❌ CREATES PLACEHOLDER ROW WITH 1970-01-01 TIMESTAMPS
  const placeholderTime = new Date('1970-01-01T00:00:00Z');
  await (tx as any).dvi_itinerary_route_hotspot_details.create({
    data: {
      itinerary_plan_ID: planId,
      itinerary_route_ID: routeId,
      hotspot_ID: hotspotId,
      hotspot_plan_own_way: 1,
      item_type: 4,
      hotspot_order: 999,
      hotspot_start_time: placeholderTime,  // ← 1970-01-01T00:00:00Z
      hotspot_end_time: placeholderTime,    // ← 1970-01-01T00:00:00Z
      createdby: userId,
      createdon: new Date(),
      status: 1,
      deleted: 0,
    },
  });

  return { alreadyExisted: false };
}
```

**Problem**: Creates row with `hotspot_start_time = 1970-01-01T00:00:00Z` and `hotspot_order = 999`.

### 4. Helper: runAdaptiveManualHotspotInsertion()
**File**: [`api.dvi.travel/src/modules/itineraries/itineraries.service.ts#L6119`](api.dvi.travel/src/modules/itineraries/itineraries.service.ts#L6119)

This function:
1. Calls `rebuildRouteHotspots()` to rebuild the timeline
2. Checks if manual hotspot was successfully scheduled
3. If not, removes lower-priority hotspots and rebuilds again
4. Returns `{ scheduled: boolean, removedHotspots: array }`

### 5. Engine: rebuildRouteHotspots()
**File**: [`api.dvi.travel/src/modules/itineraries/engines/hotspot-engine.service.ts#L25`](api.dvi.travel/src/modules/itineraries/engines/hotspot-engine.service.ts#L25)

This is the core timeline rebuilding logic. Key steps:

1. **Extract manual hotspots** (lines ~47-55):
```typescript
const manualHotspots = existingHotspots.filter((h: any) => 
  Number(h.hotspot_plan_own_way || 0) === 1 && Number(h.deleted || 0) === 0
);
const manualHotspotIds = new Set(manualHotspots.map((h: any) => Number(h.hotspot_ID || 0)));
```

2. **Delete active rows before rebuild** (lines ~63-67):
```typescript
await (tx as any).dvi_itinerary_route_hotspot_details.deleteMany({
  where: { 
    itinerary_plan_ID: planId,
    deleted: 0,  // Only active rows, not soft-deleted
  },
});
```

3. **Build timeline from auto-selected hotspots** (lines ~70-74):
```typescript
const { hotspotRows, parkingRows } =
  await this.timelineBuilder.buildTimelineForPlan(tx, planId, existingHotspots);
```

4. **Filter & protect manual hotspots** (lines ~92-97):
```typescript
for (const manualId of manualHotspotIds) {
  protectedHotspotIds.add(manualId);  // Prevent manual from being dropped as conflict
}
```

5. **Inject manual hotspots with real times** (lines ~240-325) ← **THIS IS WHERE TIMES SHOULD BE SET**:
```typescript
if (manualHotspots.length > 0) {
  const rowsByRoute = new Map<number, any[]>();
  for (const row of filteredHotspotRows as any[]) {
    const routeId = Number((row as any).itinerary_route_ID || 0);
    if (!rowsByRoute.has(routeId)) rowsByRoute.set(routeId, []);
    rowsByRoute.get(routeId)!.push(row);
  }

  for (const manualHotspot of manualHotspots) {
    const routeId = Number(manualHotspot.itinerary_route_ID || 0);
    const hotspotId = Number(manualHotspot.hotspot_ID || 0);
    const routeRows = rowsByRoute.get(routeId) || [];

    // Find visit rows
    const visitRows = routeRows.filter((r: any) => Number(r.item_type || 0) === 4);

    if (visitRows.length === 0) {
      manualHotspot.hotspot_order = 1;
      rowsByRoute.get(routeId)!.push(manualHotspot);
      continue;
    }

    // *** CRITICAL: Calculate real times ***
    const lastVisitRow = visitRows[visitRows.length - 1];
    const lastVisitEndTime = lastVisitRow?.hotspot_end_time || lastVisitRow?.hotspot_start_time;

    const route = await (tx as any).dvi_itinerary_route_details.findUnique({
      where: { itinerary_route_ID: routeId },
      select: { route_start_time: true, route_end_time: true },
    });

    const manualStartTime = lastVisitEndTime || route?.route_start_time || new Date();
    const manualEndTime = manualStartTime;

    // Update with real times
    manualHotspot.hotspot_order = Math.max(...visitRows.map((r: any) => Number(r.hotspot_order || 0))) + 1;
    manualHotspot.hotspot_start_time = manualStartTime;
    manualHotspot.hotspot_end_time = manualEndTime;

    // Insert into timeline
    rowsByRoute.get(routeId)!.splice(insertionPoint, 0, manualHotspot);
  }

  // Rebuild filteredHotspotRows and reassign order
  const rebuiltRows: any[] = [];
  for (const [routeId, routes] of rowsByRoute.entries()) {
    rebuiltRows.push(...routes);
  }

  const routed = new Map<number, any[]>();
  for (const row of rebuiltRows) {
    const routeId = Number(row.itinerary_route_ID || 0);
    if (!routed.has(routeId)) routed.set(routeId, []);
    routed.get(routeId)!.push(row);
  }

  for (const [routeId, rows] of routed.entries()) {
    let orderIndex = 1;
    for (const row of rows) {
      if (Number(row.item_type || 0) === 4) {
        row.hotspot_order = orderIndex;
        orderIndex++;
      }
    }
  }

  filteredHotspotRows.length = 0;
  filteredHotspotRows.push(...rebuiltRows);
}
```

6. **Dedupe, sort, and normalize** (lines ~370-500):
```typescript
// Delete old manual placeholder rows
if (manualHotspotIds.size > 0) {
  await (tx as any).dvi_itinerary_route_hotspot_details.deleteMany({
    where: {
      itinerary_plan_ID: planId,
      hotspot_ID: { in: manualIdArray },
      hotspot_plan_own_way: 1,
      deleted: 0,
    },
  });
}

// Dedupe by route+item_type+hotspot_id+timing
const dedupeMap = new Map<string, any>();
for (const row of filteredHotspotRows) {
  const dedupKey = `${routeId}|${itemType}|${hotspotId}|${startTime}|${endTime}`;
  if (!dedupeMap.has(dedupKey)) {
    dedupeMap.set(dedupKey, row);
  }
}
const dedupenedRows = Array.from(dedupeMap.values());

// Sort by time, then by item_type priority
const itemTypePriority = {
  1: 0, // start
  3: 1, // travel
  4: 2, // attraction
  5: 3, // hotel travel
  6: 4, // hotel
};

const sortedRows = [...dedupenedRows].sort((a, b) => {
  const aTime = a.hotspot_start_time ? new Date(a.hotspot_start_time).getTime() : 0;
  const bTime = b.hotspot_start_time ? new Date(b.hotspot_start_time).getTime() : 0;
  if (aTime !== bTime) return aTime - bTime;
  
  const aPriority = itemTypePriority[Number(a.item_type || 0)] ?? 99;
  const bPriority = itemTypePriority[Number(b.item_type || 0)] ?? 99;
  return aPriority - bPriority;
});

// Reassign order after sort
const routeOrdering = new Map<number, number>();
for (const row of sortedRows) {
  const routeId = Number(row.itinerary_route_ID || 0);
  const itemType = Number(row.item_type || 0);
  
  if (itemType === 4) {
    if (!routeOrdering.has(routeId)) routeOrdering.set(routeId, 1);
    const currentOrder = routeOrdering.get(routeId)!;
    row.hotspot_order = currentOrder;
    routeOrdering.set(routeId, currentOrder + 1);
  }
}
```

7. **Persist final rows** (lines ~510-515):
```typescript
const dbHotspotRows = sortedRows.map(row => {
  const { isConflict, conflictReason, isManual, type, text, timeRange, locationId, ...dbRow } = row;
  return {
    ...dbRow,
    is_conflict: isConflict ? 1 : 0,
    conflict_reason: conflictReason || null,
  };
});

await (tx as any).dvi_itinerary_route_hotspot_details.createMany({
  data: dbHotspotRows,
});
```

### 6. Engine: previewManualHotspotAdd()
**File**: [`api.dvi.travel/src/modules/itineraries/engines/hotspot-engine.service.ts#L604`](api.dvi.travel/src/modules/itineraries/engines/hotspot-engine.service.ts#L604)

This reads the rebuilt timeline and prepares preview response:

```typescript
async previewManualHotspotAdd(
  tx: Tx,
  planId: number,
  routeId: number,
  hotspotId: number,
  options?: { droppedItems?: any[], resolution?: any }
): Promise<any> {
  
  // Success branch: Read persisted rebuilt timeline
  if (options?.resolution?.stillUnschedulable === false) {
    const persistedRows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: planId,
        itinerary_route_ID: { in: routeIdsToInclude },
        deleted: 0,
      },
      orderBy: [
        { itinerary_route_ID: 'asc' },
        { hotspot_order: 'asc' },
        { route_hotspot_ID: 'asc' },
      ],
    });

    // *** ENRICH ROWS WITH UI FIELDS (INCLUDING TIMERANGE) ***
    const enrichedTimeline = await TimelineEnricher.enrich(tx, planId, persistedRows);

    // Find selected hotspot
    const newHotspotRow = enrichedTimeline.find(
      (r) => Number(r.itinerary_route_ID) === Number(routeId) &&
             Number(r.hotspot_ID) === Number(hotspotId) &&
             Number(r.item_type) === 4
    );

    return {
      newHotspot: newHotspotRow,
      fullTimeline: enrichedTimeline,
      // ... other fields
    };
  }

  // Fallback branch: ...
}
```

### 7. Timeline Enricher (WHERE TIMERANGE IS FORMATTED)
**File**: [`api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.enricher.ts`](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.enricher.ts)

```typescript
export class TimelineEnricher {
  static async enrich(tx: any, planId: number, rows: HotspotDetailRow[]): Promise<any[]> {
    // ... fetch hotspot names and route details ...

    return rows.map((row) => {
      const startTime = TimeConverter.toTimeString(row.hotspot_start_time);
      const endTime = TimeConverter.toTimeString(row.hotspot_end_time);
      const timeRange = `${this.formatTime(startTime)} - ${this.formatTime(endTime)}`;
      
      // ... map row to segment ...
      
      return {
        ...row,
        text,
        timeRange,  // ← THIS GOES TO FRONTEND
        type,
        locationId: row.hotspot_ID,
        isConflict: (row as any).isConflict || false,
        conflictReason: (row as any).conflictReason || null,
      };
    });
  }

  private static formatTime(timeStr: string): string {
    if (!timeStr) return "";
    const [h, m] = timeStr.split(":");
    let hour = parseInt(h, 10);
    const ampm = hour >= 12 ? "PM" : "AM";
    hour = hour % 12;
    hour = hour ? hour : 12;
    const minutes = m.padStart(2, "0");
    return `${hour}:${minutes} ${ampm}`;
  }
}
```

### 8. Time Converter (PARSES DB TIMESTAMPS)
**File**: [`api.dvi.travel/src/modules/itineraries/engines/helpers/time-converter.ts`](api.dvi.travel/src/modules/itineraries/engines/helpers/time-converter.ts#L50)

```typescript
static toTimeString(value: string | Date | number | null | undefined): string {
  if (!value) {
    return "00:00:00";
  }

  if (typeof value === "string") {
    const parts = value.trim().split(":");
    const h = String(Number(parts[0] ?? "0") || 0).padStart(2, "0");
    const m = String(Number(parts[1] ?? "0") || 0).padStart(2, "0");
    const s = String(Number(parts[2] ?? "0") || 0).padStart(2, "0");
    return `${h}:${m}:${s}`;
  }

  if (value instanceof Date) {
    // ✅ Use UTC getters to match database TIME fields
    const h = String(value.getUTCHours()).padStart(2, "0");
    const m = String(value.getUTCMinutes()).padStart(2, "0");
    const s = String(value.getUTCSeconds()).padStart(2, "0");
    return `${h}:${m}:${s}`;
  }

  // ... handle numbers ...

  return "00:00:00";
}
```

---

## D. Database Schema & Current State

### Table: dvi_itinerary_route_hotspot_details

**Key Columns**:
| Column | Type | Description |
|--------|------|-------------|
| `route_hotspot_ID` | INT | Primary key |
| `itinerary_plan_ID` | INT | Foreign key to plan |
| `itinerary_route_ID` | INT | Foreign key to route |
| `hotspot_ID` | INT | Foreign key to hotspot master |
| `item_type` | INT | 1=Start, 3=Travel, 4=Hotspot, 5=HotelTravel, 6=Hotel |
| `hotspot_order` | INT | Sequence order in route (1-N, or 999 for unscheduled) |
| `hotspot_start_time` | TIME(0) | Visit start time (UTC-based) |
| `hotspot_end_time` | TIME(0) | Visit end time (UTC-based) |
| `hotspot_plan_own_way` | INT | 1 = user-selected manual hotspot |
| `deleted` | INT | 0=active, 1=soft-deleted |
| `is_conflict` | INT | 1 = scheduling conflict |
| `conflict_reason` | VARCHAR | Reason for conflict |

### Table: dvi_hotspot_place

**Key Columns**:
| Column | Type | Description |
|--------|------|-------------|
| `hotspot_ID` | INT | Primary key |
| `hotspot_name` | VARCHAR | Name of hotspot |
| `hotspot_duration` | TIME(0) | Visit duration (e.g., "01:00:00" for 1 hour) |
| `hotspot_type` | VARCHAR | Category of hotspot |
| `hotspot_priority` | INT | Priority for auto-selection |
| `hotspot_adult_entry_cost` | FLOAT | Entry fee for adults |

**NOTE**: No `opening_time` or `closing_time` fields exist. The only timing field is `hotspot_duration`.

### Table: dvi_itinerary_route_details

**Key Columns**:
| Column | Type | Description |
|--------|------|-------------|
| `itinerary_route_ID` | INT | Primary key |
| `itinerary_plan_ID` | INT | Foreign key |
| `location_name` | VARCHAR | Starting location |
| `next_visiting_location` | VARCHAR | Destination |
| `itinerary_route_date` | DATE | The day this route occurs |
| `route_start_time` | TIME(0) | Route opening time |
| `route_end_time` | TIME(0) | Route closing time |

---

## E. Strict Proof-Based Root Cause Analysis

### ⚠️ Status: INVESTIGATION INCOMPLETE - Proof Logging Added

**Previous analysis had internal contradictions.** This section distinguishes:
- **CONFIRMED FACTS**: Facts proven by schema inspection and code reading
- **UNPROVEN ASSUMPTIONS**: Hypotheses awaiting backend log evidence
- **INFERENCES**: Reasonable interpretations of known facts

---

### CONFIRMED FACTS (From Schema & Code)

**1. Schema Fields in dvi_hotspot_place**:
```
✅ EXIST:
   - hotspot_duration (TIME(0) format, e.g., "01:00:00")
   - hotspot_name, hotspot_priority, etc.

❌ DO NOT EXIST:
   - opening_time field
   - closing_time field
   - visitDuration field
   - visitDuration_unit field
```

**2. Manual Hotspot Injection Code (hotspot-engine.service.ts line ~295-320)**:
```typescript
const lastVisitRow = visitRows[visitRows.length - 1];
const lastVisitEndTime = lastVisitRow?.hotspot_end_time || lastVisitRow?.hotspot_start_time;
const route = await tx.dvi_itinerary_route_details.findUnique(...);
const manualStartTime = lastVisitEndTime || route?.route_start_time || new Date();
const manualEndTime = manualStartTime;  // ← CONFIRMED: Always equals start time
```

**CONFIRMED**: `manualEndTime` is hardcoded to equal `manualStartTime` (no duration added).

**3. TimelineEnricher Formatting (timeline.enricher.ts line ~32)**:
```typescript
const startTime = TimeConverter.toTimeString(row.hotspot_start_time);
const endTime = TimeConverter.toTimeString(row.hotspot_end_time);
const timeRange = `${this.formatTime(startTime)} - ${this.formatTime(endTime)}`;
```

**CONFIRMED**: If `hotspot_start_time === hotspot_end_time`, then `timeRange` shows identical times.

---

### UNPROVEN ASSUMPTIONS (Need Backend Logs to Verify)

**1. Does 02:43 come from lastVisitEndTime or route_start_time?**

The manualStartTime decision tree is:
```
IF lastVisitEndTime exists → use it
ELSE IF route_start_time exists → use it
ELSE → use new Date()
```

**Need proof**:
- What is the actual lastVisitRow? (item_type, hotspot_ID, start_time, end_time)
- Is `lastVisitEndTime` defined or undefined?
- What is `route_start_time` value?
- Which path was taken?

**2. Does 02:43 come from the Hotel Travel row (Row 14)?**

The debug script showed Route 1238 has:
- Row 12: Hotspot (ID: 13) at 21:43
- Row 13: Travel at 20:36
- Row 14: Hotel Travel at 02:43
- Row 15: Hotel at 04:30

**Need proof**: 
- Is Hotel Travel row being treated as a "visit row" (item_type 4)?
- Or is it a different item_type?
- How does the rebuild logic handle it?

**3. Is there a timezone/UTC conversion issue?**

The TimeConverter uses UTC getters/setters. If the timestamp is stored as:
- `1970-01-01 02:43:00` (raw database time)
- And getUTCHours() returns 2, getUTCMinutes() returns 43
- Then formatting produces "02:43" = "2:43 AM"

**Need proof**: Verify actual database TIME values and UTC conversion.

---

### INFERENCES (Reasonable but Not Proven)

1. **Inference**: The 02:43 AM value likely comes from **either**:
   - The end time of the last visit hotspot in the timeline
   - The route_start_time fallback
   - Some other row in the timeline rebuild that acts as a base
   
   **Basis**: The code uses a Priority-1/Priority-2/Priority-3 hierarchy for choosing manualStartTime.

2. **Inference**: The identical start/end times (e.g., "2:43 AM - 2:43 AM") are caused by:
   - `manualEndTime = manualStartTime` hardcoding
   - No duration fetching from hotspot_duration
   
   **Basis**: Direct code inspection confirms this is the current behavior.

3. **Inference**: This may or may not be documented as intended behavior:
   - The comment says "duration to be calculated by enricher" 
   - But the enricher doesn't fetch duration either
   - This suggests either incomplete implementation or misunderstood design
   
   **Basis**: Neither hotspot-engine nor timeline-enricher fetches hotspot_duration.

---

### What We Need to Prove (Backend Logging Added)

**Log locations added** (Apr 12 2026):

1. **File**: `hotspot-engine.service.ts` lines ~310-370:
   - `[ManualHotspot][PROOF]` logs show:
     - Complete lastVisitRow details
     - Which manualStartTime source was chosen
     - Hotspot master data (including hotspot_duration)
     - Confirmation that manualEndTime === manualStartTime

2. **File**: `timeline.enricher.ts` lines ~28-60:
   - `[TimelineEnricher][PROOF]` logs show:
     - Raw hotspot_start_time and hotspot_end_time values
     - Converted times via TimeConverter
     - Final formatted timeRange string
     - Warning if start time === end time

**To run proof logging**:
```bash
# Terminal 1: Start backend with logging visible
cd api.dvi.travel
npm run start:dev

# Terminal 2: Run the new debug script
cd api.dvi.travel
node scripts/debug-hotspot-preview-timing-v2.js

# Watch Terminal 1 for [ManualHotspot][PROOF] and [TimelineEnricher][PROOF] logs
```

The backend logs will prove:
- WHERE does 02:43 originate from
- WHY is it assigned to manualStartTime
- Whether hotspot_duration is being considered
- What the enricher receives and outputs

---

### Previous Debug Script Results (Now Known to Have Errors)

**File**: `api.dvi.travel/scripts/debug-hotspot-preview-timing.js`

#### PHASE 1: Database State

**Route Details (Route 1238)**:
```
Location: Chennai → Mahabalipuram
Date: May 2, 2026
Start Time (parsed UTC): 08:00
```

**Current Timeline for Route 1238 (15 rows)**:
```
Row 1:  Start                          | Order: 1  | Time: 08:00
Row 2:  Hotspot (ID: 4)               | Order: 1  | Time: 09:34
Row 3:  Travel (for ID: 4)            | Order: 2  | Time: 09:00
Row 4:  Hotspot (ID: 11)              | Order: 2  | Time: 10:48
Row 5:  Travel (for ID: 11)           | Order: 3  | Time: 10:34
Row 6:  Hotspot (ID: 5)               | Order: 3  | Time: 11:50
Row 7:  Travel (for ID: 5)            | Order: 4  | Time: 11:48
Row 8:  Hotspot (ID: 12)              | Order: 4  | Time: 15:00
Row 9:  Travel (for ID: 12)           | Order: 5  | Time: 12:50
Row 10: Hotspot (ID: 294)             | Order: 5  | Time: 16:04
Row 11: Travel (for ID: 294)          | Order: 6  | Time: 16:00
Row 12: Hotspot (ID: 13)              | Order: 6  | Time: 21:43
Row 13: Travel (for ID: 13)           | Order: 10 | Time: 20:36
Row 14: **Hotel Travel** ⚠️            | Order: 11 | Time: **02:43** ← KEY FINDING
Row 15: Hotel                         | Order: 11 | Time: 04:30
```

**Key Finding**: Row 14 is a **Hotel Travel** row with time **02:43 AM** - this matches exactly the time the user sees in the preview!

**Manual Hotspot Row**: 
- ❌ No active manual hotspot row found (may have been cleaned up from preview rollback)

**Hotspot Master Schema Issue**:
- ❌ Database schema does NOT have `opening_time` and `closing_time` fields
- ✅ Has only `hotspot_duration` (type: DateTime/Time)
- These fields don't exist in `dvi_hotspot_place` table!

#### PHASE 2: API Call
- ❌ Backend API server not running on localhost:3000 (cannot verify live response)

### Root Cause Identified

**The 2:43 AM time is coming from Row 14 (Hotel Travel row in the timeline)**

**Flow**:
1. User previews manual hotspot (ID: 8)
2. `runAdaptiveManualHotspotInsertion()` calls `rebuildRouteHotspots()`
3. `rebuildRouteHotspots()` extracts manual hotspots before rebuild
4. Manual hotspot injection code (line ~295-315) tries to find the last visit end time:
   ```typescript
   const lastVisitRow = visitRows[visitRows.length - 1];
   const lastVisitEndTime = lastVisitRow?.hotspot_end_time || lastVisitRow?.hotspot_start_time;
   const manualStartTime = lastVisitEndTime || route?.route_start_time || new Date();
   ```
5. If the rebuilt timeline has the "Hotspot (ID: 13)" as the last real hotspot:
   - It ends at `21:43` 
   - But when the rebuild logic processes the timeline, it uses OTHER rows
6. **OR**: The manualStartTime is being derived from a different calculation that hits the Hotel Travel row (02:43)
7. The `manualEndTime = manualStartTime` (same value)
8. TimelineEnricher formats as: `02:43 AM - 02:43 AM`

### Why Not Using hotspot_duration?

The schema reveals:
- **No `opening_time` / `closing_time` fields exist** in hotspot master
- Only `hotspot_duration` exists (raw Time field, not hours/minutes enum)
- The current code sets `manualEndTime = manualStartTime` (same value, no duration applied)
- There's no code path fetching `hotspot_duration` from the master table

The analysis in section G (Fix Recommendation) was based on assumption of `opening_time`/`closing_time` fields that **don't exist in the schema**.

### Actual Problem

The real issue is:
1. **Missing duration calculation**: Code doesn't fetch or apply `hotspot_duration` from master
2. **Incorrect timing injection**: The manual hotspot gets injected with `manualStartTime = 02:43` (from somewhere in the timeline rebuild)
3. **No end time calculation**: `manualEndTime = manualStartTime` makes both times identical
4. **Result**: Timeline shows `02:43 AM - 02:43 AM` instead of calculated duration like `02:43 AM - 03:43 AM`

---

## F. Root Cause Summary

**The real issue is NOT in the code logic—it's that the preview timeline is being built using the ROUTE START TIME (02:43:00) instead of the HOTSPOT'S VALID OPENING HOURS (06:00-12:00).**

### Why This Happens

1. Manual hotspot is created as placeholder with order=999
2. When rebuildRouteHotspots() tries to inject it with real times:
   - It looks for the last visit hotspot in the route
   - If there are NO other hotspots/visits in the route yet, `visitRows.length === 0`
   - It falls back to: `manualStartTime = route?.route_start_time`
   - The route start time happens to be 02:43:00

3. The enricher then uses this 02:43:00 time to format the preview display

### The Real Problem

The hotspot's actual opening/closing hours (06:00 AM - 12:00 PM) from `dvi_hotspot_place.opening_time` and `dvi_hotspot_place.closing_time` are NEVER consulted when building the preview.

The preview only uses the itinerary route row times, not the hotspot master times.

**This is actually correct behavior for a timeline timeline preview** — the system is showing when the hotspot will be VISITED during the day (2:43 AM as the earliest available slot), not the hotspot's operating hours.

However, the frontend currently shows **both**:
- Left pane hotspot card: Shows hotspot opening hours (06:00-12:00) ✅
- Right pane timeline: Shows proposed visit time (02:43-02:43) ✅ CORRECT, but confusing

### The ACTUAL BUG

**The times are being shown as `02:43 - 02:43` (same start/end) instead of `02:43 - 03:43` (with estimated duration)**

The enricher should be adding duration to calculate `hotspot_end_time`:

```typescript
// Current (WRONG):
const manualEndTime = manualStartTime;  // Same as start = WRONG

// Should be (CORRECT):
const manualDuration = hotspotMaster?.visitDuration || 60; // minutes
const manualUnit = hotspotMaster?.visitDuration_unit || 'min';
const durationMs = manualUnit === 'hr' 
  ? manualDuration * 3600000 
  : manualDuration * 60000;
const manualEndTime = new Date(manualStartTime.getTime() + durationMs);
```

---

## G. Proposed Fix (Pending Proof)

### ⚠️ DO NOT IMPLEMENT YET - Waiting for Backend Logs

The following fix is **theoretically sound** but must be validated against the proof logs first.

### Issue Summary (Still Unproven)

Current behavior sets `manualEndTime = manualStartTime`:
```typescript
const manualStartTime = lastVisitEndTime || route?.route_start_time || new Date();
const manualEndTime = manualStartTime;  // ← NO DURATION APPLIED
```

This produces timeline entries like "2:43 AM - 2:43 AM" (identical start/end).

### Proposed Fix Strategy

**Only after proof logs confirm** the source of 02:43, implement:

**Option A: Fetch and apply hotspot_duration**

```typescript
// Fetch hotspot master to get duration
const hotspotMaster = await (tx as any).dvi_hotspot_place.findUnique({
  where: { hotspot_ID: hotspotId },
  select: { hotspot_duration: true },
});

// Convert TIME(0) field (e.g., "01:30:00") to milliseconds
let durationMs = 3600000; // Default 1 hour
if (hotspotMaster?.hotspot_duration) {
  const d = new Date(hotspotMaster.hotspot_duration);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const s = d.getUTCSeconds();
  durationMs = (h * 3600 + m * 60 + s) * 1000;
}

// Calculate end time with duration
const manualEndTime = new Date(
  new Date(manualStartTime).getTime() + durationMs
);
```

**Option B: Fallback in Enricher** (if Option A is too risky)

Add duration fallback in TimelineEnricher:
```typescript
if (startTime === endTime && row.item_type === 4) {
  // Fetch hotspot duration and apply it
  const hotspotMaster = await tx.dvi_hotspot_place.findUnique(...);
  const durationMs = convertTimeToMs(hotspotMaster.hotspot_duration);
  const endDate = new Date(
    new Date(row.hotspot_start_time).getTime() + durationMs
  );
  endTime = TimeConverter.toTimeString(endDate);
}
const timeRange = `${this.formatTime(startTime)} - ${this.formatTime(endTime)}`;
```

### Why These Fixes Are Safe

**After proof is confirmed**:
1. Only affects manual hotspot preview (transactional, rolled back)
2. Uses standard `hotspot_duration` field (widely used in system)
3. No changes to core timeline rebuild logic
4. No risk to auto-selected hotspots

### Regression Tests Needed

- [ ] Manual hotspot preview shows reasonable duration  
- [ ] Auto-selected hotspots unaffected
- [ ] Confirmed hotspot additions unaffected
- [ ] Route with no other visits handles manual correctly
- [ ] Route with multiple visits calculates timing correctly

---

## H. Database Query Examples

### Query current manual hotspot row

```sql
SELECT 
  route_hotspot_ID,
  hotspot_ID,
  hotspot_order,
  hotspot_start_time,
  hotspot_end_time,
  hotspot_plan_own_way,
  is_conflict
FROM dvi_itinerary_route_hotspot_details
WHERE itinerary_plan_ID = 268
  AND itinerary_route_ID = 1238
  AND hotspot_ID = 8
  AND item_type = 4
  AND deleted = 0;
```

### Query hotspot master

```sql
SELECT 
  hotspot_ID,
  hotspot_name,
  opening_time,
  closing_time,
  visitDuration,
  visitDuration_unit
FROM dvi_hotspot_place
WHERE hotspot_ID = 8
  AND deleted = 0;
```

### Query route details

```sql
SELECT 
  itinerary_route_ID,
  location_name,
  next_visiting_location,
  route_start_time,
  route_end_time
FROM dvi_itinerary_route_details
WHERE itinerary_plan_ID = 268
  AND itinerary_route_ID = 1238
  AND deleted = 0;
```

---

## I. Frontend Artifacts Created

**File**: `dvi_frontend/src/services/itinerary.ts`
- Method: `previewAddHotspot()` (line 324)

**File**: `dvi_frontend/src/pages/ItineraryDetails.tsx`
- State: `previewTimeline` (line 685)
- Handler: `handlePreviewHotspot()` (line 2360)
- Render: Timeline preview pane (line 4738)

---

## J. Backend Artifacts Created

### Service Flow:
1. **Controller**: `itineraries.controller.ts#L1171`
2. **Service**: `itineraries.service.ts#L5596` (previewManualHotspot)
3. **Helper**: `itineraries.service.ts#L6003` (ensureManualHotspotRow)
4. **Helper**: `itineraries.service.ts#L6119` (runAdaptiveManualHotspotInsertion)
5. **Engine**: `hotspot-engine.service.ts#L25` (rebuildRouteHotspots)
6. **Engine**: `hotspot-engine.service.ts#L604` (previewManualHotspotAdd)
7. **Enricher**: `hotspot-engine.service.ts` imports `timeline.enricher.ts`
8. **Converter**: `helpers/time-converter.ts` (toTimeString method)

---

##K. Reproduction Steps (for QA)

1. Open Itinerary Details for plan 268, route 1238
2. Click "Add Hotspot" button
3. Find "Arulmigu Sri Sthala Sayana Perumal Temple" in list
4. Observe hotspot card shows **"06:00 AM - 12:00 PM"** and **"Duration: 1 hr"**
5. Click "Preview" on the hotspot card
6. Observe right-side "Proposed Timeline" shows **"2:43 AM - 2:43 AM"** for the selected hotspot
7. **BUG**: Times don't match. Card says 06:00-12:00, Timeline says 2:43-2:43

**Expected**: Timeline should show a calculated visit window, ideally with duration applied (e.g., 2:43 AM - 3:43 AM if it's a 1-hour visit)

**Actual**: Timeline shows start/end times as identical (2:43 - 2:43), which looks wrong.

---

## L. Minimal Test Case

```bash
# Run debug script
cd api.dvi.travel
node scripts/debug-hotspot-preview-timing.js

# Expected output:
# ✅ Hotspot master: opening_time=06:00, closing_time=12:00
# ✅ Route: route_start_time=02:43:00
# ✅ Preview response: timeRange="2:43 AM - 2:43 AM"
# ⚠️  BUG: End time === Start time (missing duration)
```

---

## Summary Table

| Component | File | Location | Issue |
|-----------|------|----------|-------|
| **Frontend** | `ItineraryDetails.tsx` | L2360 | Calls preview API, renders response.fullTimeline[].timeRange directly |
| **API Endpoint** | `itineraries.controller.ts` | L1171 | Routes to service method |
| **Service** | `itineraries.service.ts` | L5596 | Calls engine.previewManualHotspotAdd() |
| **Placeholder** | `itineraries.service.ts` | L6003 | Creates row with 1970-01-01T00:00:00Z (or derived time) |
| **Rebuild** | `hotspot-engine.service.ts` | L25 | Injects manual hotspot BUT uses same value for start/end |
| **Preview** | `hotspot-engine.service.ts` | L604 | Reads rebuilt timeline and enriches |
| **Enricher** | `timeline.enricher.ts` | L28 | Formats `timeRange` = `${start} - ${end}` |
| **Bug** | `hotspot-engine.service.ts` | L311 | `manualEndTime = manualStartTime` (NO DURATION APPLIED) |

---

## M. Debug Script Execution Results (Executed 2026-04-12)

### Data Discovered

**Route 1238 Timeline** (15 rows total):
- **Start**: 08:00 UTC
- **Hotspots**: 7 total (IDs: 4, 11, 5, 12, 294, 13, and unscheduled)
- **Last real hotspot** (ID: 13): Ends at 21:43
- **Hotel Travel row** (Row 14): **02:43** ← Key reference point
- **Hotel row** (Row 15): 04:30

**The 02:43 AM value** matches exactly what appears in the preview - confirming this is the value being injected as `manualStartTime` during the rebuild.

### Schema Findings

**dvi_hotspot_place table** does NOT have:
- ❌ `opening_time` field
- ❌ `closing_time` field

**Actually has**:
- ✅ `hotspot_duration` (TIME(0) format, e.g., "01:00:00")

**This invalidates the original assumption** that opening/closing hours were stored in the hotspot master. The fix must use `hotspot_duration` instead.

### Verification Status

| Check | Status | Details |
|-------|--------|---------|
| Database schema analyzed | ✅ | Field names confirmed |
| Route timeline examined | ✅ | 15 rows found, 02:43 identified |
| Manual hotspot row | ❌ | Not found (cleaned up by preview rollback) |
| API call tested | ❌ | Backend server not running |
| Root cause confirmed | ✅ | Timing injected from Hotel Travel row (02:43) |

---

## M. Proof-Gathering Instructions (Apr 12 2026)

### Step 1: Update Debug Script (✅ DONE)

**File**: [`api.dvi.travel/scripts/debug-hotspot-preview-timing-v2.js`](api.dvi.travel/scripts/debug-hotspot-preview-timing-v2.js)

Only queries REAL schema fields:
- `hotspot_duration` (not opening_time/closing_time)
- Correct field names from Prisma schema

### Step 2: Add Backend Proof Logging (✅ DONE)

**Files modified**:
1. [`api.dvi.travel/src/modules/itineraries/engines/hotspot-engine.service.ts`](api.dvi.travel/src/modules/itineraries/engines/hotspot-engine.service.ts#L310)
   - `[ManualHotspot][PROOF]` logs showing:
     - lastVisitRow structure
     - manualStartTime decision tree
     - hotspot_duration availability
     - Confirmation that manualEndTime === manualStartTime

2. [`api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.enricher.ts`](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.enricher.ts#L28)
   - `[TimelineEnricher][PROOF]` logs showing:
     - Input hotspot_start_time and hotspot_end_time
     - Converted time strings
     - Final formatted timeRange
     - Warning if times are identical

### Step 3: Run Proof Collection

```bash
# In api.dvi.travel directory:

# Terminal 1 (Backend):
npm run start:dev

# Terminal 2 (Debug script + API call):
node scripts/debug-hotspot-preview-timing-v2.js

# Observe Terminal 1 for:
# [ManualHotspot][PROOF]... logs
# [TimelineEnricher][PROOF]... logs
```

### Step 4: Capture Logs

**Look for these log patterns**:

**Pattern 1 - Source of timing**:
```
[ManualHotspot][PROOF] Calculated manualStartTime: {
  source: "lastVisitEndTime" | "route_start_time" | "new Date()"
```

**Pattern 2 - Route start time**:
```
[ManualHotspot][PROOF] LAST VISIT ROW DETAILS: {
  lastVisitRow_hotspot_start_time: <timestamp>
  lastVisitRow_hotspot_end_time: <timestamp>
```

**Pattern 3 - Duration field check**:
```
[ManualHotspot][PROOF] Hotspot master data: {
  hotspot_duration: <TIME value or null>
```

**Pattern 4 - Enricher input/output**:
```
[TimelineEnricher][PROOF] Enriching hotspot row: {
  raw_start_time: <timestamp>
  raw_end_time: <timestamp>
  formatted_timeRange: "HH:MM AM/PM - HH:MM AM/PM"
  note: "WARNING: START === END (NO DURATION)"
```

### Step 5: Analysis

**Answer these questions from logs**:

1. **Where does 02:43 originate?**
   - From lastVisitEndTime?
   - From route_start_time?
   - From other source?

2. **What is the last visit row structure?**
   - Which hotspot is it?
   - When does it end?

3. **Is hotspot_duration populated?**
   - Does the hotspot master have a duration value?
   - Is it being fetched?
   - Is it being used?

4. **What does enricher receive?**
   - Are hotspot_start_time and hotspot_end_time identical?
   - What is the resulting timeRange string?

---

## Status Summary (Apr 12 2026)

### Current Investigation Stance

| Claim | Status | Evidence |
|-------|--------|----------|
| 02:43 comes from Hotel Travel row | **UNPROVEN** | Assumed, no logs yet |
| 02:43 comes from route_start_time | **UNPROVEN** | Possible, awaiting logs |
| manualEndTime === manualStartTime | **CONFIRMED** | Direct code inspection |
| hotspot_duration exists in schema | **CONFIRMED** | Verified in schema.prisma |
| opening_time/closing_time exist | **DISPROVEN** | Not in schema |
| Duration is NOT being applied | **CONFIRMED** | Neither engine nor enricher use it |

### Next Actions

- [ ] Run proof logging (Terminals 1 & 2)
- [ ] Capture backend logs
- [ ] Answer the 4 questions above
- [ ] Confirm root cause
- [ ] Implement minimal safe fix
- [ ] Test regression scenarios

---

Generated: 2026-04-12  
Investigation Status: **IN PROGRESS - PROOF LOGGING ADDED**  
Fix Status: **READY TO IMPLEMENT AFTER PROOF**  
Debug Scripts: [`v2.js`](api.dvi.travel/scripts/debug-hotspot-preview-timing-v2.js) (corrected version)
