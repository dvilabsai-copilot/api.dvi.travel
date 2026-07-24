// REPLACE-WHOLE-FILE
// FILE: src/modules/itineraries/engines/itinerary-hotspots.engine.ts

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../../prisma.service";
import {
  ITEM_REFRESH,
  ITEM_TRAVEL_OR_BREAK,
  ITEM_VISIT,
} from "../utils/itinerary.constants";
import {
  buildTravellers,
  combineDateOnlyAndTime,
  computeEntryCost,
  computeTravelParity,
  dateTimeToPrismaTime,
  secondsToPrismaTime,
  timeToSeconds,
  toFloat,
  uniqueTokens,
  resolveTimingForDay,
} from "../utils/itinerary.utils";

/**
 * ✅ BUSINESS RULE (your requirement):
 * For transfer legs like Madurai -> Rameshwaram, user must CHECK-IN to hotel by 10 PM.
 */
const DESTINATION_HOTEL_CHECKIN_CUTOFF_TIME = "22:00:00"; // 10 PM

/**
 * ✅ IMPORTANT (matches your requirement for Madurai->Rameshwaram):
 * We enforce an additional small buffer (default 25 mins) for hotel check-in constraint,
 * instead of using the full global buffers (common+road = 2 hours in your DB),
 * because that would force departure too early (e.g., ~4:55 PM).
 *
 * If you want EXACT 6:30 PM for ~3.5 hours travel:
 * 22:00 - 03:30 - 00:00 = 18:30
 * If you want some safety: use 00:25 (25 mins) -> 18:05
 *
 * Defaulting to 25 mins as per your statement.
 */
const TRANSFER_CHECKIN_BUFFER_MINUTES = 25;

/**
 * Parse dvi_stored_locations.duration into seconds.
 * Supports:
 *  - "49 mins"
 *  - "1 hour 56 mins"
 *  - "3 hours 5 mins"
 *  - "1 day 1 hour"
 *  - "1 day 0 hours"
 *  - "1 day 2 hours 15 mins"
 */
function parseDurationToSeconds(duration: any): number | null {
  if (duration == null) return null;

 // If duration is already numeric (some rows might store minutes)
  if (typeof duration === "number" && Number.isFinite(duration)) {
 // interpret as minutes (legacy behavior)
    return Math.max(0, Math.floor(duration)) * 60;
  }

  const s = String(duration).trim().toLowerCase();
  if (!s) return null;

  let days = 0;
  let hours = 0;
  let mins = 0;

  const dMatch = s.match(/(\d+)\s*day/);
  const hMatch = s.match(/(\d+)\s*hour/);
  const mMatch = s.match(/(\d+)\s*min/);

  if (dMatch) days = Number(dMatch[1] || 0);
  if (hMatch) hours = Number(hMatch[1] || 0);
  if (mMatch) mins = Number(mMatch[1] || 0);

  if (!dMatch && !hMatch && !mMatch) {
 // Last resort: if it's a plain number string, treat as minutes
    const n = Number(s);
    if (Number.isFinite(n)) return Math.max(0, Math.floor(n)) * 60;
    return null;
  }

  return days * 86400 + hours * 3600 + mins * 60;
}

/**
 * Convert JS day-of-week (Sun=0..Sat=6) to hotspot_timing_day (Mon=0..Sun=6).
 */
function toHotspotTimingDay(dateOnly: Date): number {
 const js = dateOnly.getDay(); // Sun=0..Sat=6
 return (js + 6) % 7; // Mon=0..Sun=6
}

/**
 * Build a cutoff Date on the given dateOnly with HH:MM:SS.
 */
function buildCutoffOnDate(dateOnly: Date, timeHHMMSS: string): Date {
  const [hh, mm, ss] = String(timeHHMMSS || "00:00:00")
    .split(":")
    .map((x) => Number(x || 0));
  const d = new Date(dateOnly);
  d.setHours(hh || 0, mm || 0, ss || 0, 0);
  return d;
}

@Injectable()
export class ItineraryHotspotsEngine {
  constructor(private readonly prisma: PrismaService) {}

