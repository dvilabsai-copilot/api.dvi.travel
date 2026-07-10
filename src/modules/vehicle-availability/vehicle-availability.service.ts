import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { resolveCityRecordByName } from '../itineraries/utils/city-normalization.util';
import { VehicleAvailabilityQueryDto } from './dto/vehicle-availability-query.dto';
import {
  VehicleAvailabilityResponseDto,
  VehicleAvailabilityRowDto,
  VehicleAvailabilityCellDto,
  VehicleAvailabilityRouteSegmentDto,
} from './dto/vehicle-availability-response.dto';

type Nullable<T> = T | null;

@Injectable()
export class VehicleAvailabilityService {
  constructor(private readonly prisma: PrismaService) {}

  private async resolveCityByLabel(labelRaw: string): Promise<{
    id: number;
    state_id: number | null;
    name: string;
  } | null> {
    return resolveCityRecordByName(this.prisma, labelRaw);
  }

  // ===========================================================================
  // DATE HELPERS
  // ===========================================================================
  private pad(n: number): string {
    return n.toString().padStart(2, '0');
  }
  private toYmd(d: Date): string {
    return `${d.getFullYear()}-${this.pad(d.getMonth() + 1)}-${this.pad(d.getDate())}`;
  }
  private getDefaultMonthRange(): { dateFrom: string; dateTo: string } {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return { dateFrom: this.toYmd(first), dateTo: this.toYmd(last) };
  }
  private buildDatesArray(dateFrom: string, dateTo: string): string[] {
    const dates: string[] = [];
    const start = new Date(`${dateFrom}T00:00:00.000Z`);
    const end = new Date(`${dateTo}T00:00:00.000Z`);
    for (let d = new Date(start.getTime()); d.getTime() <= end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
      dates.push(this.toYmd(d));
    }
    return dates;
  }
  private toDateRange(dateFrom: string, dateTo: string) {
    return {
      from: new Date(`${dateFrom}T00:00:00.000Z`),
      to: new Date(`${dateTo}T23:59:59.999Z`),
    };
  }
  private nowSql(): Date {
    return new Date();
  }

  private normalizeNumberArray(value: number | number[] | null | undefined): number[] {
    if (value === undefined || value === null) return [];
    const items = Array.isArray(value) ? value : [value];
    return items
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item) && item > 0);
  }

  private normalizeStringArray(value: string | string[] | null | undefined): string[] {
    if (value === undefined || value === null) return [];
    const items = Array.isArray(value) ? value : [value];
    return items
      .map((item) => String(item).trim())
      .filter((item) => item.length > 0);
  }

  private formatDateLabel(input: Date | string | null | undefined): string {
    if (!input) return '';
    const date = input instanceof Date ? input : new Date(input);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(date);
  }

  private formatTimeLabel(input: Date | string | null | undefined): string {
    if (!input) return '';
    const date = input instanceof Date ? input : new Date(input);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(date);
  }

  // ===========================================================================
  // CORE AVAILABILITY
  // ===========================================================================
  async getVehicleAvailabilityChart(query: VehicleAvailabilityQueryDto): Promise<VehicleAvailabilityResponseDto> {
    const vendorIds = this.normalizeNumberArray(query.vendorIds);
    const vehicleTypeIds = this.normalizeNumberArray(query.vehicleTypeIds);
    const agentIds = this.normalizeNumberArray(query.agentIds);
    const locationLabels = [
      ...this.normalizeStringArray(query.locationLabels),
      ...this.normalizeStringArray(query.locationLabel),
      ...this.normalizeStringArray(query.locationId),
    ];

    const vendorId = Number(query.vendorId ?? 0) > 0 ? Number(query.vendorId) : 0;
    const vehicleTypeId = Number(query.vehicleTypeId ?? 0) > 0 ? Number(query.vehicleTypeId) : 0;
    const agentId = Number(query.agentId ?? 0) > 0 ? Number(query.agentId) : 0;
    const activeVendorIds = vendorIds.length > 0 ? vendorIds : vendorId > 0 ? [vendorId] : [];
    const activeVehicleTypeIds = vehicleTypeIds.length > 0 ? vehicleTypeIds : vehicleTypeId > 0 ? [vehicleTypeId] : [];
    const activeAgentIds = agentIds.length > 0 ? agentIds : agentId > 0 ? [agentId] : [];

    const { dateFrom, dateTo } = (() => {
      if (query.dateFrom && query.dateTo) return { dateFrom: query.dateFrom, dateTo: query.dateTo };
      return this.getDefaultMonthRange();
    })();

    const dates = this.buildDatesArray(dateFrom, dateTo);
    const { from: rangeFrom, to: rangeTo } = this.toDateRange(dateFrom, dateTo);
    const todayYmd = this.toYmd(new Date());

    // ITINERARIES
    const itineraries = await this.prisma.dvi_confirmed_itinerary_plan_details.findMany({
      where: {
        status: 1,
        deleted: 0,
        itinerary_preference: { in: [2, 3] },
        ...(activeAgentIds.length > 0 ? { agent_id: { in: activeAgentIds } } : {}),
        OR: [
          { trip_start_date_and_time: { gte: rangeFrom, lte: rangeTo } },
          { trip_end_date_and_time: { gte: rangeFrom, lte: rangeTo } },
        ],
      },
      orderBy: { trip_start_date_and_time: 'asc' },
    });
    if (itineraries.length === 0) return { dates, rows: [] };

    const itineraryById = new Map<number, any>();
    for (const it of itineraries as any[]) itineraryById.set(it.itinerary_plan_ID, it);
    let filteredItineraryIds = Array.from(itineraryById.keys());

    // ROUTE DETAILS
    const routes = await this.prisma.dvi_confirmed_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: { in: filteredItineraryIds }, status: 1, deleted: 0 },
    });
    const routesByItineraryAndDate = new Map<string, any[]>();
    for (const r of routes as any[]) {
      const itId: number = r.itinerary_plan_ID;
      const dateObj =
        r.itinerary_route_date instanceof Date ? (r.itinerary_route_date as Date) : new Date(r.itinerary_route_date);
      const day = this.toYmd(dateObj);
      const key = `${itId}-${day}`;
      if (!routesByItineraryAndDate.has(key)) routesByItineraryAndDate.set(key, []);
      routesByItineraryAndDate.get(key)!.push(r);
    }

    // Optional location filter parity (PHP uses route location_name/next_visiting_location)
    if (locationLabels.length > 0) {
      const needles = new Set(locationLabels.map((label) => label.trim().toLowerCase()));
      const matched = new Set<number>();
      for (const r of routes as any[]) {
        const a = String(r.location_name ?? '').trim().toLowerCase();
        const b = String(r.next_visiting_location ?? '').trim().toLowerCase();
        if (needles.has(a) || needles.has(b)) {
          matched.add(Number(r.itinerary_plan_ID));
        }
      }
      filteredItineraryIds = filteredItineraryIds.filter((id) => matched.has(id));
      if (filteredItineraryIds.length === 0) return { dates, rows: [] };
    }

    const customerRows = await this.prisma.dvi_confirmed_itinerary_customer_details.findMany({
      where: {
        itinerary_plan_ID: { in: filteredItineraryIds },
        primary_customer: 1,
        status: 1,
        deleted: 0,
      },
      select: {
        itinerary_plan_ID: true,
        customer_salutation: true,
        customer_name: true,
        primary_contact_no: true,
      },
    });
    const customerByItinerary = new Map<number, { customerName: string; customerContactNo: string; customerLabel: string }>();
    for (const customer of customerRows as any[]) {
      const salutation = String(customer.customer_salutation ?? '').trim();
      const name = String(customer.customer_name ?? '').trim();
      const contact = String(customer.primary_contact_no ?? '').trim();
      const customerLabel = [salutation, name].filter(Boolean).join(' ').trim();
      customerByItinerary.set(Number(customer.itinerary_plan_ID), {
        customerName: customerLabel || name || '',
        customerContactNo: contact,
        customerLabel: contact ? `${customerLabel || name || 'Guest'} | ${contact}` : customerLabel || name || '',
      });
    }

    const hotelPlanRows = await this.prisma.dvi_confirmed_itinerary_plan_hotel_details.findMany({
      where: {
        itinerary_plan_id: { in: filteredItineraryIds },
        status: 1,
        deleted: 0,
      },
      select: {
        itinerary_plan_id: true,
        itinerary_route_date: true,
        hotel_id: true,
      },
    });
    const hotelIds = Array.from(
      new Set(
        (hotelPlanRows as any[])
          .map((row) => Number(row.hotel_id ?? 0))
          .filter((id) => id > 0),
      ),
    );
    const hotelRows = hotelIds.length
      ? await this.prisma.dvi_hotel.findMany({
          where: { hotel_id: { in: hotelIds } },
          select: { hotel_id: true, hotel_name: true },
        })
      : [];
    const hotelNameById = new Map<number, string>();
    for (const hotel of hotelRows as any[]) {
      hotelNameById.set(Number(hotel.hotel_id), String(hotel.hotel_name ?? ''));
    }
    const hotelNameByItineraryDay = new Map<string, string>();
    for (const row of hotelPlanRows as any[]) {
      const itineraryDay = this.toYmd(
        row.itinerary_route_date instanceof Date
          ? (row.itinerary_route_date as Date)
          : new Date(row.itinerary_route_date),
      );
      const hotelName = hotelNameById.get(Number(row.hotel_id ?? 0)) ?? '';
      if (!hotelName) continue;
      const key = `${Number(row.itinerary_plan_id)}-${itineraryDay}`;
      if (!hotelNameByItineraryDay.has(key)) {
        hotelNameByItineraryDay.set(key, hotelName);
      }
    }

    type ItineraryVendorTypeLink = { itinerary_plan_id: number; vendor_id: number; vehicle_type_id: number };

    const vendorVehicleTypeRowsForLookup = await this.prisma.dvi_vendor_vehicle_types.findMany({
      where: {
        status: 1,
        deleted: { in: [0, 1] },
        ...(activeVendorIds.length > 0 ? { vendor_id: { in: activeVendorIds } } : {}),
      },
      select: { vendor_vehicle_type_ID: true, vendor_id: true, vehicle_type_id: true },
      orderBy: { vendor_vehicle_type_ID: 'asc' },
    });

    const vendorVehicleTypeIdSet = new Set<number>();
    const masterTypeIdToVendorVehicleTypeIdsByVendor = new Map<string, number[]>();

    for (const row of vendorVehicleTypeRowsForLookup as any[]) {
      const vendorVehicleTypeId = Number(row.vendor_vehicle_type_ID ?? 0);
      const vendorId = Number(row.vendor_id ?? 0);
      const masterTypeId = Number(row.vehicle_type_id ?? 0);

      if (vendorVehicleTypeId > 0) {
        vendorVehicleTypeIdSet.add(vendorVehicleTypeId);
      }

      if (vendorId > 0 && masterTypeId > 0 && vendorVehicleTypeId > 0) {
        const mapKey = `${vendorId}-${masterTypeId}`;
        if (!masterTypeIdToVendorVehicleTypeIdsByVendor.has(mapKey)) {
          masterTypeIdToVendorVehicleTypeIdsByVendor.set(mapKey, []);
        }
        masterTypeIdToVendorVehicleTypeIdsByVendor.get(mapKey)!.push(vendorVehicleTypeId);
      }
    }

    const resolveVendorVehicleTypeId = (vendorId: number, rawVehicleTypeId: number): number => {
      if (vendorVehicleTypeIdSet.has(rawVehicleTypeId)) {
        return rawVehicleTypeId;
      }

      const mappedVendorVehicleTypeIds = masterTypeIdToVendorVehicleTypeIdsByVendor.get(`${vendorId}-${rawVehicleTypeId}`) || [];
      return mappedVendorVehicleTypeIds[0] ?? rawVehicleTypeId;
    };

    const expandVehicleTypeFilterIds = (requestedIds: number[]): number[] => {
      if (requestedIds.length === 0) return [];

      const normalized = new Set<number>();
      for (const rawId of requestedIds) {
        const numericRawId = Number(rawId);
        if (!Number.isFinite(numericRawId) || numericRawId <= 0) continue;

        if (vendorVehicleTypeIdSet.has(numericRawId)) {
          normalized.add(numericRawId);
          continue;
        }

        for (const row of vendorVehicleTypeRowsForLookup as any[]) {
          if (Number(row.vehicle_type_id ?? 0) === numericRawId) {
            const vendorVehicleTypeId = Number(row.vendor_vehicle_type_ID ?? 0);
            if (vendorVehicleTypeId > 0) {
              normalized.add(vendorVehicleTypeId);
            }
          }
        }
      }

      return Array.from(normalized);
    };

    const expandedVehicleTypeFilterIds = expandVehicleTypeFilterIds(activeVehicleTypeIds);

    // VEHICLES
    const vehicles = await this.prisma.dvi_vehicle.findMany({
      where: {
        status: 1,
        deleted: 0,
        ...(activeVendorIds.length > 0 ? { vendor_id: { in: activeVendorIds } } : {}),
        ...(expandedVehicleTypeFilterIds.length > 0 ? { vehicle_type_id: { in: expandedVehicleTypeFilterIds } } : {}),
      },
      orderBy: [{ vendor_id: 'asc' }, { vehicle_type_id: 'asc' }, { vehicle_id: 'asc' }],
    });
    if (vehicles.length === 0) return { dates, rows: [] };

    // Primary PHP source: vouchers
    const voucherLinksRaw = await this.prisma.dvi_confirmed_itinerary_plan_vehicle_voucher_details.findMany({
      where: {
        status: 1,
        deleted: 0,
        vehicle_booking_status: 4,
        itinerary_plan_id: { in: filteredItineraryIds },
        ...(activeVendorIds.length > 0 ? { vendor_id: { in: activeVendorIds } } : {}),
        ...(expandedVehicleTypeFilterIds.length > 0 ? { vehicle_type_id: { in: expandedVehicleTypeFilterIds } } : {}),
      },
      select: {
        itinerary_plan_id: true,
        vendor_id: true,
        vehicle_type_id: true,
      },
    });

    // Fallback for parity when vouchers table is empty in local DBs.
    // Derive itinerary/vendor/vendor-vehicle-type from confirmed vendor vehicle details.
    let itineraryVendorTypeLinks: ItineraryVendorTypeLink[] = (voucherLinksRaw as any[]).map((v) => ({
      itinerary_plan_id: Number(v.itinerary_plan_id),
      vendor_id: Number(v.vendor_id),
      vehicle_type_id: resolveVendorVehicleTypeId(Number(v.vendor_id), Number(v.vehicle_type_id)),
    }));

    if (itineraryVendorTypeLinks.length === 0) {
      const fallbackRows = await this.prisma.dvi_confirmed_itinerary_plan_vendor_vehicle_details.findMany({
        where: {
          status: 1,
          deleted: 0,
          itinerary_plan_id: { in: filteredItineraryIds },
          ...(activeVendorIds.length > 0 ? { vendor_id: { in: activeVendorIds } } : {}),
        },
        select: {
          itinerary_plan_id: true,
          vendor_id: true,
          vendor_vehicle_type_id: true,
          vehicle_type_id: true,
        },
      });

      itineraryVendorTypeLinks = (fallbackRows as any[])
        .map((r) => {
          // Status/assignment keys are based on vendor_vehicle_type_id in PHP + assignment tables.
          const vendorVehicleTypeId = Number(r.vendor_vehicle_type_id ?? 0);
          const fallbackVehicleTypeId = Number(r.vehicle_type_id ?? 0);
          return {
            itinerary_plan_id: Number(r.itinerary_plan_id),
            vendor_id: Number(r.vendor_id),
            vehicle_type_id:
              vendorVehicleTypeId > 0
                ? resolveVendorVehicleTypeId(Number(r.vendor_id), vendorVehicleTypeId)
                : resolveVendorVehicleTypeId(Number(r.vendor_id), fallbackVehicleTypeId),
          };
        })
        .filter((r) => r.vehicle_type_id > 0)
        .filter((r) => (!expandedVehicleTypeFilterIds.length ? true : expandedVehicleTypeFilterIds.includes(r.vehicle_type_id)));
    }

    if (itineraryVendorTypeLinks.length === 0) return { dates, rows: [] };

    // VEHICLE ASSIGNMENTS
    const vehicleAssignments = await this.prisma.dvi_confirmed_itinerary_vendor_vehicle_assigned.findMany({
      where: { itinerary_plan_id: { in: filteredItineraryIds }, status: 1, deleted: 0 },
    });
    const assignedVehicleIdsByItineraryVendorType = new Map<string, number[]>();
    const assignmentByItineraryAndVehicle = new Map<string, any>();
    for (const a of vehicleAssignments as any[]) {
      const itId: number = a.itinerary_plan_id;
      const vId: number = a.vendor_id;
      const vtId: number = a.vendor_vehicle_type_id;
      const vehicleId: number = a.vehicle_id;
      const keyVendorType = `${itId}-${vId}-${vtId}`;
      if (!assignedVehicleIdsByItineraryVendorType.has(keyVendorType)) assignedVehicleIdsByItineraryVendorType.set(keyVendorType, []);
      assignedVehicleIdsByItineraryVendorType.get(keyVendorType)!.push(vehicleId);
      const keyVehicle = `${itId}-${vehicleId}`;
      assignmentByItineraryAndVehicle.set(keyVehicle, a);
    }

    // DRIVER ASSIGNMENTS
    const driverAssignments = await this.prisma.dvi_confirmed_itinerary_vendor_driver_assigned.findMany({
      where: { itinerary_plan_id: { in: filteredItineraryIds }, status: 1, deleted: 0 },
    });
    const driverByItineraryAndVehicle = new Map<string, any>();
    for (const d of driverAssignments as any[]) {
      const itId: number = d.itinerary_plan_id;
      const vehicleId: number = d.vehicle_id;
      driverByItineraryAndVehicle.set(`${itId}-${vehicleId}`, d);
    }

    // GROUP itineraries per (vendor, vendor_vehicle_type_ID)
    const itineraryIdsByVendorType = new Map<string, number[]>();
    for (const link of itineraryVendorTypeLinks) {
      if (!itineraryById.has(link.itinerary_plan_id)) continue;
      const key = `${link.vendor_id}-${link.vehicle_type_id}`;
      if (!itineraryIdsByVendorType.has(key)) itineraryIdsByVendorType.set(key, []);
      itineraryIdsByVendorType.get(key)!.push(link.itinerary_plan_id);
    }
    for (const [key, ids] of itineraryIdsByVendorType.entries()) {
      const uniqueIds = Array.from(new Set(ids));
      uniqueIds.sort((a, b) => {
        const ia = itineraryById.get(a);
        const ib = itineraryById.get(b);
        const ta = ia?.trip_start_date_and_time ? new Date(ia.trip_start_date_and_time).getTime() : 0;
        const tb = ib?.trip_start_date_and_time
          ? new Date(ib.trip_end_date_and_time ?? ib.trip_start_date_and_time).getTime()
          : 0;
        return ta - tb;
      });
      itineraryIdsByVendorType.set(key, uniqueIds);
    }

    // LABELS
    const vendorIdsForLabels = Array.from(new Set(vehicles.map((v: any) => v.vendor_id as number)));

    const [vendorRows, vehicleTypeRows] = await Promise.all([
      this.prisma.dvi_vendor_details.findMany({
        where: { vendor_id: { in: vendorIdsForLabels } },
        select: { vendor_id: true, vendor_name: true },
      }),
      this.prisma.dvi_vehicle_type.findMany({
        where: {
          vehicle_type_id: {
            in: Array.from(
              new Set(
                (vendorVehicleTypeRowsForLookup as any[])
                  .map((row) => Number(row.vehicle_type_id ?? 0))
                  .filter((n) => Number.isFinite(n) && n > 0),
              ),
            ),
          },
          deleted: { in: [0, 1] },
        },
        select: { vehicle_type_id: true, vehicle_type_title: true },
      }),
    ]);

    const vendorNameById = new Map<number, string>();
    for (const v of vendorRows as any[]) vendorNameById.set(v.vendor_id, v.vendor_name ?? '');
    const vehicleTypeTitleById = new Map<number, string>();
    for (const vt of vehicleTypeRows as any[]) vehicleTypeTitleById.set(vt.vehicle_type_id, vt.vehicle_type_title ?? '');
    const vendorVehicleTypeIdToTitle = new Map<number, string>();
    for (const row of vendorVehicleTypeRowsForLookup as any[]) {
      vendorVehicleTypeIdToTitle.set(
        Number(row.vendor_vehicle_type_ID ?? 0),
        vehicleTypeTitleById.get(Number(row.vehicle_type_id ?? 0)) ?? '',
      );
    }

    // FINAL ROWS
    const rows: VehicleAvailabilityRowDto[] = [];
    for (const vehicle of vehicles as any[]) {
      const vendorIdKey: number = vehicle.vendor_id;
      const vehicleTypeIdKey: number = vehicle.vehicle_type_id; // vendor_vehicle_type_ID
      const vehicleIdKey: number = vehicle.vehicle_id;

      const vendorTypeKey = `${vendorIdKey}-${vehicleTypeIdKey}`;
      const itineraryIdsForType = itineraryIdsByVendorType.get(vendorTypeKey) || [];
      if (itineraryIdsForType.length === 0) continue;

      const vendorName = vendorNameById.get(vendorIdKey) ?? '';
      const vehicleTypeTitle = vendorVehicleTypeIdToTitle.get(vehicleTypeIdKey) ?? '';

      const cells: VehicleAvailabilityCellDto[] = [];
      for (const day of dates) {
        let cell: VehicleAvailabilityCellDto | null = null;

        for (const itId of itineraryIdsForType) {
          const it = itineraryById.get(itId);
          if (!it) continue;

          const startDate =
            it.trip_start_date_and_time instanceof Date
              ? (it.trip_start_date_and_time as Date)
              : new Date(it.trip_start_date_and_time);
          const endDate =
            it.trip_end_date_and_time instanceof Date
              ? (it.trip_end_date_and_time as Date)
              : new Date(it.trip_end_date_and_time);
          const startYmd = this.toYmd(startDate);
          const endYmd = this.toYmd(endDate);
          if (day < startYmd || day > endYmd) continue;

          const assignedForVendorType =
            assignedVehicleIdsByItineraryVendorType.get(`${itId}-${vendorIdKey}-${vehicleTypeIdKey}`) || [];
          const isVehicleAssigned = assignedForVendorType.length > 0 && assignedForVendorType.includes(vehicleIdKey);
          if (assignedForVendorType.length > 0 && !isVehicleAssigned) continue;

          const keyRoute = `${itId}-${day}`;
          const routeRows = routesByItineraryAndDate.get(keyRoute) || [];
          const routeSegments: VehicleAvailabilityRouteSegmentDto[] = routeRows.map((r: any) => ({
            locationName: r.location_name ?? '',
            nextVisitingLocation: r.next_visiting_location ?? '',
          }));

          const customer = customerByItinerary.get(itId);
          const hotelName = hotelNameByItineraryDay.get(`${itId}-${day}`) ?? '';
          const tripStartLabel = this.formatDateLabel(startDate);
          const tripEndLabel = this.formatDateLabel(endDate);
          const tripStartTime = this.formatTimeLabel(startDate);
          const tripEndTime = this.formatTimeLabel(endDate);

        const assignmentKey = `${itId}-${vehicleIdKey}`;
const driverAssignment = driverByItineraryAndVehicle.get(assignmentKey);
const hasDriver = !!driverAssignment;

const driverId = hasDriver
  ? Number(driverAssignment.driver_id ?? 0) || null
  : null;

const driverAssignmentId = hasDriver
  ? Number(driverAssignment.driver_assigned_ID ?? 0) || null
  : null;

cell = {
  date: day,
  itineraryPlanId: itId,
  itineraryQuoteId: it.itinerary_quote_ID ?? null,
  isWithinTrip: true,
  isStart: day === startYmd,
  isEnd: day === endYmd,
  isInBetween: !(day === startYmd) && !(day === endYmd),
  isToday: day === todayYmd,
  isVehicleAssigned,
  assignedVehicleId: isVehicleAssigned ? vehicleIdKey : null,
  hasDriver,
  driverId,
  driverAssignmentId,
  routeSegments,
            customerName: customer?.customerName ?? '',
            customerContactNo: customer?.customerContactNo ?? '',
            customerLabel: customer?.customerLabel ?? '',
            hotelName,
            tripStartLabel,
            tripEndLabel,
            tripStartTime,
            tripEndTime,
          };
          break;
        }

        if (!cell) {
          cell = {
            date: day,
            itineraryPlanId: null,
            itineraryQuoteId: null,
            isWithinTrip: false,
            isStart: false,
            isEnd: false,
            isInBetween: false,
            isToday: day === todayYmd,
          isVehicleAssigned: false,
assignedVehicleId: null,
hasDriver: false,
driverId: null,
driverAssignmentId: null,
routeSegments: [],
            customerName: '',
            customerContactNo: '',
            customerLabel: '',
            hotelName: '',
            tripStartLabel: '',
            tripEndLabel: '',
            tripStartTime: '',
            tripEndTime: '',
          };
        }
        cells.push(cell);
      }

      rows.push({
        vendorId: vendorIdKey,
        vendorName,
        vehicleTypeId: vehicleTypeIdKey,
        vehicleTypeTitle,
        vehicleId: vehicleIdKey,
        registrationNumber: String(vehicle.registration_number),
        cells,
      });
    }

    return { dates, rows };
  }

  // ===========================================================================
  // DROPDOWNS for MODALS (mirror PHP)
  // ===========================================================================
  async listVendors() {
    const vendors = await this.prisma.dvi_vendor_details.findMany({
      where: { deleted: { in: [0, 1] } },
      select: { vendor_id: true, vendor_name: true },
      orderBy: { vendor_name: 'asc' },
    });
    return vendors.map((v: any) => ({ id: v.vendor_id, label: v.vendor_name ?? '' }));
  }

  async listVendorBranches(vendorId: number | null) {
    if (!vendorId) return [];
    const rows = await this.prisma.dvi_vendor_branches.findMany({
      where: { vendor_id: vendorId, status: 1, deleted: 0 },
      orderBy: { vendor_branch_name: 'asc' },
      select: { vendor_branch_id: true, vendor_branch_name: true, vendor_id: true },
    });
    return rows.map((r) => ({
      id: r.vendor_branch_id,
      name: r.vendor_branch_name,
      value: String(r.vendor_branch_id),
      label: r.vendor_branch_name,
      vendor_id: r.vendor_id,
    }));
  }

  async listVendorVehicleTypes(vendorId: number | null, vendorIds?: number[] | null) {
    const resolvedVendorIds = Array.isArray(vendorIds) && vendorIds.length > 0
      ? vendorIds.filter((id) => Number.isFinite(Number(id)) && Number(id) > 0)
      : vendorId
        ? [vendorId]
        : [];

    if (resolvedVendorIds.length === 0) return [];
    const mappings = await this.prisma.dvi_vendor_vehicle_types.findMany({
      where: {
        vendor_id: { in: resolvedVendorIds },
        status: { in: [0, 1] },
        deleted: { in: [0, 1] },
      },
      select: { vendor_vehicle_type_ID: true, vendor_id: true, vehicle_type_id: true },
      orderBy: { vendor_vehicle_type_ID: 'asc' },
    });
    if (!mappings.length) return [];

    const typeIds = Array.from(new Set(mappings.map((m) => m.vehicle_type_id)));
    const types = await this.prisma.dvi_vehicle_type.findMany({
      where: { vehicle_type_id: { in: typeIds }, status: 1, deleted: { in: [0, 1] } },
      select: { vehicle_type_id: true, vehicle_type_title: true },
    });
    const typeMap = new Map<number, string>(
      types.map((t): [number, string] => [t.vehicle_type_id, t.vehicle_type_title ?? '']),
    );

    return mappings
      .map((m) => ({
        id: m.vendor_vehicle_type_ID,
        vendor_vehicle_type_ID: m.vendor_vehicle_type_ID,
        vendor_id: m.vendor_id,
        vehicle_type_id: m.vehicle_type_id,
        vehicle_type_title: typeMap.get(m.vehicle_type_id) ?? '',
        value: String(m.vendor_vehicle_type_ID),
        label: typeMap.get(m.vehicle_type_id) ?? `Type ${m.vehicle_type_id}`,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  async listVehiclesForAssign(vendorId: number | null, vendorVehicleTypeId: number | null) {
    if (!vendorId || !vendorVehicleTypeId) return [];
    const rows = await this.prisma.dvi_vehicle.findMany({
      where: { vendor_id: vendorId, vehicle_type_id: vendorVehicleTypeId, status: 1, deleted: 0 },
      select: { vehicle_id: true, registration_number: true },
      orderBy: { registration_number: 'asc' },
    });
    return rows.map((r) => ({ id: r.vehicle_id, label: r.registration_number }));
  }

  async listDriversForAssign(vendorId: number | null, vendorVehicleTypeId?: number | null, itineraryPlanId?: number | null) {
    const prismaAny = this.prisma as any;
    const client =
      prismaAny.dvi_driver_details ??
      prismaAny.dvi_vendor_driver_details ??
      prismaAny.dvi_vendor_driver_list_details ??
      prismaAny.dvi_driver ??
      prismaAny.dvi_driver_list_details;

    if (!client?.findMany) return [];

    const where: Record<string, any> = { status: 1, deleted: { in: [0, 1] } };
    if (vendorId) where.vendor_id = vendorId;
    if (vendorVehicleTypeId && 'vendor_vehicle_type_id' in client) {
      where.vendor_vehicle_type_id = vendorVehicleTypeId;
    }

    let rows: any[] = [];
    try {
      rows = await client.findMany({
        where,
        select: {
          driver_id: true,
          driver_name: true,
          driver_primary_mobile_number: true,
        },
        orderBy: { driver_name: 'asc' },
      });
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      const unknownPrimary =
        msg.includes('driver_primary_mobile_number') &&
        (msg.includes('Unknown field') || msg.includes('Unknown argument'));

      if (unknownPrimary) {
        try {
          rows = await client.findMany({
            where,
            select: {
              driver_id: true,
              driver_name: true,
              driver_mobile_number: true,
            },
            orderBy: { driver_name: 'asc' },
          });
        } catch {
          rows = await client.findMany({
            where,
            select: {
              driver_id: true,
              driver_name: true,
            },
            orderBy: { driver_name: 'asc' },
          });
        }
      } else {
        throw e;
      }
    }

    // Availability filter: hide overlapping drivers when possible.
    // If this would empty the list, fall back to the base list to keep assign UX usable.
    if (itineraryPlanId && vendorId) {
      const baseRows = [...rows];
      const plan = await this.prisma.dvi_confirmed_itinerary_plan_details.findFirst({
        where: { itinerary_plan_ID: itineraryPlanId, status: 1, deleted: 0 },
        select: { trip_start_date_and_time: true, trip_end_date_and_time: true },
      });

      if (plan?.trip_start_date_and_time && plan?.trip_end_date_and_time) {
        const busy = await this.prisma.dvi_confirmed_itinerary_vendor_driver_assigned.findMany({
          where: {
            vendor_id: vendorId,
            status: 1,
            deleted: 0,
            trip_start_date_and_time: { lte: plan.trip_end_date_and_time },
            trip_end_date_and_time: { gte: plan.trip_start_date_and_time },
          },
          select: { driver_id: true },
        });
        const busySet = new Set((busy as any[]).map((b) => Number(b.driver_id)));
        const filtered = (rows as any[]).filter((r: any) => !busySet.has(Number(r.driver_id ?? r.id ?? 0)));
        rows = filtered.length > 0 ? filtered : baseRows;
      }
    }

    return rows
      .map((r: any) => {
        const mobile = r.driver_primary_mobile_number ?? r.driver_mobile_number ?? '';
        return {
          id: r.driver_id ?? r.id,
          label: r.driver_name ? `${r.driver_name}${mobile ? ' — ' + mobile : ''}` : `Driver ${r.driver_id ?? r.id}`,
        };
      })
      .filter((x: any) => x.id);
  }

  /**
   * Vehicle Origin autocomplete:
   * Read distinct labels from itinerary plans (arrival_location & departure_location).
   * Uses DB collation for case-insensitive `contains`, dedupes in JS, returns top 50.
   */
  async listLocations(q?: string): Promise<Array<{ id: number; label: string }>> {
    const needle = (q ?? '').trim();

    const rows = await this.prisma.dvi_stored_locations.findMany({
      where: {
        deleted: 0,
        ...(needle ? { source_location: { startsWith: needle } } : {}),
      },
      select: { location_ID: true, source_location: true },
      orderBy: { distance: 'asc' },
      take: 100,
    });

    const dedupe = new Map<string, { id: number; label: string }>();
    for (const r of rows as any[]) {
      const label = this.safeLabel(r.source_location);
      if (!label) continue;
      const key = label.toLowerCase();
      if (!dedupe.has(key)) {
        dedupe.set(key, { id: Number(r.location_ID ?? 0), label });
      }
    }

    return Array.from(dedupe.values()).slice(0, 50);
  }

  // ===========================================================================
  // LOOKUPS NEEDED BY CONTROLLER (fixes TS2339 on controller)
  // ===========================================================================
  async listVehicleTypes() {
    const rows = await this.prisma.dvi_vehicle_type.findMany({
      where: { status: 1, deleted: { in: [0, 1] } },
      select: { vehicle_type_id: true, vehicle_type_title: true },
      orderBy: { vehicle_type_title: 'asc' },
    });
    return rows.map((r: any) => ({ id: r.vehicle_type_id, label: r.vehicle_type_title ?? '' }));
  }

  async listAgents() {
    const agents = await this.prisma.dvi_agent.findMany({
      where: { deleted: { in: [0] } },
      select: {
        agent_ID: true,
        agent_name: true,
        agent_lastname: true,
        agent_city: true,
      },
      orderBy: { agent_name: 'asc' },
    });

    const agentIds = agents.map((agent: any) => Number(agent.agent_ID ?? 0)).filter((id) => id > 0);
    const cityIds = Array.from(new Set(agents.map((agent: any) => Number(agent.agent_city ?? 0)).filter((id) => id > 0)));

    const [companyRows, cityRows] = await Promise.all([
      agentIds.length
        ? this.prisma.dvi_agent_configuration.findMany({
            where: {
              agent_id: { in: agentIds },
              status: 1,
              deleted: 0,
            },
            select: {
              agent_id: true,
              company_name: true,
              agent_config_id: true,
            },
            orderBy: { agent_config_id: 'desc' },
          })
        : Promise.resolve([] as any[]),
      cityIds.length
        ? this.prisma.dvi_cities.findMany({
            where: { id: { in: cityIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([] as any[]),
    ]);

    const companyNameByAgentId = new Map<number, string>();
    for (const row of companyRows as any[]) {
      const agentId = Number(row.agent_id ?? 0);
      const companyName = String(row.company_name ?? '').replace(/\s+/g, ' ').trim();
      if (agentId > 0 && companyName && !companyNameByAgentId.has(agentId)) {
        companyNameByAgentId.set(agentId, companyName);
      }
    }

    const cityNameById = new Map<number, string>();
    for (const row of cityRows as any[]) {
      cityNameById.set(Number(row.id ?? 0), String(row.name ?? '').replace(/\s+/g, ' ').trim());
    }

    const buildAgentLabel = (agent: any): string => {
      const companyName = companyNameByAgentId.get(Number(agent.agent_ID ?? 0)) ?? '';
      const rawAgentName = [agent.agent_name, agent.agent_lastname]
        .map((part) => String(part ?? '').trim())
        .filter(Boolean)
        .join(' ')
        .trim();
      const fallbackName = rawAgentName || String(agent.agent_name ?? '').trim();
      const cityName = cityNameById.get(Number(agent.agent_city ?? 0)) ?? '';
      const baseName = companyName || fallbackName || 'Agent';
      return cityName && !baseName.toLowerCase().includes(cityName.toLowerCase())
        ? `${baseName} - ${cityName}`
        : baseName;
    };

    return agents.map((a: any) => ({ id: a.agent_ID, label: buildAgentLabel(a) }));
  }

  /**
   * PHP getSTATE_CITY_COUNTRY() mirror used by `/vehicle-availability/location-meta?label=...`
   * Resolves a free-text city label to { location_id, city_id, state_id, country_id }.
   * In this schema we treat location_id === dvi_cities.id
   */
  async getLocationMeta(labelRaw: string) {
    const label = (labelRaw ?? '').trim();
    const empty = { label, location_id: null, city_id: null, state_id: null, country_id: null };

    if (!label) return empty;

    const city = await this.resolveCityByLabel(label);

    if (!city) return empty;

    const state = await this.prisma.dvi_states.findFirst({
      where: { id: city.state_id },
      select: { id: true, country_id: true },
    });

    return {
      label: city.name,
      location_id: city.id, // used as vehicle_location_id
      city_id: city.id,
      state_id: state?.id ?? null,
      country_id: state?.country_id ?? null,
    };
  }

  // ===========================================================================
  // MODAL ACTIONS (mirror PHP handlers)
  // ===========================================================================
  // REPLACE the whole createVehicle() with this version
async createVehicle(dto: any) {
  const vendor_id = this.toInt(dto.vendor_id ?? dto.vendorId ?? dto.vendor_name);
  const vehicle_type_id = this.toInt(dto.vehicle_type_id ?? dto.vehicleTypeId ?? dto.vehicle_type);
  const vendor_branch_id = this.toInt(dto.vendor_branch_id ?? dto.vendorBranchId ?? dto.vendor_branch);

  const registration_number_raw =
    dto.registration_number ?? dto.registrationNumber ?? dto.registration_no ?? dto.registrationNo ?? '';
  const registration_number = this.normalizeRegistrationNumber(registration_number_raw);

  const vehicle_origin = this.safeLabel(dto.vehicle_orign ?? dto.vehicle_origin ?? dto.origin ?? '');
  const vehicle_fc_expiry_date = this.parseDateYmd(dto.vehicle_fc_expiry_date ?? dto.fc_expiry_date);
  const insurance_start_date = this.parseDateYmd(dto.insurance_start_date);
  const insurance_end_date = this.parseDateYmd(dto.insurance_end_date);

  // ⚠️ REQUIRED in your Prisma model; ensure we always send a string (not the String constructor)
  const owner_pincode: string =
    (dto.owner_pincode ?? dto.ownerPincode ?? '').toString().trim();

  if (!vendor_id) throw new BadRequestException('vendor_id is required');
  if (!vehicle_type_id) throw new BadRequestException('vehicle_type_id is required');
  if (!registration_number) throw new BadRequestException('registration_number is required');
  if (!vehicle_fc_expiry_date) throw new BadRequestException('vehicle_fc_expiry_date is required');
  if (!insurance_start_date) throw new BadRequestException('insurance_start_date is required');
  if (!insurance_end_date) throw new BadRequestException('insurance_end_date is required');

  const existing = await this.prisma.dvi_vehicle.findFirst({
    where: { registration_number, deleted: 0 },
    select: { vehicle_id: true, registration_number: true },
  });
  if (existing) {
    throw new BadRequestException(`Vehicle already exists: ${existing.registration_number}`);
  }

  // derive active status
  const now = new Date();
  const statusOk = (vehicle_fc_expiry_date ?? now) >= now && (insurance_end_date ?? now) >= now;
  const status = statusOk ? 1 : 0;

  // optional resolve origin → id (city)
  let vehicle_location_id: number | null = null;
  try {
    const city = await this.resolveCityByLabel(vehicle_origin);
    vehicle_location_id = city?.id ?? null;
  } catch {
    vehicle_location_id = null;
  }

  const data: any = this.cleanUndefined({
    vendor_id,
    vehicle_type_id,
    vendor_branch_id,
    registration_number,
    // if your column disallows null, remove the key when null:
    ...(vehicle_location_id != null ? { vehicle_location_id } : {}),
    vehicle_fc_expiry_date,
    insurance_start_date,
    insurance_end_date,
    // ✅ send a real string for required Prisma field
    owner_pincode: owner_pincode ?? '',
    status,
    deleted: 0,
  });

  const created = await this.prisma.dvi_vehicle.create({
    data,
    select: { vehicle_id: true, registration_number: true },
  });

  return {
    success: true,
    result_success: `Vehicle ${created.registration_number} created`,
    vehicle_id: created.vehicle_id,
  };
}

  async createDriver(dto: any) {
  const prismaAny = this.prisma as any;
  const driverClient =
    prismaAny.dvi_driver_details ??
    prismaAny.dvi_vendor_driver_details ??
    prismaAny.dvi_driver ??
    prismaAny.dvi_vendor_driver_list_details ??
    prismaAny.dvi_driver_list_details;

  if (!driverClient?.create) {
    throw new BadRequestException(
      'Driver Prisma model not found. Add your driver model (e.g., dvi_driver_details) to this service.',
    );
  }

  const vendor_id = this.toInt(dto.vendor_id ?? dto.vendorId ?? dto.vendor_name);
  const vehicle_type_id = this.toInt(dto.vehicle_type_id ?? dto.vehicleTypeId ?? dto.vehicle_type);

  const driver_name = this.safeLabel(dto.driver_name ?? dto.driverName ?? '');
  const driver_primary_mobile_number = this.safeLabel(
    dto.driver_primary_mobile_number ??
      dto.driver_mobile_number ??
      dto.driverMobileNumber ??
      dto.mobile_number ??
      dto.mobileNumber ??
      '',
  );

  if (!vendor_id) throw new BadRequestException('vendor_id is required');
  if (!vehicle_type_id) throw new BadRequestException('vehicle_type_id is required');
  if (!driver_name) throw new BadRequestException('driver_name is required');
  if (!driver_primary_mobile_number) throw new BadRequestException('driver_primary_mobile_number is required');

  // ---------- existence check (retry without `id` in select if schema doesn’t have it) ----------
  const findExisting = async () => {
    try {
      return await driverClient.findFirst({
        where: { vendor_id, driver_primary_mobile_number, deleted: { in: [0, 1] } },
        select: { driver_id: true, id: true },
      });
    } catch {
      // Fallback for models that don't have `id`
      return await driverClient.findFirst({
        where: { vendor_id, driver_primary_mobile_number, deleted: { in: [0, 1] } },
        select: { driver_id: true },
      });
    }
  };

  const existing = (await findExisting()) as { driver_id?: number; id?: number } | null;
  if (existing?.driver_id || existing?.id) {
    throw new BadRequestException('Driver already exists for this vendor with the same mobile number');
  }

  // ---------- create payloads ----------
  const baseData = this.cleanUndefined({
    vendor_id,
    vehicle_type_id,
    driver_name,
    driver_primary_mobile_number,
    status: 1,
    deleted: 0,
  });

  const withVendorVehicleType = this.cleanUndefined({
    ...baseData,
    // Some schemas use this; we try first and fallback if Prisma rejects the field
    vendor_vehicle_type_id: vehicle_type_id,
  });

  const tryCreate = async (data: any) => {
    try {
      return await driverClient.create({
        data,
        select: { driver_id: true, id: true },
      });
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      const unknownVendorVehicleType =
        msg.includes('Unknown argument `vendor_vehicle_type_id`') ||
        (msg.includes('Unknown arg') && msg.includes('vendor_vehicle_type_id'));

      if (unknownVendorVehicleType) {
        // Retry without vendor_vehicle_type_id
        try {
          return await driverClient.create({
            data: baseData,
            select: { driver_id: true, id: true },
          });
        } catch {
          // Retry again with minimal select for models that don't have `id`
          return await driverClient.create({
            data: baseData,
            select: { driver_id: true },
          });
        }
      }

      // If error is due to `id` not existing in select
      if (msg.includes('Unknown field `id`')) {
        return await driverClient.create({
          data,
          select: { driver_id: true },
        });
      }

      throw e;
    }
  };

  const created = (await tryCreate(withVendorVehicleType)) as { driver_id?: number; id?: number };
  const driver_id = created?.driver_id ?? created?.id;

  return { success: true, result_success: `Driver ${driver_name} created`, driver_id };
}

  async assignVehicle(dto: {
    itineraryPlanId: number;
    vendor_id: number;
    vehicle_type_id: number;
    vehicle_id: number;
    driver_id?: number | null;
    createdby?: number | null;
  }) {
    const itinerary_plan_id = this.reqInt(dto.itineraryPlanId, 'itineraryPlanId');
    const vendor_id = this.reqInt(dto.vendor_id, 'vendor_id');
    const vehicle_type_id = this.reqInt(dto.vehicle_type_id, 'vehicle_type_id');
    const vehicle_id = this.reqInt(dto.vehicle_id, 'vehicle_id');
    const driver_id = this.toInt(dto.driver_id);
    const createdby = this.toInt(dto.createdby);

    const plan = await this.prisma.dvi_confirmed_itinerary_plan_details.findFirst({
      where: { itinerary_plan_ID: itinerary_plan_id, deleted: 0 },
      select: { trip_start_date_and_time: true, trip_end_date_and_time: true },
    });
    if (!plan) throw new NotFoundException('Itinerary plan not found');

    const trip_start_date_and_time = plan.trip_start_date_and_time as Date;
    const trip_end_date_and_time = plan.trip_end_date_and_time as Date;

    await this.prisma.dvi_confirmed_itinerary_plan_vendor_vehicle_details.updateMany({
      where: { itinerary_plan_id, vendor_id, vendor_vehicle_type_id: vehicle_type_id, deleted: 0 },
      data: this.cleanUndefined({
        vehicle_id,
        createdby: createdby ?? undefined,
        updatedon: this.nowSql(),
      }),
    });

    await this.prisma.dvi_confirmed_itinerary_vendor_vehicle_assigned.create({
      data: this.cleanUndefined({
        itinerary_plan_id,
        vendor_id,
        vendor_vehicle_type_id: vehicle_type_id,
        vehicle_id,
        trip_start_date_and_time,
        trip_end_date_and_time,
        assigned_vehicle_status: 1,
        assigned_on: this.nowSql(),
        createdby: createdby ?? undefined,
        status: 1,
        deleted: 0,
      }),
    });

    if (driver_id) {
      await this.prisma.dvi_confirmed_itinerary_vendor_driver_assigned.create({
        data: this.cleanUndefined({
          itinerary_plan_id,
          vendor_id,
          vendor_vehicle_type_id: vehicle_type_id,
          vehicle_id,
          driver_id,
          trip_start_date_and_time,
          trip_end_date_and_time,
          assigned_driver_status: 1,
          driver_assigned_on: this.nowSql(),
          createdby: createdby ?? undefined,
          status: 1,
          deleted: 0,
        }),
      });
    }

    return { success: true, result_success: 'Vehicle (and driver if provided) assigned' };
  }

  async reassignDriver(dto: {
    itineraryPlanId: number;
    vendor_id: number;
    vehicle_id?: number | null;
    driver_id: number;
    createdby?: number | null;
  }) {
    const itinerary_plan_id = this.reqInt(dto.itineraryPlanId, 'itineraryPlanId');
    const vendor_id = this.reqInt(dto.vendor_id, 'vendor_id');
    const driver_id = this.reqInt(dto.driver_id, 'driver_id');
    const vehicle_id = this.toInt(dto.vehicle_id);
    const createdby = this.toInt(dto.createdby);

    const existing = await this.prisma.dvi_confirmed_itinerary_vendor_driver_assigned.findFirst({
      where: { itinerary_plan_id, vendor_id, status: 1, deleted: 0 },
      orderBy: { driver_assigned_on: 'desc' },
      select: { itinerary_plan_id: true, vendor_id: true },
    });
    if (!existing) throw new NotFoundException('No prior driver assignment found for this itinerary/vendor');

    await this.prisma.dvi_confirmed_itinerary_vendor_driver_assigned.updateMany({
      where: { itinerary_plan_id, vendor_id, status: 1, deleted: 0 },
      data: this.cleanUndefined({
        driver_id,
        ...(vehicle_id ? { vehicle_id } : {}),
        driver_assigned_on: this.nowSql(),
        createdby: createdby ?? undefined,
        updatedon: this.nowSql(),
      }),
    });

    return { success: true, result_success: 'Driver reassigned' };
  }

  async checkVehicleDuplication(params: {
    type: 'registration_number' | 'engine_number' | 'chassis_number' | 'insurance_policy_number';
    value: string;
    vendorId: number;
    oldValue?: string;
  }) {
    const vendorId = this.reqInt(params.vendorId, 'vendorId');
    const type = params.type;
    const valueRaw = this.safeLabel(params.value);
    const oldRaw = this.safeLabel(params.oldValue);

    const normalize = (s: string) => (type === 'registration_number' ? s.replace(/\s+/g, '').toUpperCase() : s);
    const value = normalize(valueRaw);
    const oldValue = normalize(oldRaw);

    if (!value) return { success: false };
    if (oldValue && value === oldValue) return { success: true };

    const where: Record<string, any> = {
      deleted: 0,
      vendor_id: vendorId,
      [type]: value,
    };

    const found = await this.prisma.dvi_vehicle.findFirst({
      where,
      select: { vehicle_id: true },
    });

    return { success: !found };
  }

  async getCustomerName(itineraryPlanId: number) {
    const row = await this.prisma.dvi_confirmed_itinerary_customer_details.findFirst({
      where: {
        itinerary_plan_ID: itineraryPlanId,
        primary_customer: 1,
        status: 1,
        deleted: 0,
      },
      select: { customer_name: true },
    });
    return { customerName: row?.customer_name ?? null };
  }

  // ===========================================================================
  // SMALL HELPERS
  // ===========================================================================
  private safeLabel(v: any): string {
    const s = (v ?? '').toString().trim();
    return s.length ? s : '';
  }
  private normalizeRegistrationNumber(v: any): string {
    return this.safeLabel(v).replace(/\s+/g, ' ').trim().toUpperCase();
  }
  private toInt(v: any): number | null {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
  }
  private reqInt(v: any, name: string): number {
    const n = this.toInt(v);
    if (!n) throw new BadRequestException(`${name} is required`);
    return n;
  }
  private cleanUndefined<T extends Record<string, any>>(obj: T): T {
    const out: any = {};
    for (const k of Object.keys(obj ?? {})) {
      const val = (obj as any)[k];
      if (val !== undefined) out[k] = val;
    }
    return out;
  }
  private parseDateYmd(v: any): Nullable<Date> {
    const s = this.safeLabel(v);
    if (!s) return null;
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00.000Z` : s;
    const d = new Date(iso);
    return Number.isFinite(d.getTime()) ? d : null;
  }
}