  async rebuildHotspots(opts: {
    planId: number;
    routeId?: number;
    limit?: number;
  }) {
    const planId = Number(opts.planId);
    if (!planId) throw new BadRequestException("Invalid planId");

    const plan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: planId },
    });
    if (!plan) throw new NotFoundException(`Plan ${planId} not found`);

    const routes = await this.prisma.dvi_itinerary_route_details.findMany({
      where: {
        itinerary_plan_ID: planId,
        deleted: 0,
        ...(opts.routeId ? { itinerary_route_ID: opts.routeId } : {}),
      },
      orderBy: { itinerary_route_ID: "asc" },
    });

    const results: any[] = [];

    for (const route of routes) {
      const res = await this.prisma.$transaction(async (tx) => {
        await this.deleteRouteHotspotData(tx, planId, route.itinerary_route_ID);

 // REFRESH ROW (always first)
        await tx.dvi_itinerary_route_hotspot_details.create({
          data: {
            itinerary_plan_ID: planId,
            itinerary_route_ID: route.itinerary_route_ID,
            item_type: ITEM_REFRESH,
            hotspot_order: 1,
            hotspot_ID: 0,
            allow_break_hours: 0,
            allow_via_route: 0,
            hotspot_plan_own_way: 0,
            hotspot_traveling_time: secondsToPrismaTime(0),
            itinerary_travel_type_buffer_time: secondsToPrismaTime(0),
            hotspot_start_time: secondsToPrismaTime(0),
            hotspot_end_time: secondsToPrismaTime(0),
            hotspot_travelling_distance: null,
            createdby: plan.createdby ?? 0,
            createdon: new Date(),
            status: 1,
            deleted: 0,
          } as Prisma.dvi_itinerary_route_hotspot_detailsUncheckedCreateInput,
        });

        const dayDate = route.itinerary_route_date;
        if (!dayDate)
          return { routeId: route.itinerary_route_ID, insertedVisits: 0 };

        const dayStart = combineDateOnlyAndTime(
          dayDate,
          route.route_start_time,
          "09:00:00",
        );
        const dayEnd = combineDateOnlyAndTime(
          dayDate,
          route.route_end_time,
          "20:00:00",
        );

 // Check-in cutoff: 10 PM on destination for transfer legs
        const checkinCutoff = buildCutoffOnDate(
          dayDate,
          DESTINATION_HOTEL_CHECKIN_CUTOFF_TIME,
        );

 // -------------------- Transfer depart cutoff --------------------
 // latestDepart = checkinCutoff - (travelSeconds + smallCheckinBufferSeconds)
 //
 // travelSeconds comes from dvi_stored_locations.duration (string)
 // smallCheckinBufferSeconds is TRANSFER_CHECKIN_BUFFER_MINUTES (25 mins by default)
        let transferDayLatestDepart: Date | null = null;

        const routeSource = String(route.location_name ?? "").trim();
        const routeDest = String(route.next_visiting_location ?? "").trim();

 // (Optional) We still read GS for future parity/debugging, but we DO NOT use 1h+1h here.
 // Using GS common_buf+road_buf would force too-early departures (your exact issue).
        await (tx as any).dvi_global_settings?.findFirst?.({
          where: { deleted: 0, status: 1 },
          orderBy: { global_settings_ID: "desc" },
          select: {
            itinerary_common_buffer_time: true,
            itinerary_travel_by_road_buffer_time: true,
            itinerary_outstation_speed_limit: true,
            itinerary_local_speed_limit: true,
          },
        });

        if (routeSource && routeDest) {
 // Exact match first (your DB has exact: 'Madurai Airport' -> 'Rameswaram')
          let storedLocation = await tx.dvi_stored_locations.findFirst({
            where: {
              deleted: 0,
              status: 1,
              source_location: routeSource,
              destination_location: routeDest,
            },
            orderBy: { location_ID: "desc" },
          });

 // Safe fallback: contains (helps when strings differ slightly)
          if (!storedLocation) {
            storedLocation = await tx.dvi_stored_locations.findFirst({
              where: {
                deleted: 0,
                status: 1,
                source_location: { contains: routeSource },
                destination_location: { contains: routeDest },
              },
              orderBy: { location_ID: "desc" },
            });
          }

          const travelSeconds = parseDurationToSeconds(
            storedLocation?.duration ?? null,
          );

          if (travelSeconds != null && travelSeconds > 0) {
            const totalSeconds =
              travelSeconds + TRANSFER_CHECKIN_BUFFER_MINUTES * 60;

            transferDayLatestDepart = new Date(
              checkinCutoff.getTime() - totalSeconds * 1000,
            );
          }
        }

 // -------------------- Assigned hotel coords (optional) --------------------
 // NOTE: not required for your city transfer check-in cutoff rule, kept for future.
        let hotelLat: number | null = null;
        let hotelLng: number | null = null;

        const assignedHotel =
          await tx.dvi_itinerary_plan_hotel_details.findFirst({
            where: {
              itinerary_plan_id: planId,
              itinerary_route_id: route.itinerary_route_ID,
              deleted: 0,
              status: 1,
            },
            select: { hotel_id: true },
            orderBy: { itinerary_plan_hotel_details_ID: "desc" },
          });

        if (assignedHotel?.hotel_id) {
          const hotel = await tx.dvi_hotel.findUnique({
            where: { hotel_id: assignedHotel.hotel_id },
            select: { hotel_latitude: true, hotel_longitude: true },
          });

          hotelLat = toFloat((hotel as any)?.hotel_latitude);
          hotelLng = toFloat((hotel as any)?.hotel_longitude);
        }

 // -------------------- Location tokens for hotspot filtering --------------------
        const viaRows = await tx.dvi_itinerary_via_route_details.findMany({
          where: {
            itinerary_plan_ID: planId,
            itinerary_route_ID: route.itinerary_route_ID,
            deleted: 0,
          },
          select: { itinerary_via_location_name: true },
        });

        const tokens = uniqueTokens([
          route.location_name ?? "",
          route.next_visiting_location ?? "",
          ...viaRows.map((v) => v.itinerary_via_location_name ?? ""),
        ]);

 // -------------------- Timings + candidate hotspots for this day --------------------
        const timingDay = toHotspotTimingDay(dayDate);

        const timings = await tx.dvi_hotspot_timing.findMany({
          where: {
            deleted: 0,
            status: 1,
            hotspot_closed: 0,
            hotspot_timing_day: timingDay,
          },
        });

        const candidateIds = Array.from(
          new Set(timings.map((t) => t.hotspot_ID).filter(Boolean)),
        );

        const hotspots = candidateIds.length
          ? await tx.dvi_hotspot_place.findMany({
              where: {
                deleted: 0,
                status: 1,
                hotspot_ID: { in: candidateIds },
                ...(tokens.length
                  ? {
                      OR: tokens.map((t) => ({
                        hotspot_location: { contains: t },
                      })),
                    }
                  : {}),
              },
              orderBy: { hotspot_priority: "desc" },
            })
          : [];

 // Cursor = where we are currently in time + place
        let cursor = {
          time: dayStart,
          lat: null as number | null,
          lng: null as number | null,
          locationText: String(route.location_name ?? ""),
        };

 let order = 1; // refresh used 1
        let insertedVisits = 0;

        for (const h of hotspots) {
 // Hard cap: max 3 VISIT rows/day
          if (insertedVisits >= 3) break;

          const hLat = toFloat(h.hotspot_latitude);
          const hLng = toFloat(h.hotspot_longitude);
          if (hLat == null || hLng == null) continue;

 // Already inserted?
          const exists = await tx.dvi_itinerary_route_hotspot_details.findFirst({
            where: {
              itinerary_plan_ID: planId,
              itinerary_route_ID: route.itinerary_route_ID,
              hotspot_ID: h.hotspot_ID,
              deleted: 0,
            },
          });
          if (exists) continue;

          const travelToAnchor = computeTravelParity({
            prevLat: cursor.lat,
            prevLng: cursor.lng,
            prevLocation: cursor.locationText,
            nextLat: hLat,
            nextLng: hLng,
            nextLocation: String(h.hotspot_location ?? ""),
          });

          const durationSeconds = timeToSeconds(h.hotspot_duration) ?? 3600;

          const earliestArrival = new Date(
            cursor.time.getTime() + travelToAnchor.travelSeconds * 1000,
          );

          const timingDecision = resolveTimingForDay(
            dayDate,
            timings.filter((t) => t.hotspot_ID === h.hotspot_ID),
            earliestArrival,
            durationSeconds,
          );
          if (!timingDecision.allowed) continue;

          const visitStart = timingDecision.visitStart;
          const visitEnd = new Date(
            visitStart.getTime() + durationSeconds * 1000,
          );
          if (visitEnd > dayEnd) continue;

 // Your constraint:
 // hotspots must end by transferDayLatestDepart so that after leaving,
 // travel+buffer reaches destination by 10 PM.
          if (transferDayLatestDepart && visitEnd > transferDayLatestDepart) {
            const isPriority = Number(h.hotspot_priority ?? 0) > 0;
            if (isPriority) break;
            continue;
          }

 // Optional extra conservative guard (kept)
          if (hotelLat != null && hotelLng != null) {
            const returnToHotel = computeTravelParity({
              prevLat: hLat,
              prevLng: hLng,
              prevLocation: String(h.hotspot_location ?? ""),
              nextLat: hotelLat,
              nextLng: hotelLng,
              nextLocation: "hotel",
            });

            const projectedHotelArrival = new Date(
              visitEnd.getTime() + returnToHotel.travelSeconds * 1000,
            );

            if (projectedHotelArrival > checkinCutoff) {
              const isPriority = Number(h.hotspot_priority ?? 0) > 0;
              if (isPriority) break;
              continue;
            }
          }

 // LEAVE-LATE: travel should start as late as possible to arrive at visitStart
          const latestDepartForAnchor = new Date(
            visitStart.getTime() - travelToAnchor.travelSeconds * 1000,
          );
          const gapSeconds =
            (latestDepartForAnchor.getTime() - cursor.time.getTime()) / 1000;

          let fillerInserted = false;

 // Need capacity for (filler + anchor)
          if (gapSeconds > 300 && insertedVisits + 2 <= 3) {
            const filler = await this.tryFindFillerHotspotLeaveLate({
              tx,
              plan,
              planId,
              routeId: route.itinerary_route_ID,
              dayDate,
              dayEnd,
              timingsForDay: timings,
              allHotspots: hotspots,
              currentCursor: cursor,
              anchor: { id: h.hotspot_ID, lat: hLat, lng: hLng, visitStart },
              transferDayLatestDepart,
            });

            if (filler) {
              const travelToFillerStart = new Date(
                filler.fillerVisitStart.getTime() -
                  filler.travelToFiller.travelSeconds * 1000,
              );

              order++;
              await tx.dvi_itinerary_route_hotspot_details.create({
                data: {
                  itinerary_plan_ID: planId,
                  itinerary_route_ID: route.itinerary_route_ID,
                  item_type: ITEM_TRAVEL_OR_BREAK,
                  hotspot_order: order,
                  hotspot_ID: filler.hotspot.hotspot_ID,
                  allow_break_hours: 0,
                  allow_via_route: 0,
                  hotspot_plan_own_way: 0,
                  hotspot_traveling_time: secondsToPrismaTime(
                    filler.travelToFiller.travelSeconds,
                  ),
                  itinerary_travel_type_buffer_time: secondsToPrismaTime(0),
                  hotspot_travelling_distance:
                    filler.travelToFiller.distanceKm.toFixed(2),
                  hotspot_start_time: dateTimeToPrismaTime(travelToFillerStart),
                  hotspot_end_time: dateTimeToPrismaTime(
                    filler.fillerVisitStart,
                  ),
                  createdby: plan.createdby ?? 0,
                  createdon: new Date(),
                  status: 1,
                  deleted: 0,
                } as Prisma.dvi_itinerary_route_hotspot_detailsUncheckedCreateInput,
              });

              order++;
              const fillerVisit =
                await tx.dvi_itinerary_route_hotspot_details.create({
                  data: {
                    itinerary_plan_ID: planId,
                    itinerary_route_ID: route.itinerary_route_ID,
                    item_type: ITEM_VISIT,
                    hotspot_order: order,
                    hotspot_ID: filler.hotspot.hotspot_ID,
                    hotspot_amout: filler.entry.totalAmount,
                    hotspot_start_time: dateTimeToPrismaTime(
                      filler.fillerVisitStart,
                    ),
                    hotspot_end_time: dateTimeToPrismaTime(
                      filler.fillerVisitEnd,
                    ),
                    createdby: plan.createdby ?? 0,
                    createdon: new Date(),
                    status: 1,
                    deleted: 0,
                  },
                  select: { route_hotspot_ID: true },
                });

              if (filler.entry.totalAmount > 0) {
                const travellers = buildTravellers(
                  Number(plan.total_adult),
                  Number(plan.total_children),
                  Number(plan.total_infants),
                );

                for (const tr of travellers) {
                  const cost = filler.entry.costByTravellerType[tr.type] ?? 0;
                  if (cost > 0) {
                    await tx.dvi_itinerary_route_hotspot_entry_cost_details.create(
                      {
                        data: {
                          route_hotspot_id: fillerVisit.route_hotspot_ID,
                          hotspot_ID: filler.hotspot.hotspot_ID,
                          itinerary_plan_id: planId,
                          itinerary_route_id: route.itinerary_route_ID,
                          traveller_type: tr.type,
                          traveller_name: tr.name,
                          entry_ticket_cost: cost,
                          createdby: plan.createdby ?? 0,
                          createdon: new Date(),
                          status: 1,
                          deleted: 0,
                        },
                      },
                    );
                  }
                }
              }

              insertedVisits++;

              cursor = {
                time: filler.fillerVisitEnd,
                lat: toFloat(filler.hotspot.hotspot_latitude),
                lng: toFloat(filler.hotspot.hotspot_longitude),
                locationText: String(filler.hotspot.hotspot_location ?? ""),
              };

              const travelFillerToAnchor = computeTravelParity({
                prevLat: cursor.lat,
                prevLng: cursor.lng,
                prevLocation: cursor.locationText,
                nextLat: hLat,
                nextLng: hLng,
                nextLocation: String(h.hotspot_location ?? ""),
              });

              const latestDepartFromFillerToAnchor = new Date(
                visitStart.getTime() -
                  travelFillerToAnchor.travelSeconds * 1000,
              );

              if (cursor.time <= latestDepartFromFillerToAnchor) {
                order++;
                await tx.dvi_itinerary_route_hotspot_details.create({
                  data: {
                    itinerary_plan_ID: planId,
                    itinerary_route_ID: route.itinerary_route_ID,
                    item_type: ITEM_TRAVEL_OR_BREAK,
                    hotspot_order: order,
                    hotspot_ID: h.hotspot_ID,
                    allow_break_hours: 0,
                    allow_via_route: 0,
                    hotspot_plan_own_way: 0,
                    hotspot_traveling_time: secondsToPrismaTime(
                      travelFillerToAnchor.travelSeconds,
                    ),
                    itinerary_travel_type_buffer_time: secondsToPrismaTime(0),
                    hotspot_travelling_distance:
                      travelFillerToAnchor.distanceKm.toFixed(2),
                    hotspot_start_time: dateTimeToPrismaTime(
                      latestDepartFromFillerToAnchor,
                    ),
                    hotspot_end_time: dateTimeToPrismaTime(visitStart),
                    createdby: plan.createdby ?? 0,
                    createdon: new Date(),
                    status: 1,
                    deleted: 0,
                  } as Prisma.dvi_itinerary_route_hotspot_detailsUncheckedCreateInput,
                });

                fillerInserted = true;
              }
            }
          }

          if (!fillerInserted) {
            order++;
            await tx.dvi_itinerary_route_hotspot_details.create({
              data: {
                itinerary_plan_ID: planId,
                itinerary_route_ID: route.itinerary_route_ID,
                item_type: ITEM_TRAVEL_OR_BREAK,
                hotspot_order: order,
                hotspot_ID: h.hotspot_ID,
                allow_break_hours: 0,
                allow_via_route: 0,
                hotspot_plan_own_way: 0,
                hotspot_traveling_time: secondsToPrismaTime(
                  travelToAnchor.travelSeconds,
                ),
                itinerary_travel_type_buffer_time: secondsToPrismaTime(0),
                hotspot_travelling_distance: travelToAnchor.distanceKm.toFixed(2),
                hotspot_start_time: dateTimeToPrismaTime(latestDepartForAnchor),
                hotspot_end_time: dateTimeToPrismaTime(visitStart),
                createdby: plan.createdby ?? 0,
                createdon: new Date(),
                status: 1,
                deleted: 0,
              } as Prisma.dvi_itinerary_route_hotspot_detailsUncheckedCreateInput,
            });
          }

          const entry = computeEntryCost({
            entryTicketRequired: Number(plan.entry_ticket_required) === 1,
            nationality: Number(plan.nationality),
            adults: Number(plan.total_adult),
            children: Number(plan.total_children),
            infants: Number(plan.total_infants),
            hotspot: h,
          });

          order++;
          const visit = await tx.dvi_itinerary_route_hotspot_details.create({
            data: {
              itinerary_plan_ID: planId,
              itinerary_route_ID: route.itinerary_route_ID,
              item_type: ITEM_VISIT,
              hotspot_order: order,
              hotspot_ID: h.hotspot_ID,
              hotspot_amout: entry.totalAmount,
              hotspot_start_time: dateTimeToPrismaTime(visitStart),
              hotspot_end_time: dateTimeToPrismaTime(visitEnd),
              createdby: plan.createdby ?? 0,
              createdon: new Date(),
              status: 1,
              deleted: 0,
            },
            select: { route_hotspot_ID: true },
          });

          if (entry.totalAmount > 0) {
            const travellers = buildTravellers(
              Number(plan.total_adult),
              Number(plan.total_children),
              Number(plan.total_infants),
            );
            for (const tr of travellers) {
              const cost = entry.costByTravellerType[tr.type] ?? 0;
              if (cost > 0) {
                await tx.dvi_itinerary_route_hotspot_entry_cost_details.create({
                  data: {
                    route_hotspot_id: visit.route_hotspot_ID,
                    hotspot_ID: h.hotspot_ID,
                    itinerary_plan_id: planId,
                    itinerary_route_id: route.itinerary_route_ID,
                    traveller_type: tr.type,
                    traveller_name: tr.name,
                    entry_ticket_cost: cost,
                    createdby: plan.createdby ?? 0,
                    createdon: new Date(),
                    status: 1,
                    deleted: 0,
                  },
                });
              }
            }
          }

          insertedVisits++;

          cursor = {
            time: visitEnd,
            locationText: String(h.hotspot_location ?? ""),
            lat: hLat,
            lng: hLng,
          };
        }

        return {
          routeId: route.itinerary_route_ID,
          insertedVisits,
          transferDayLatestDepart,
          checkinCutoff,
        };
      });

      results.push(res);
    }

    return { planId, routes: results };
  }

  private async tryFindFillerHotspotLeaveLate(args: {
    tx: Prisma.TransactionClient;
    plan: any;
    planId: number;
    routeId: number;
    dayDate: Date;
    dayEnd: Date;
    timingsForDay: any[];
    allHotspots: any[];
    currentCursor: {
      time: Date;
      lat: number | null;
      lng: number | null;
      locationText: string;
    };
    anchor: { id: number; lat: number; lng: number; visitStart: Date };
    transferDayLatestDepart: Date | null;
  }): Promise<{
    hotspot: any;
    travelToFiller: { travelSeconds: number; distanceKm: number };
    fillerVisitStart: Date;
    fillerVisitEnd: Date;
    entry: any;
  } | null> {
    const {
      tx,
      plan,
      planId,
      routeId,
      dayDate,
      dayEnd,
      timingsForDay,
      allHotspots,
      currentCursor,
      anchor,
      transferDayLatestDepart,
    } = args;

    for (const candidate of allHotspots) {
      if (candidate.hotspot_ID === anchor.id) continue;

      const cLat = toFloat(candidate.hotspot_latitude);
      const cLng = toFloat(candidate.hotspot_longitude);
      if (cLat == null || cLng == null) continue;

      const alreadyExists =
        await tx.dvi_itinerary_route_hotspot_details.findFirst({
          where: {
            itinerary_plan_ID: planId,
            itinerary_route_ID: routeId,
            hotspot_ID: candidate.hotspot_ID,
            deleted: 0,
          },
        });
      if (alreadyExists) continue;

      const travelToFiller = computeTravelParity({
        prevLat: currentCursor.lat,
        prevLng: currentCursor.lng,
        prevLocation: currentCursor.locationText,
        nextLat: cLat,
        nextLng: cLng,
        nextLocation: String(candidate.hotspot_location ?? ""),
      });

      const fillerDurationSeconds =
        timeToSeconds(candidate.hotspot_duration) ?? 3600;

      const earliestArrivalAtFiller = new Date(
        currentCursor.time.getTime() + travelToFiller.travelSeconds * 1000,
      );

      const fillerTimings = timingsForDay.filter(
        (t) => t.hotspot_ID === candidate.hotspot_ID,
      );
      const fillerTimingDecision = resolveTimingForDay(
        dayDate,
        fillerTimings,
        earliestArrivalAtFiller,
        fillerDurationSeconds,
      );
      if (!fillerTimingDecision.allowed) continue;

      const fillerVisitStart = fillerTimingDecision.visitStart;
      const fillerVisitEnd = new Date(
        fillerVisitStart.getTime() + fillerDurationSeconds * 1000,
      );

      if (fillerVisitEnd > dayEnd) continue;

 // Respect transfer cutoff for filler end
      if (transferDayLatestDepart && fillerVisitEnd > transferDayLatestDepart)
        continue;

      const travelFillerToAnchor = computeTravelParity({
        prevLat: cLat,
        prevLng: cLng,
        prevLocation: String(candidate.hotspot_location ?? ""),
        nextLat: anchor.lat,
        nextLng: anchor.lng,
        nextLocation: "anchor",
      });

      const latestDepartFromFillerToAnchor = new Date(
        anchor.visitStart.getTime() -
          travelFillerToAnchor.travelSeconds * 1000,
      );
      if (fillerVisitEnd > latestDepartFromFillerToAnchor) continue;

      const entry = computeEntryCost({
        entryTicketRequired: Number(plan.entry_ticket_required) === 1,
        nationality: Number(plan.nationality),
        adults: Number(plan.total_adult),
        children: Number(plan.total_children),
        infants: Number(plan.total_infants),
        hotspot: candidate,
      });

      return {
        hotspot: candidate,
        travelToFiller,
        fillerVisitStart,
        fillerVisitEnd,
        entry,
      };
    }

    return null;
  }

  private async deleteRouteHotspotData(
    tx: Prisma.TransactionClient,
    planId: number,
    routeId: number,
  ) {
    await Promise.all([
      tx.dvi_itinerary_route_hotspot_entry_cost_details.deleteMany({
        where: { itinerary_plan_id: planId, itinerary_route_id: routeId },
      }),
      tx.dvi_itinerary_route_hotspot_parking_charge.deleteMany({
        where: { itinerary_plan_ID: planId, itinerary_route_ID: routeId },
      }),
      tx.dvi_itinerary_route_activity_entry_cost_details.deleteMany({
        where: { itinerary_plan_id: planId, itinerary_route_id: routeId },
      }),
      tx.dvi_itinerary_route_activity_details.deleteMany({
        where: { itinerary_plan_ID: planId, itinerary_route_ID: routeId },
      }),
      tx.dvi_itinerary_route_hotspot_details.deleteMany({
        where: { itinerary_plan_ID: planId, itinerary_route_ID: routeId },
      }),
    ]);
  }
}
