import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  TransportAvailabilityKind,
} from '@prisma/client';

import {
  CreateTransportAvailabilityPeriodDto,
} from './dto/transport-availability-period.dto';
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

private parseAvailabilityDateTime(
  value: unknown,
): Date {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)
  ) {
    throw new BadRequestException(
      'Invalid date and time',
    );
  }

  // Preserve the existing MySQL booking wall-clock convention.
  const date = new Date(`${value}:00.000Z`);

  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 16) !== value
  ) {
    throw new BadRequestException(
      'Invalid date and time',
    );
  }

  return date;
}

async listAvailabilityResources() {
  const [vehicles, drivers] = await Promise.all([
    this.prisma.dvi_vehicle.findMany({
      where: {
        status: 1,
        deleted: 0,
      },
      select: {
        vehicle_id: true,
        registration_number: true,
      },
      orderBy: {
        registration_number: 'asc',
      },
    }),

    this.prisma.dvi_driver_details.findMany({
      where: {
        status: 1,
        deleted: 0,
      },
      select: {
        driver_id: true,
        driver_name: true,
        driver_primary_mobile_number: true,
      },
      orderBy: {
        driver_name: 'asc',
      },
    }),
  ]);

  const registrationCounts =
    new Map<string, number>();

  for (const vehicle of vehicles) {
    const key = this.registrationKey(
      vehicle.registration_number,
    );

    if (!key) continue;

    registrationCounts.set(
      key,
      (registrationCounts.get(key) ?? 0) + 1,
    );
  }

  return {
    vehicles: vehicles
      .filter(vehicle => {
        const key = this.registrationKey(
          vehicle.registration_number,
        );

        return (
          !!key &&
          registrationCounts.get(key) === 1
        );
      })
      .map(vehicle => ({
        id: vehicle.vehicle_id,
        label: vehicle.registration_number!.trim(),
      })),

    drivers: drivers.map(driver => ({
      id: driver.driver_id,
      label: [
        driver.driver_name,
        driver.driver_primary_mobile_number,
      ].filter(Boolean).join(' — ') ||
        `Driver ID ${driver.driver_id}`,
    })),
  };
}

async listAvailabilityPeriods(
  dateFrom: string,
  dateTo: string,
) {
  const from = this.parseAvailabilityDateTime(
    `${dateFrom}T00:00`,
  );

  const to = this.parseAvailabilityDateTime(
    `${dateTo}T00:00`,
  );

  if (to < from) {
    throw new BadRequestException(
      'Invalid date range',
    );
  }

  to.setUTCDate(to.getUTCDate() + 1);

  const periods =
    await this.prisma
      .dvi_transport_availability_period
      .findMany({
        where: {
          active: true,
          startsAt: { lt: to },
          endsAt: { gt: from },
        },
        orderBy: {
          startsAt: 'asc',
        },
      });

  const driverIds = [
    ...new Set(
      periods
        .filter(
          period =>
            period.kind ===
            TransportAvailabilityKind.driver_leave,
        )
        .map(period => period.resourceId),
    ),
  ];

  const drivers =
    await this.prisma.dvi_driver_details.findMany({
      where: {
        driver_id: { in: driverIds },
      },
      select: {
        driver_id: true,
        driver_name: true,
        driver_primary_mobile_number: true,
      },
    });

  const driverById = new Map(
    drivers.map(driver => [
      driver.driver_id,
      driver,
    ]),
  );

  return periods.map(period => {
    const driver =
      period.kind ===
      TransportAvailabilityKind.driver_leave
        ? driverById.get(period.resourceId)
        : undefined;

    return {
      ...period,
      driverName: driver?.driver_name ?? null,
      driverMobile:
        driver?.driver_primary_mobile_number ?? null,
    };
  });
}

async createAvailabilityPeriod(
  input: CreateTransportAvailabilityPeriodDto,
) {
  if (
    !Object.values(
      TransportAvailabilityKind,
    ).includes(
      input.kind as TransportAvailabilityKind,
    )
  ) {
    throw new BadRequestException(
      'Invalid availability type',
    );
  }

const kind = input.kind;

  const resourceId = this.reqInt(
    input.resourceId,
    'resourceId',
  );

  const startsAt =
    this.parseAvailabilityDateTime(input.startsAt);

  const endsAt =
    this.parseAvailabilityDateTime(input.endsAt);

  if (endsAt <= startsAt) {
    throw new BadRequestException(
      'End time must be after start time',
    );
  }

  const reason =
    typeof input.reason === 'string'
      ? input.reason.trim()
      : '';

  if (!reason || reason.length > 255) {
    throw new BadRequestException(
      'A valid reason is required',
    );
  }

  return this.prisma.$transaction(
    async db => {
      let vehicleKey: string | null = null;
      let relatedVehicleIds: number[] = [];

      const isDriverLeave =
        kind ===
        TransportAvailabilityKind.driver_leave;

      if (isDriverLeave) {
        const driver =
          await db.dvi_driver_details.findFirst({
            where: {
              driver_id: resourceId,
              status: 1,
              deleted: 0,
            },
            select: {
              driver_id: true,
            },
          });

        if (!driver) {
          throw new NotFoundException(
            'Active driver not found',
          );
        }

        const assignedTrip =
          await db
            .dvi_confirmed_itinerary_vendor_driver_assigned
            .findFirst({
              where: {
                driver_id: resourceId,
                status: 1,
                deleted: 0,
                assigned_driver_status: 1,
                trip_start_date_and_time: {
                  lt: endsAt,
                },
                trip_end_date_and_time: {
                  gte: startsAt,
                },
              },
              select: {
                itinerary_plan_id: true,
              },
            });

        if (assignedTrip) {
          throw new BadRequestException(
            'Driver has an overlapping assigned trip. Reassign the driver first.',
          );
        }
      } else {
        const fleet =
          await db.dvi_vehicle.findMany({
            select: {
              vehicle_id: true,
              registration_number: true,
              status: true,
              deleted: true,
            },
          });

        const vehicle = fleet.find(
          row =>
            row.vehicle_id === resourceId &&
            row.status === 1 &&
            row.deleted === 0,
        );

        if (!vehicle) {
          throw new NotFoundException(
            'Active vehicle not found',
          );
        }

        vehicleKey = this.registrationKey(
          vehicle.registration_number,
        );

        const relatedVehicles = fleet.filter(
          row =>
            this.registrationKey(
              row.registration_number,
            ) === vehicleKey,
        );

        if (
          !vehicleKey ||
          relatedVehicles.filter(
            row =>
              row.status === 1 &&
              row.deleted === 0,
          ).length !== 1
        ) {
          throw new BadRequestException(
            'Vehicle registration must be verified',
          );
        }

        relatedVehicleIds =
          relatedVehicles.map(
            row => row.vehicle_id,
          );

        const assignedTrip =
          await db
            .dvi_confirmed_itinerary_vendor_vehicle_assigned
            .findFirst({
              where: {
                vehicle_id: {
                  in: relatedVehicleIds,
                },
                status: 1,
                deleted: 0,
                assigned_vehicle_status: 1,
            trip_start_date_and_time: {
  lt: endsAt,
},
trip_end_date_and_time: {
  gt: startsAt,
},
              },
              select: {
                itinerary_plan_id: true,
              },
            });

        if (assignedTrip) {
          throw new BadRequestException(
            'Vehicle has an overlapping assigned trip. Reassign the vehicle first.',
          );
        }
      }

      const conflict =
        await db
          .dvi_transport_availability_period
          .findFirst({
            where: {
              active: true,
              startsAt: { lt: endsAt },
              endsAt: { gt: startsAt },

              ...(isDriverLeave
                ? {
                    kind:
                      TransportAvailabilityKind.driver_leave,
                    resourceId,
                  }
                : {
                    kind: {
                      not:
                        TransportAvailabilityKind.driver_leave,
                    },
                    OR: [
                      { vehicleKey },
                      {
                        resourceId: {
                          in: relatedVehicleIds,
                        },
                      },
                    ],
                  }),
            },
            select: {
              id: true,
            },
          });

      if (conflict) {
        throw new BadRequestException(
          'An availability restriction already overlaps this period',
        );
      }

      const period =
        await db
          .dvi_transport_availability_period
          .create({
            data: {
              kind,
              resourceId,
              vehicleKey,
              startsAt,
              endsAt,
              reason,
            },
          });

      return {
        success: true,
        period,
      };
    },
    {
      isolationLevel:
        Prisma.TransactionIsolationLevel.Serializable,
      timeout: 30000,
    },
  );
}

async cancelAvailabilityPeriod(
  id: unknown,
) {
  const periodId = this.reqInt(
    id,
    'periodId',
  );

  const result =
    await this.prisma
      .dvi_transport_availability_period
      .updateMany({
        where: {
          id: periodId,
          active: true,
        },
        data: {
          active: false,
        },
      });

  if (!result.count) {
    throw new NotFoundException(
      'Active availability period not found',
    );
  }

  return { success: true };
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
       trip_start_date_and_time: {
  lte: rangeTo,
},
trip_end_date_and_time: {
  gte: rangeFrom,
},
      },
      orderBy: { trip_start_date_and_time: 'asc' },
    });

    const itineraryById = new Map<number, any>();
    for (const it of itineraries as any[]) itineraryById.set(it.itinerary_plan_ID, it);
    let filteredItineraryIds = Array.from(itineraryById.keys());

 // ROUTE DETAILS
const routes =
  await this.prisma
    .dvi_confirmed_itinerary_route_details
    .findMany({
      where: {
        itinerary_plan_ID: {
          in: filteredItineraryIds,
        },
        status: 1,
        deleted: 0,
      },
      orderBy: [
        { itinerary_plan_ID: 'asc' },
        { itinerary_route_date: 'asc' },
        { route_start_time: 'asc' },
        { itinerary_route_ID: 'asc' },
      ],
    });

const routesByItineraryAndDate =
  new Map<string, typeof routes>();

for (const route of routes) {
  if (!route.itinerary_route_date) {
    continue;
  }

  const day = route.itinerary_route_date
    .toISOString()
    .slice(0, 10);

  const key =
    `${route.itinerary_plan_ID}-${day}`;

  const existing =
    routesByItineraryAndDate.get(key) ?? [];

  existing.push(route);

  routesByItineraryAndDate.set(
    key,
    existing,
  );
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
 if (!row.itinerary_route_date) {
  continue;
}

const itineraryDay =
  new Date(row.itinerary_route_date)
    .toISOString()
    .slice(0, 10);
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
   if (vehicles.length === 0) {
  return { dates, rows: [] };
}

const normalizeRegistration = (
  value: string | null,
): string =>
  (value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "");

const fleetForRegistrationCheck =
  activeVendorIds.length > 0 ||
  expandedVehicleTypeFilterIds.length > 0
    ? await this.prisma.dvi_vehicle.findMany({
        where: {
          status: 1,
          deleted: 0,
        },
        select: {
          vehicle_id: true,
          registration_number: true,
        },
      })
    : vehicles;

const vehicleIdsByRegistration =
  new Map<string, Set<number>>();

for (const vehicle of fleetForRegistrationCheck) {
  const registration = normalizeRegistration(
    vehicle.registration_number,
  );

  if (!registration) {
    continue;
  }

  const ids =
    vehicleIdsByRegistration.get(registration) ??
    new Set<number>();

  ids.add(Number(vehicle.vehicle_id));

  vehicleIdsByRegistration.set(
    registration,
    ids,
  );
}

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

 // VEHICLE ASSIGNMENTS
const vehicleAssignments =
  await this.prisma
    .dvi_confirmed_itinerary_vendor_vehicle_assigned
    .findMany({
      where: {
        itinerary_plan_id: {
          in: filteredItineraryIds,
        },
        status: 1,
        deleted: 0,
        assigned_vehicle_status: 1,
      },
    });

const itineraryIdsByAssignedVehicle =
  new Map<number, number[]>();

for (const assignment of vehicleAssignments) {
  const vehicleId = Number(assignment.vehicle_id);
  const itineraryId = Number(assignment.itinerary_plan_id);

  if (vehicleId <= 0 || itineraryId <= 0) {
    continue;
  }

  const current =
    itineraryIdsByAssignedVehicle.get(vehicleId) ?? [];

  if (!current.includes(itineraryId)) {
    current.push(itineraryId);
  }

  itineraryIdsByAssignedVehicle.set(
    vehicleId,
    current,
  );
}
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
  const driverAssignments =
  await this.prisma
    .dvi_confirmed_itinerary_vendor_driver_assigned
    .findMany({
      where: {
        itinerary_plan_id: {
          in: filteredItineraryIds,
        },
        status: 1,
        deleted: 0,
        assigned_driver_status: 1,
      },
    });
 const driverByItineraryAndVehicle =
  new Map<string, (typeof driverAssignments)[number]>();

for (const assignment of driverAssignments) {
  const itineraryId = Number(
    assignment.itinerary_plan_id,
  );

  const vehicleId = Number(
    assignment.vehicle_id,
  );

  driverByItineraryAndVehicle.set(
    `${itineraryId}-${vehicleId}`,
    assignment,
  );
}

const assignedDriverIds = Array.from(
  new Set(
    driverAssignments
      .map(assignment => Number(assignment.driver_id))
      .filter(
        id => Number.isSafeInteger(id) && id > 0,
      ),
  ),
);

const assignedDriverDetails = assignedDriverIds.length
  ? await this.prisma.dvi_driver_details.findMany({
      where: {
        driver_id: {
          in: assignedDriverIds,
        },
      },
      select: {
        driver_id: true,
        driver_name: true,
        driver_primary_mobile_number: true,
      },
    })
  : [];

const driverNameById = new Map<number, string>(
  assignedDriverDetails.map(driver => [
    driver.driver_id,
    (driver.driver_name ?? '').trim(),
  ]),
);

const driverMobileById = new Map<number, string>(
  assignedDriverDetails.map(driver => [
    driver.driver_id,
    (driver.driver_primary_mobile_number ?? '').trim(),
  ]),
);

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
        new Set([
          ...vendorVehicleTypeRowsForLookup.map(
            row => Number(row.vehicle_type_id ?? 0),
          ),

          ...vehicles.map(
            vehicle => Number(vehicle.vehicle_type_id ?? 0),
          ),
        ]),
      ).filter(
        id => Number.isSafeInteger(id) && id > 0,
      ),
    },
    deleted: { in: [0, 1] },
  },
  select: {
    vehicle_type_id: true,
    vehicle_type_title: true,
  },
}),
    ]);

    const vendorNameById = new Map<number, string>();
    for (const v of vendorRows as any[]) vendorNameById.set(v.vendor_id, v.vendor_name ?? '');
    const vehicleTypeTitleById = new Map<number, string>();
    for (const vt of vehicleTypeRows as any[]) vehicleTypeTitleById.set(vt.vehicle_type_id, vt.vehicle_type_title ?? '');
const vendorVehicleTypeToMasterType =
  new Map<string, number>();

for (const mapping of vendorVehicleTypeRowsForLookup) {
  const vendorId = Number(mapping.vendor_id);
  const mappingId = Number(mapping.vendor_vehicle_type_ID);
  const masterTypeId = Number(mapping.vehicle_type_id);

  if (
    vendorId > 0 &&
    mappingId > 0 &&
    masterTypeId > 0
  ) {
    vendorVehicleTypeToMasterType.set(
      `${vendorId}:${mappingId}`,
      masterTypeId,
    );
  }
}

const resolveVehicleTypeTitle = (
  vendorId: number,
  rawTypeId: number,
): string => {
  const mappedMasterId =
    vendorVehicleTypeToMasterType.get(
      `${vendorId}:${rawTypeId}`,
    );

  const resolvedTypeId =
    mappedMasterId ?? rawTypeId;

  return (
    vehicleTypeTitleById.get(resolvedTypeId) ?? ''
  ).trim();
};

 // FINAL ROWS
    const rows: VehicleAvailabilityRowDto[] = [];
    for (const vehicle of vehicles as any[]) {
      const vendorIdKey: number = vehicle.vendor_id;
 const vehicleTypeIdKey: number = vehicle.vehicle_type_id; // vendor_vehicle_type_ID
      const vehicleIdKey: number = vehicle.vehicle_id;

const itineraryIdsForType = [
  ...(itineraryIdsByAssignedVehicle.get(vehicleIdKey) ?? []),
].sort((a, b) => {
  const aStart = new Date(
    itineraryById.get(a).trip_start_date_and_time,
  ).getTime();

  const bStart = new Date(
    itineraryById.get(b).trip_start_date_and_time,
  ).getTime();

  return aStart - bStart || a - b;
});

      const vendorName =
  vendorNameById.get(vendorIdKey) ?? '';

const vehicleTypeTitle =
  resolveVehicleTypeTitle(
    vendorIdKey,
    vehicleTypeIdKey,
  );

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

      const isVehicleAssigned =
  (
    itineraryIdsByAssignedVehicle.get(vehicleIdKey) ?? []
  ).includes(itId);

if (!isVehicleAssigned) {
  continue;
}

       const keyRoute = `${itId}-${day}`;

const routeRows =
  routesByItineraryAndDate.get(keyRoute) ?? [];

const routeSegments: VehicleAvailabilityRouteSegmentDto[] =
  routeRows
    .map(route => ({
      locationName:
        (route.location_name ?? '').trim(),

      nextVisitingLocation:
        (route.next_visiting_location ?? '').trim(),
    }))
    .filter(
      segment =>
        segment.locationName ||
        segment.nextVisitingLocation,
    );

if (day === endYmd) {
  const departureLocation =
    String(it.departure_location ?? '').trim();

  const lastSegment =
    routeSegments[routeSegments.length - 1];

  if (
    lastSegment &&
    !lastSegment.nextVisitingLocation &&
    departureLocation
  ) {
    lastSegment.nextVisitingLocation =
      departureLocation;
  } else if (
    routeSegments.length === 0 &&
    departureLocation
  ) {
    routeSegments.push({
      locationName: '',
      nextVisitingLocation: departureLocation,
    });
  }
}

          const customer = customerByItinerary.get(itId);
          const hotelName = hotelNameByItineraryDay.get(`${itId}-${day}`) ?? '';
          const tripStartLabel = this.formatDateLabel(startDate);
          const tripEndLabel = this.formatDateLabel(endDate);
          const tripStartTime = this.formatTimeLabel(startDate);
          const tripEndTime = this.formatTimeLabel(endDate);

const assignmentKey = `${itId}-${vehicleIdKey}`;

const driverAssignment =
  driverByItineraryAndVehicle.get(assignmentKey);

const hasDriver =
  isVehicleAssigned &&
  Number(driverAssignment?.driver_id ?? 0) > 0 &&
  Number(driverAssignment?.assigned_driver_status ?? 0) === 1;

const driverId = hasDriver
  ? Number(driverAssignment.driver_id ?? 0) || null
  : null;

const driverAssignmentId = hasDriver
  ? Number(driverAssignment.driver_assigned_ID ?? 0) || null
  : null;

cell = {
  date: day,
  itineraryPlanId: itId,
  confirmedPlanId: it.confirmed_itinerary_plan_ID ?? null,
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

driverName:
  driverId !== null
    ? driverNameById.get(driverId) ?? null
    : null,

driverMobile:
  driverId !== null
    ? driverMobileById.get(driverId) ?? null
    : null,

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

          cells.push(cell);
        }

        if (!cell) {
    cell = {
  date: day,
  itineraryPlanId: null,
  confirmedPlanId: null,
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
driverName: null,
driverMobile: null,
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

          cells.push(cell);
        }
      }

const registrationNumber =
  String(vehicle.registration_number ?? "").trim();

const registrationKey =
  normalizeRegistration(registrationNumber);

const registrationConflict =
  !registrationKey ||
  (
    vehicleIdsByRegistration.get(
      registrationKey,
    )?.size ?? 0
  ) > 1;

rows.push({
  vendorId: vendorIdKey,
  vendorName,
  vehicleTypeId: vehicleTypeIdKey,
  vehicleTypeTitle,
  vehicleId: vehicleIdKey,
  registrationNumber,
  registrationConflict,
  cells,
});
    }

const visibleRows = rows.filter(
  row => row.registrationConflict === false,
);

return {
  dates,
  rows: visibleRows,
};
  }

 // ===========================================================================
 // DROPDOWNS for MODALS (mirror PHP)
 // ===========================================================================

  /**
   * Transport Allocation vehicle picker.
   *
   * IMPORTANT:
   * This deliberately does NOT use the availability-chart cells to decide
   * whether a vehicle is busy.
   *
   * A vehicle is "on_trip" only when that exact vehicle_id has a real,
   * active assignment whose date range overlaps the selected itinerary.
   */
async listAllocationVehicles(
  itineraryPlanId: number,
  db: Prisma.TransactionClient = this.prisma,
) {
    const itinerary_plan_id =
      this.reqInt(
        itineraryPlanId,
        'itineraryPlanId',
      );

const plan =
  await db
    .dvi_confirmed_itinerary_plan_details
    .findFirst({
      where: {
        itinerary_plan_ID:
          itinerary_plan_id,
        status: 1,
        deleted: 0,
      },
      select: {
        trip_start_date_and_time:
          true,
        trip_end_date_and_time:
          true,
      },
    });

    if (!plan) {
      throw new NotFoundException(
        'Confirmed itinerary plan not found',
      );
    }

   if (
  !plan.trip_start_date_and_time ||
  !plan.trip_end_date_and_time ||
 plan.trip_start_date_and_time.getTime() >=
  plan.trip_end_date_and_time.getTime()
) {
  throw new BadRequestException(
    'Invalid confirmed itinerary travel dates',
  );
}

    const tripStart =
      plan.trip_start_date_and_time;

    const tripEnd =
      plan.trip_end_date_and_time;

    /*
     * These rows define which vendor + vendor vehicle type
     * combinations belong to this confirmed booking.
     */
const requirementRows = await db
  .dvi_confirmed_itinerary_plan_vendor_vehicle_details
  .findMany({
    where: {
      itinerary_plan_id,
      status: 1,
      deleted: 0,
    },
    select: {
      vendor_id: true,
      vendor_vehicle_type_id: true,
      vehicle_type_id: true,
    },
  });

const voucherRows = await db
  .dvi_confirmed_itinerary_plan_vehicle_voucher_details
  .findMany({
    where: {
      itinerary_plan_id,
      status: 1,
      deleted: 0,
      vehicle_booking_status: 4,
    },
    select: {
      vendor_id: true,
      vehicle_type_id: true,
    },
  });

const requirementVendorIds = [
  ...new Set(
    [...requirementRows, ...voucherRows]
      .map(r => Number(r.vendor_id))
      .filter(id => id > 0),
  ),
];

const mappings =
  await db.dvi_vendor_vehicle_types.findMany({
    where: {
      vendor_id: {
        in: requirementVendorIds,
      },
      status: {
        in: [0, 1],
      },
      deleted: {
        in: [0, 1],
      },
    },
    select: {
      vendor_id: true,
      vendor_vehicle_type_ID: true,
      vehicle_type_id: true,
      status: true,
      deleted: true,
    },
  });

const requirementMap = new Map<
  string,
  {
    vendorId: number;
    vendorVehicleTypeId: number;
    masterVehicleTypeId: number;
  }
>();

const addRequirement = (
  vendorId: number,
  mappingId: number,
  masterId: number,
  fromVoucher = false,
) => {
  if (vendorId <= 0) return;

  const vendorMappings = mappings.filter(
    m => Number(m.vendor_id) === vendorId,
  );

  const exact = mappingId > 0
    ? vendorMappings.find(
        m =>
          Number(m.vendor_vehicle_type_ID) === mappingId,
      )
    : undefined;

  const masterMatches = masterId > 0
    ? vendorMappings.filter(
        m =>
          Number(m.vehicle_type_id) === masterId &&
          Number(m.status) === 1 &&
          Number(m.deleted) === 0,
      )
    : [];

  let mapping =
    exact ??
    (
      masterMatches.length === 1
        ? masterMatches[0]
        : undefined
    );

  // Voucher records may contain either ID format.
  // Never choose an ambiguous vehicle type.
  if (fromVoucher) {
    const candidates = vendorMappings.filter(
      m =>
        (
          mappingId > 0 &&
          Number(m.vendor_vehicle_type_ID) === mappingId
        ) ||
        (
          masterId > 0 &&
          Number(m.vehicle_type_id) === masterId &&
          Number(m.status) === 1 &&
          Number(m.deleted) === 0
        ),
    );

    mapping =
      candidates.length === 1
        ? candidates[0]
        : undefined;
  }

  if (!mapping) {
    console.warn("[Transport Allocation] Unresolved vehicle type", {
      itineraryPlanId: itinerary_plan_id,
      vendorId,
      mappingId,
      masterId,
      fromVoucher,
      matchingMappings: vendorMappings.length,
    });

    return;
  }

  const vendorVehicleTypeId =
    Number(mapping.vendor_vehicle_type_ID);

requirementMap.set(
  `${vendorId}:${vendorVehicleTypeId}`,
  {
    vendorId,
    vendorVehicleTypeId,
    masterVehicleTypeId: Number(
      mapping.vehicle_type_id,
    ),
  },
);
};

// Primary confirmed vehicle requirements.
for (const row of requirementRows) {
  addRequirement(
    Number(row.vendor_id),
    Number(row.vendor_vehicle_type_id),
    Number(row.vehicle_type_id),
  );
}

// Fallback to confirmed vehicle vouchers.
if (!requirementMap.size) {
  for (const row of voucherRows) {
    addRequirement(
      Number(row.vendor_id),
      Number(row.vehicle_type_id),
      Number(row.vehicle_type_id),
      true,
    );
  }
}

const requirements = [
  ...requirementMap.values(),
];

if (!requirements.length) {
  console.warn("[Transport Allocation] Missing requirements", {
    itineraryPlanId: itinerary_plan_id,
    confirmedRequirements: requirementRows,
    confirmedVouchers: voucherRows,
    vendorMappings: mappings,
  });

  return [];
}

    /*
 * Support both master vehicle-type IDs and
 * vendor-specific vehicle-type IDs.
 */

const fleetTypeIds = (
  requirement: (typeof requirements)[number],
): number[] => {
  const ids = new Set<number>([
    requirement.vendorVehicleTypeId,
  ]);

  const masterId = requirement.masterVehicleTypeId;

  if (masterId > 0) {
    const conflictingMapping = mappings.some(
      m =>
        Number(m.vendor_id) === requirement.vendorId &&
        Number(m.vendor_vehicle_type_ID) === masterId &&
        Number(m.vendor_vehicle_type_ID) !==
          requirement.vendorVehicleTypeId,
    );

    const matchingRequirements = requirements.filter(
      r =>
        r.vendorId === requirement.vendorId &&
        r.masterVehicleTypeId === masterId,
    );

    if (
      !conflictingMapping &&
      matchingRequirements.length === 1
    ) {
      ids.add(masterId);
    }
  }

  return [...ids];
};

const fleetWhere = requirements.map(requirement => ({
  vendor_id: requirement.vendorId,

  vehicle_type_id: {
    in: fleetTypeIds(requirement),
  },
}));

const rawVehicles = await db.dvi_vehicle.findMany({
  where: {
    status: 1,
    deleted: 0,
    OR: fleetWhere,
  },

  select: {
    vehicle_id: true,
    vendor_id: true,
    vehicle_type_id: true,
    registration_number: true,
  },

  orderBy: {
    registration_number: 'asc',
  },
});

const registrationFleet =
  await db.dvi_vehicle.findMany({
    select: {
      vehicle_id: true,
      registration_number: true,
      status: true,
      deleted: true,
    },
  });

const registrationByVehicleId =
  new Map<number, string>();

const activeCountByRegistration =
  new Map<string, number>();

for (const record of registrationFleet) {
  const key = this.registrationKey(
    record.registration_number,
  );

  if (!key) continue;

  registrationByVehicleId.set(
    record.vehicle_id,
    key,
  );

  if (
    record.status === 1 &&
    record.deleted === 0
  ) {
    activeCountByRegistration.set(
      key,
      (activeCountByRegistration.get(key) ?? 0) + 1,
    );
  }
}

const vehicles = rawVehicles.flatMap(vehicle => {
  const vendorId = Number(vehicle.vendor_id);

  const rawTypeId = Number(vehicle.vehicle_type_id);

  const matches = requirements.filter(
    requirement =>
      requirement.vendorId === vendorId &&
      fleetTypeIds(requirement).includes(rawTypeId),
  );

  if (matches.length !== 1) {
    console.warn(
      "[Transport Allocation] Ambiguous fleet type",
      {
        itineraryPlanId: itinerary_plan_id,
        vehicleId: vehicle.vehicle_id,
        vendorId,
        rawTypeId,
      },
    );

    return [];
  }

  const requirement = matches[0];

  return [{
    ...vehicle,

    allocationVendorVehicleTypeId:
      requirement.vendorVehicleTypeId,

    masterVehicleTypeId:
      requirement.masterVehicleTypeId,
  }];
});

console.info("[Transport Allocation] Resolved fleet", {
  itineraryPlanId: itinerary_plan_id,
  requirements,
  returned: vehicles.length,
});

    const vehicleIds =
      (vehicles as any[])
        .map((vehicle) =>
          Number(
            vehicle.vehicle_id ?? 0,
          ),
        )
        .filter((id) => id > 0);

  if (!vehicleIds.length) {
  const registeredFleet = await db.dvi_vehicle.findMany({
 where: {
  OR: fleetWhere,
},
    select: {
      vehicle_id: true,
      vendor_id: true,
      vehicle_type_id: true,
      status: true,
      deleted: true,
    },
  });

  console.warn("[Transport Allocation] No active fleet", {
    itineraryPlanId: itinerary_plan_id,
    requirements,
    registeredFleetCount: registeredFleet.length,
    registeredFleet,
  });

  return [];
}

    /*
     * REAL BUSY CHECK.
     *
     * Exclude the booking currently being edited.
     * Only an actual active assignment for the SAME
     * vehicle can make it unavailable.
     */
 const candidateRegistrations = new Set(
  vehicles
    .map(vehicle =>
      this.registrationKey(
        vehicle.registration_number,
      ),
    )
    .filter(Boolean),
);

const relatedVehicleIds = registrationFleet
  .filter(record =>
    candidateRegistrations.has(
      this.registrationKey(
        record.registration_number,
      ),
    ),
  )
  .map(record => record.vehicle_id);

const busyAssignments =
  await db
    .dvi_confirmed_itinerary_vendor_vehicle_assigned
    .findMany({
      where: {
        vehicle_id: {
          in: [
            ...new Set([
              ...vehicleIds,
              ...relatedVehicleIds,
            ]),
          ],
        },

            itinerary_plan_id: {
              not: itinerary_plan_id,
            },

            status: 1,
            deleted: 0,
            assigned_vehicle_status: 1,
trip_start_date_and_time: {
  lt: tripEnd,
},

trip_end_date_and_time: {
  gt: tripStart,
},
          },
          select: {
            vehicle_id: true,
            itinerary_plan_id: true,
          },
        });

const restrictedVehiclePeriods =
  await db
    .dvi_transport_availability_period
    .findMany({
      where: {
        active: true,

        kind: {
          not:
            TransportAvailabilityKind.driver_leave,
        },

      startsAt: {
  lt: tripEnd,
},

endsAt: {
  gt: tripStart,
},

        OR: [
          {
            vehicleKey: {
              in: [...candidateRegistrations],
            },
          },
          {
            resourceId: {
              in: relatedVehicleIds,
            },
          },
        ],
      },
    });

const busyByVehicle =
  new Map<number, number>();

const busyByRegistration =
  new Map<string, number>();

    for (
      const assignment of
        busyAssignments as any[]
    ) {
      const vehicleId =
        Number(
          assignment.vehicle_id ?? 0,
        );

      const busyPlanId =
        Number(
          assignment.itinerary_plan_id ??
            0,
        );

      if (
        vehicleId > 0 &&
        busyPlanId > 0
      ) {
     busyByVehicle.set(
  vehicleId,
  busyPlanId,
);

const key =
  registrationByVehicleId.get(vehicleId);

if (key) {
  busyByRegistration.set(
    key,
    busyPlanId,
  );
}
      }
    }

    /*
     * Existing assignment for this booking is not "busy";
     * it should remain selectable and appear selected in UI.
     */
    const currentAssignments =
      await db
        .dvi_confirmed_itinerary_vendor_vehicle_assigned
        .findMany({
          where: {
            itinerary_plan_id:
              itinerary_plan_id,
            vehicle_id: {
              in: vehicleIds,
            },
            status: 1,
            deleted: 0,
            assigned_vehicle_status: 1,
          },
          select: {
            vehicle_id: true,
          },
        });

const currentVehicleIds =
  new Set(
    (
      currentAssignments as any[]
    ).map((assignment) =>
      Number(
        assignment.vehicle_id ?? 0,
      ),
    ),
  );

const currentDriverAssignments = await db
  .dvi_confirmed_itinerary_vendor_driver_assigned
  .findMany({
    where: {
      itinerary_plan_id,
      vehicle_id: {
        in: [...currentVehicleIds],
      },
      status: 1,
      deleted: 0,
      assigned_driver_status: 1,
    },
    select: {
      vehicle_id: true,
      vendor_id: true,
      vendor_vehicle_type_id: true,
      driver_id: true,
      driver_assigned_ID: true,
    },
  });

const prismaAny = db as any;

const driverClient =
  prismaAny.dvi_driver_details ??
  prismaAny.dvi_vendor_driver_details ??
  prismaAny.dvi_vendor_driver_list_details ??
  prismaAny.dvi_driver ??
  prismaAny.dvi_driver_list_details;

const savedDriverIds = [
  ...new Set(
    currentDriverAssignments
      .map(a => Number(a.driver_id))
      .filter(id => id > 0),
  ),
];

const savedDriverDetails: any[] =
  savedDriverIds.length && driverClient?.findMany
    ? await driverClient.findMany({
        where: {
          driver_id: {
            in: savedDriverIds,
          },
          deleted: 0,
        },
      })
    : [];

const vendorIds =
      Array.from(
        new Set(
          (vehicles as any[])
            .map((vehicle) =>
              Number(
                vehicle.vendor_id ?? 0,
              ),
            )
            .filter((id) => id > 0),
        ),
      );

const vendorVehicleTypeIds = [
  ...new Set(
    vehicles
      .map(vehicle =>
        Number(
          vehicle.allocationVendorVehicleTypeId,
        ),
      )
      .filter(id => id > 0),
  ),
];

    const [
      vendors,
      vendorVehicleTypes,
    ] = await Promise.all([
      db
        .dvi_vendor_details
        .findMany({
          where: {
            vendor_id: {
              in: vendorIds,
            },
          },
          select: {
            vendor_id: true,
            vendor_name: true,
          },
        }),

      db
        .dvi_vendor_vehicle_types
        .findMany({
          where: {
            vendor_vehicle_type_ID: {
              in:
                vendorVehicleTypeIds,
            },
          },
          select: {
            vendor_vehicle_type_ID:
              true,
            vehicle_type_id: true,
          },
        }),
    ]);

    const masterVehicleTypeIds =
      Array.from(
        new Set(
          (
            vendorVehicleTypes as any[]
          )
            .map((row) =>
              Number(
                row.vehicle_type_id ?? 0,
              ),
            )
            .filter((id) => id > 0),
        ),
      );

    const masterVehicleTypes =
      masterVehicleTypeIds.length
        ? await db
            .dvi_vehicle_type
            .findMany({
              where: {
                vehicle_type_id: {
                  in:
                    masterVehicleTypeIds,
                },
              },
              select: {
                vehicle_type_id: true,
                vehicle_type_title:
                  true,
              },
            })
        : [];

    const vendorNameById =
      new Map<number, string>();

    for (
      const vendor of vendors as any[]
    ) {
      vendorNameById.set(
        Number(
          vendor.vendor_id ?? 0,
        ),
        String(
          vendor.vendor_name ?? '',
        ),
      );
    }

    const titleByMasterType =
      new Map<number, string>();

    for (
      const row of
        masterVehicleTypes as any[]
    ) {
      titleByMasterType.set(
        Number(
          row.vehicle_type_id ?? 0,
        ),
        String(
          row.vehicle_type_title ??
            '',
        ),
      );
    }

    const titleByVendorType =
      new Map<number, string>();

    for (
      const row of
        vendorVehicleTypes as any[]
    ) {
      titleByVendorType.set(
        Number(
          row.vendor_vehicle_type_ID ??
            0,
        ),
        titleByMasterType.get(
          Number(
            row.vehicle_type_id ?? 0,
          ),
        ) ?? '',
      );
    }

    return (
      vehicles as any[]
    )
      .map((vehicle) => {
        const vehicleId =
          Number(
            vehicle.vehicle_id ?? 0,
          );

        const vendorId =
          Number(
            vehicle.vendor_id ?? 0,
          );

      const vendorVehicleTypeId =
  Number(
    vehicle.allocationVendorVehicleTypeId ?? 0,
  );

        const registration =
  this.registrationKey(
    vehicle.registration_number,
  );

const registrationConflict =
  !registration ||
  (
    activeCountByRegistration.get(
      registration,
    ) ?? 0
  ) > 1;

const busyPlanId =
  busyByVehicle.get(vehicleId) ??
  busyByRegistration.get(registration);

const restriction =
  restrictedVehiclePeriods.find(
    period =>
      period.resourceId === vehicleId ||
      period.vehicleKey === registration ||
      registrationByVehicleId.get(
        period.resourceId,
      ) === registration,
  );

const isAvailable =
  !busyPlanId &&
  !registrationConflict &&
  !restriction;

const matchingDrivers =
  currentDriverAssignments.filter(
    a => Number(a.vehicle_id) === vehicleId,
  );

const savedDriver =
  matchingDrivers.length === 1
    ? matchingDrivers[0]
    : null;

const assignmentVerified =
  matchingDrivers.length === 0 ||
  (
    !!savedDriver &&
    Number(savedDriver.vendor_id) === vendorId &&
    Number(savedDriver.vendor_vehicle_type_id) ===
      vendorVehicleTypeId &&
    Number(savedDriver.driver_id) > 0 &&
    Number(savedDriver.driver_assigned_ID) > 0
  );

const details =
  savedDriver && assignmentVerified
    ? savedDriverDetails.find(
        d =>
          Number(d.driver_id) ===
            Number(savedDriver.driver_id) &&
          Number(d.vendor_id) === vendorId,
      )
    : undefined;

return {
  id: vehicleId,

          vehicleId,

          registrationNumber:
            String(
              vehicle.registration_number ??
                '',
            ),

          vendorId,

          vendorName:
            vendorNameById.get(
              vendorId,
            ) ?? '',

          vendorVehicleTypeId,

          vehicleTypeTitle:
            titleByVendorType.get(
              vendorVehicleTypeId,
            ) ?? '',

availability: registrationConflict
  ? 'registration_conflict'
  : busyPlanId
    ? 'on_trip'
    : restriction
      ? restriction.kind
      : 'available',

isAvailable,

registrationConflict,

isAssignedToCurrent:
  currentVehicleIds.has(
    vehicleId,
  ),
        assignmentVerified,

driverId: assignmentVerified
  ? Number(savedDriver?.driver_id) || null
  : null,

driverAssignmentId: assignmentVerified
  ? Number(savedDriver?.driver_assigned_ID) || null
  : null,

driverName: String(
  details?.driver_name ?? "",
),

driverMobile: String(
  details?.driver_primary_mobile_number ??
  details?.driver_mobile_number ??
  "",
),

busyItineraryPlanId:
  busyPlanId ?? null,
        };
      })
      .filter(
        vehicle =>
          !vehicle.registrationConflict ||
          vehicle.isAssignedToCurrent,
      )
      .sort((a, b) => {
        if (
          a.isAvailable !==
          b.isAvailable
        ) {
          return a.isAvailable
            ? -1
            : 1;
        }

        return a.registrationNumber
          .localeCompare(
            b.registrationNumber,
          );
      });
  }

  /**
   * Transport Allocation driver picker.
   *
   * Drivers are marked unavailable only when that exact driver has
   * an overlapping ACTIVE driver assignment on another itinerary.
   */
async listAllocationDrivers(
  input: {
    itineraryPlanId: number;
    vendorId: number;
    vendorVehicleTypeId?: number;
  },
  db: Prisma.TransactionClient = this.prisma,
) {
    const itineraryPlanId =
      this.reqInt(
        input.itineraryPlanId,
        'itineraryPlanId',
      );

    const vendorId =
      this.reqInt(
        input.vendorId,
        'vendorId',
      );

    const vendorVehicleTypeId =
      this.toInt(
        input.vendorVehicleTypeId,
      );

const plan =
  await db
    .dvi_confirmed_itinerary_plan_details
    .findFirst({
      where: {
        itinerary_plan_ID:
          itineraryPlanId,
        status: 1,
        deleted: 0,
      },
      select: {
        trip_start_date_and_time:
          true,
        trip_end_date_and_time:
          true,
      },
    });

if (!plan) {
  throw new NotFoundException(
    'Confirmed itinerary plan not found',
  );
}

if (
  !plan.trip_start_date_and_time ||
  !plan.trip_end_date_and_time ||
  plan.trip_start_date_and_time.getTime() >
    plan.trip_end_date_and_time.getTime()
) {
  throw new BadRequestException(
    'Invalid confirmed itinerary travel dates',
  );
}

const prismaAny = db as any;

    const driverClient =
      prismaAny.dvi_driver_details ??
      prismaAny.dvi_vendor_driver_details ??
      prismaAny.dvi_vendor_driver_list_details ??
      prismaAny.dvi_driver ??
      prismaAny.dvi_driver_list_details;

    if (!driverClient?.findMany) {
      return [];
    }

    const readRows =
      async (where: any) => {
        try {
          return await driverClient
            .findMany({
              where,
              select: {
                driver_id: true,
                driver_name: true,
                driver_primary_mobile_number:
                  true,
              },
              orderBy: {
                driver_name: 'asc',
              },
            });
        } catch {
          try {
            return await driverClient
              .findMany({
                where,
                select: {
                  driver_id: true,
                  driver_name: true,
                  driver_mobile_number:
                    true,
                },
                orderBy: {
                  driver_name: 'asc',
                },
              });
          } catch {
            return await driverClient
              .findMany({
                where,
                select: {
                  driver_id: true,
                  driver_name: true,
                },
                orderBy: {
                  driver_name: 'asc',
                },
              });
          }
        }
      };

const baseWhere = {
  vendor_id: vendorId,
  status: 1,
  deleted: 0,
};

let rows: any[] = [];

if (vendorVehicleTypeId) {
  const mappings =
    await db.dvi_vendor_vehicle_types.findMany({
      where: {
        vendor_id: vendorId,
      },
      select: {
        vendor_vehicle_type_ID: true,
        vehicle_type_id: true,
      },
    });

  const selectedMapping = mappings.find(
    mapping =>
      mapping.vendor_vehicle_type_ID ===
      vendorVehicleTypeId,
  );

  if (!selectedMapping) {
    throw new BadRequestException(
      'Vendor vehicle type could not be verified',
    );
  }

  const eligibleTypeIds = new Set<number>([
    vendorVehicleTypeId,
  ]);

  const masterTypeId =
    selectedMapping.vehicle_type_id;

  const conflictingMapping = mappings.some(
    mapping =>
      mapping.vendor_vehicle_type_ID === masterTypeId &&
      mapping.vehicle_type_id !== masterTypeId,
  );

  const matchingMappings = mappings.filter(
    mapping =>
      mapping.vehicle_type_id === masterTypeId,
  );

  if (
    masterTypeId > 0 &&
    !conflictingMapping &&
    matchingMappings.length === 1
  ) {
    eligibleTypeIds.add(masterTypeId);
  }

  rows = await readRows({
    ...baseWhere,
    vehicle_type_id: {
      in: [...eligibleTypeIds],
    },
  });
} else {
  rows = await readRows(baseWhere);
}

    const driverIds =
      rows
        .map((row) =>
          Number(
            row.driver_id ??
              row.id ??
              0,
          ),
        )
        .filter((id) => id > 0);

    if (!driverIds.length) {
      return [];
    }

const busyAssignments =
  await db
    .dvi_confirmed_itinerary_vendor_driver_assigned
    .findMany({
      where: {
        driver_id: {
          in: driverIds,
        },

          OR: [
  {
    itinerary_plan_id: {
      not: itineraryPlanId,
    },
  },
  {
    itinerary_plan_id: itineraryPlanId,
    OR: [
      {
        vendor_id: {
          not: vendorId,
        },
      },
      ...(vendorVehicleTypeId
        ? [
            {
              vendor_vehicle_type_id: {
                not: vendorVehicleTypeId,
              },
            },
          ]
        : []),
    ],
  },
],

            status: 1,
            deleted: 0,
            assigned_driver_status: 1,

     trip_start_date_and_time: {
  lt: plan.trip_end_date_and_time,
},

trip_end_date_and_time: {
  gt: plan.trip_start_date_and_time,
},
          },
          select: {
            driver_id: true,
            itinerary_plan_id: true,
          },
        });
const leavePeriods =
  await db
    .dvi_transport_availability_period
    .findMany({
      where: {
        active: true,

        kind:
          TransportAvailabilityKind.driver_leave,

        resourceId: {
          in: driverIds,
        },
startsAt: {
  lt: plan.trip_end_date_and_time,
},

endsAt: {
  gt: plan.trip_start_date_and_time,
},
      },
      select: {
        resourceId: true,
      },
    });

const driversOnLeave = new Set(
  leavePeriods.map(
    period => period.resourceId,
  ),
);

const busyByDriver =
  new Map<number, number>();

    for (
      const assignment of
        busyAssignments as any[]
    ) {
      const driverId =
        Number(
          assignment.driver_id ?? 0,
        );

      if (driverId <= 0) {
        continue;
      }

      busyByDriver.set(
        driverId,
        Number(
          assignment.itinerary_plan_id ??
            0,
        ),
      );
    }

 const currentAssignments =
  await db
    .dvi_confirmed_itinerary_vendor_driver_assigned
    .findMany({
          where: {
            itinerary_plan_id:
              itineraryPlanId,
            driver_id: {
              in: driverIds,
            },
            status: 1,
            deleted: 0,
            assigned_driver_status: 1,
          },
          select: {
            driver_id: true,
          },
        });

    const currentDriverIds =
      new Set(
        (
          currentAssignments as any[]
        ).map((assignment) =>
          Number(
            assignment.driver_id ?? 0,
          ),
        ),
      );

    return rows.map(
      (row: any) => {
        const driverId =
          Number(
            row.driver_id ??
              row.id ??
              0,
          );

        const mobile =
          String(
            row.driver_primary_mobile_number ??
              row.driver_mobile_number ??
              '',
          );

        const name =
          String(
            row.driver_name ??
              `Driver ${driverId}`,
          );

        const busyPlanId =
          busyByDriver.get(
            driverId,
          );

     const isOnLeave =
  driversOnLeave.has(driverId);

const isAvailable =
  !busyPlanId &&
  !isOnLeave;

        return {
          id: driverId,
          driverId,

          name,

          mobile,

          label:
            mobile
              ? `${name} — ${mobile}`
              : name,

        availability:
  busyPlanId
    ? 'on_trip'
    : isOnLeave
      ? TransportAvailabilityKind.driver_leave
      : 'available',

          isAvailable,

          isAssignedToCurrent:
            currentDriverIds.has(
              driverId,
            ),

          busyItineraryPlanId:
            busyPlanId ?? null,
        };
      },
    );
  }
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

async listDriversForAssign(
  vendorId: number | null,
  vendorVehicleTypeId?: number | null,
  itineraryPlanId?: number | null
) {
  if (itineraryPlanId && vendorId) {
    const drivers = await this.listAllocationDrivers({
      itineraryPlanId,
      vendorId,
      vendorVehicleTypeId:
        vendorVehicleTypeId ?? undefined,
    });

    return drivers
      .filter(driver => driver.isAvailable)
      .map(driver => ({
        id: driver.driverId,
        label: driver.label,
      }));
  }

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

 // REQUIRED in your Prisma model; ensure we always send a string (not the String constructor)
  const owner_pincode: string =
    (dto.owner_pincode ?? dto.ownerPincode ?? '').toString().trim();

  if (!vendor_id) throw new BadRequestException('vendor_id is required');
  if (!vehicle_type_id) throw new BadRequestException('vehicle_type_id is required');
  if (!registration_number) throw new BadRequestException('registration_number is required');
  if (!vehicle_fc_expiry_date) throw new BadRequestException('vehicle_fc_expiry_date is required');
  if (!insurance_start_date) throw new BadRequestException('insurance_start_date is required');
  if (!insurance_end_date) throw new BadRequestException('insurance_end_date is required');

const registration =
  this.registrationKey(registration_number);

if (!registration) {
  throw new BadRequestException(
    'registration_number is required',
  );
}

const registeredVehicles =
  await this.prisma.dvi_vehicle.findMany({
    where: {
      deleted: 0,
    },
    select: {
      vehicle_id: true,
      registration_number: true,
    },
  });

const existing = registeredVehicles.find(
  vehicle =>
    this.registrationKey(
      vehicle.registration_number,
    ) === registration,
);
  if (existing) {
    throw new BadRequestException(`Vehicle already exists: ${existing.registration_number}`);
  }

 // derive active status
  const now = new Date();
  const statusOk = (vehicle_fc_expiry_date ?? now) >= now && (insurance_end_date ?? now) >= now;
  const status = statusOk ? 1 : 0;

 // optional resolve origin id (city)
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
 // send a real string for required Prisma field
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

 // ---------- existence check (retry without `id` in select if schema doesnt have it) ----------
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
}, expectedVehicleId?: number) {
  return this.prisma.$transaction(async (db) => {
  const itinerary_plan_id =
      this.reqInt(
        dto.itineraryPlanId,
        'itineraryPlanId',
      );

    const vendor_id =
      this.reqInt(
        dto.vendor_id,
        'vendor_id',
      );

    const vehicle_type_id =
      this.reqInt(
        dto.vehicle_type_id,
        'vehicle_type_id',
      );

    const vehicle_id =
      this.reqInt(
        dto.vehicle_id,
        'vehicle_id',
      );

const driver_id =
  dto.driver_id == null
    ? null
    : this.reqInt(dto.driver_id, 'driver_id');

    const createdby =
      this.toInt(dto.createdby);

    const plan =
      await db
        .dvi_confirmed_itinerary_plan_details
        .findFirst({
          where: {
            itinerary_plan_ID:
              itinerary_plan_id,
            status: 1,
            deleted: 0,
          },
          select: {
            trip_start_date_and_time:
              true,
            trip_end_date_and_time:
              true,
          },
        });

    if (!plan) {
      throw new NotFoundException(
        'Confirmed itinerary plan not found',
      );
    }

  if (
  !plan.trip_start_date_and_time ||
  !plan.trip_end_date_and_time ||
  plan.trip_start_date_and_time.getTime() >
    plan.trip_end_date_and_time.getTime()
) {
  throw new BadRequestException(
    'Invalid confirmed itinerary travel dates',
  );
}

    const trip_start_date_and_time =
      plan.trip_start_date_and_time;

    const trip_end_date_and_time =
      plan.trip_end_date_and_time;

    /*
     * Validate that the selected real vehicle belongs to
     * the selected vendor + vendor vehicle type.
     */
const allocationVehicles =
  await this.listAllocationVehicles(
    itinerary_plan_id,
    db,
  );

const vehicle = allocationVehicles.find(
  row =>
    Number(row.vehicleId) === vehicle_id &&
    Number(row.vendorId) === vendor_id &&
    Number(row.vendorVehicleTypeId) === vehicle_type_id,
);

if (!vehicle) {
  throw new BadRequestException(
    'Selected vehicle does not match the confirmed booking vendor and vehicle type',
  );
}

if (vehicle.registrationConflict) {
  throw new BadRequestException(
    'Vehicle registration is missing or duplicated. Verify the vehicle master before assigning.',
  );
}

if (!vehicle.isAvailable) {
  throw new BadRequestException(
    `Selected vehicle is unavailable: ${vehicle.availability}`,
  );
}

    /*
     * Real overlapping VEHICLE assignment check.
     * The current itinerary is deliberately excluded.
     */
    const vehicleConflict =
      await db
        .dvi_confirmed_itinerary_vendor_vehicle_assigned
        .findFirst({
          where: {
            vehicle_id,

            itinerary_plan_id: {
              not: itinerary_plan_id,
            },

            status: 1,
            deleted: 0,
            assigned_vehicle_status: 1,

    trip_start_date_and_time: {
  lt: trip_end_date_and_time,
},

trip_end_date_and_time: {
  gt: trip_start_date_and_time,
},
          },
          select: {
            itinerary_plan_id: true,
          },
        });

    if (vehicleConflict) {
      throw new BadRequestException(
        'Selected vehicle is already assigned to another overlapping itinerary',
      );
    }

    /*
     * Real overlapping DRIVER assignment check.
     */
   if (driver_id) {
const eligibleDrivers =
  await this.listAllocationDrivers(
    {
      itineraryPlanId: itinerary_plan_id,
      vendorId: vendor_id,
      vendorVehicleTypeId: vehicle_type_id,
    },
    db,
  );

  const selectedDriver = eligibleDrivers.find(
    driver =>
      Number(driver.driverId) === driver_id &&
      driver.isAvailable,
  );

  if (!selectedDriver) {
    throw new BadRequestException(
      'Selected driver is unavailable or does not belong to the eligible vendor driver pool',
    );
  }

  const driverConflict =
        await db
          .dvi_confirmed_itinerary_vendor_driver_assigned
          .findFirst({
            where: {
              driver_id,

              itinerary_plan_id: {
                not: itinerary_plan_id,
              },

              status: 1,
              deleted: 0,
              assigned_driver_status: 1,

          trip_start_date_and_time: {
  lt: trip_end_date_and_time,
},

trip_end_date_and_time: {
  gt: trip_start_date_and_time,
},
            },
            select: {
              itinerary_plan_id: true,
            },
          });

  if (driverConflict) {
  throw new BadRequestException(
    'Selected driver is already assigned to another overlapping itinerary',
  );
}

const sameTripDriverConflict =
  await db
    .dvi_confirmed_itinerary_vendor_driver_assigned
    .findFirst({
      where: {
        itinerary_plan_id,
        driver_id,
        status: 1,
        deleted: 0,
        assigned_driver_status: 1,

        OR: [
          {
            vendor_id: {
              not: vendor_id,
            },
          },
          {
            vendor_vehicle_type_id: {
              not: vehicle_type_id,
            },
          },
        ],
      },

      select: {
        driver_assigned_ID: true,
      },
    });

if (sameTripDriverConflict) {
  throw new BadRequestException(
    'Selected driver is already assigned to another vehicle group in this booking',
  );
}
    }

  const [
  activeVehicleAssignments,
  activeDriverAssignments,
] = await Promise.all([
  db
    .dvi_confirmed_itinerary_vendor_vehicle_assigned
    .count({
      where: {
        itinerary_plan_id,
        vendor_id,
        vendor_vehicle_type_id: vehicle_type_id,
        status: 1,
        deleted: 0,
        assigned_vehicle_status: 1,
      },
    }),

db
.dvi_confirmed_itinerary_vendor_driver_assigned
    .count({
      where: {
        itinerary_plan_id,
        vendor_id,
        vendor_vehicle_type_id: vehicle_type_id,
        status: 1,
        deleted: 0,
        assigned_driver_status: 1,
      },
    }),
]);

if (
  activeVehicleAssignments > 1 ||
  activeDriverAssignments > 1
) {
  throw new BadRequestException(
    'Multiple active assignments exist for this vehicle type. Individual allocation is required.',
  );
}

/*
 * Keep the confirmed vendor/vehicle requirement in sync.
 */
await db
  .dvi_confirmed_itinerary_plan_vendor_vehicle_details
  .updateMany({
    where: {
      itinerary_plan_id,
      vendor_id,
      vendor_vehicle_type_id:
        vehicle_type_id,
      deleted: 0,
    },
    data: this.cleanUndefined({
      vehicle_id,
      createdby:
        createdby ?? undefined,
      updatedon:
        this.nowSql(),
    }),
  });

    /*
     * Idempotent vehicle assignment:
     * update current active assignment instead of inserting
     * duplicates when Confirm is clicked twice.
     */
    const existingVehicleAssignment =
     await db
        .dvi_confirmed_itinerary_vendor_vehicle_assigned
        .findFirst({
          where: {
            itinerary_plan_id,
            vendor_id,
            vendor_vehicle_type_id:
              vehicle_type_id,
            status: 1,
            deleted: 0,
            assigned_vehicle_status: 1,
          },
          select: {
            vehicle_id: true,
          },
        });

if (
  expectedVehicleId !== undefined &&
  Number(existingVehicleAssignment?.vehicle_id) !== expectedVehicleId
) {
  throw new BadRequestException(
    'Vehicle assignment has changed. Refresh before retrying.',
  );
}

if (
  dto.driver_id === undefined &&
  activeDriverAssignments > 0 &&
  (
    !existingVehicleAssignment ||
    Number(existingVehicleAssignment.vehicle_id) !== vehicle_id
  )
) {
  throw new BadRequestException(
    'Specify the driver assignment when changing the allocated vehicle',
  );
}

if (existingVehicleAssignment) {
  await db
    .dvi_confirmed_itinerary_vendor_vehicle_assigned
    .updateMany({
          where: {
            itinerary_plan_id,
            vendor_id,
            vendor_vehicle_type_id:
              vehicle_type_id,
            status: 1,
            deleted: 0,
            assigned_vehicle_status: 1,
          },
          data: this.cleanUndefined({
            vehicle_id,
            trip_start_date_and_time,
            trip_end_date_and_time,
            assigned_on:
              this.nowSql(),
            createdby:
              createdby ?? undefined,
          }),
        });
    }
    else {
      await db
        .dvi_confirmed_itinerary_vendor_vehicle_assigned
        .create({
          data: this.cleanUndefined({
            itinerary_plan_id,
            vendor_id,
            vendor_vehicle_type_id:
              vehicle_type_id,
            vehicle_id,
            trip_start_date_and_time,
            trip_end_date_and_time,
            assigned_vehicle_status: 1,
            assigned_on:
              this.nowSql(),
            createdby:
              createdby ?? undefined,
            status: 1,
            deleted: 0,
          }),
        });
    }

    let driverAssignmentId:
      number | null = null;

    if (driver_id) {
  const existingDriverAssignment =
 await db
    .dvi_confirmed_itinerary_vendor_driver_assigned
    .findFirst({
      where: {
        itinerary_plan_id,
        vendor_id,

        vendor_vehicle_type_id:
          vehicle_type_id,

        status: 1,
        deleted: 0,
        assigned_driver_status: 1,
      },
      orderBy: {
        driver_assigned_on: 'desc',
      },
      select: {
        driver_assigned_ID: true,
      },
    });

      if (existingDriverAssignment) {
        await db
          .dvi_confirmed_itinerary_vendor_driver_assigned
          .updateMany({
            where: {
              driver_assigned_ID:
                existingDriverAssignment
                  .driver_assigned_ID,
            },
            data:
              this.cleanUndefined({
                vendor_vehicle_type_id:
                  vehicle_type_id,
                vehicle_id,
                driver_id,
                trip_start_date_and_time,
                trip_end_date_and_time,
                assigned_driver_status: 1,
                driver_assigned_on:
                  this.nowSql(),
                createdby:
                  createdby ??
                  undefined,
              }),
          });

        driverAssignmentId =
          Number(
            existingDriverAssignment
              .driver_assigned_ID,
          ) || null;
      }
      else {
        const createdDriverAssignment =
          await db
            .dvi_confirmed_itinerary_vendor_driver_assigned
            .create({
              data:
                this.cleanUndefined({
                  itinerary_plan_id,
                  vendor_id,
                  vendor_vehicle_type_id:
                    vehicle_type_id,
                  vehicle_id,
                  driver_id,
                  trip_start_date_and_time,
                  trip_end_date_and_time,
                  assigned_driver_status: 1,
                  driver_assigned_on:
                    this.nowSql(),
                  createdby:
                    createdby ??
                    undefined,
                  status: 1,
                  deleted: 0,
                }),
            });
    driverAssignmentId =
  Number(
    createdDriverAssignment
      .driver_assigned_ID ?? 0,
  ) || null;
      }
    } else if (dto.driver_id === null) {
      await db
        .dvi_confirmed_itinerary_vendor_driver_assigned
        .updateMany({
          where: {
            itinerary_plan_id,
            vendor_id,
            vendor_vehicle_type_id: vehicle_type_id,
            status: 1,
            deleted: 0,
            assigned_driver_status: 1,
          },
          data: {
            assigned_driver_status: 0,
            status: 0,
          },
        });

      driverAssignmentId = null;
    }

    return {
      success: true,

      result_success:
        'Vehicle and driver assigned successfully',

      itineraryPlanId:
        itinerary_plan_id,

      vehicleId:
        vehicle_id,

      driverId:
        driver_id || null,

      driverAssignmentId,
    };
  }, {
    isolationLevel:
      Prisma.TransactionIsolationLevel.Serializable,
    timeout: 30000,
  });
  }

  async unassignDriver(dto: {
  itineraryPlanId: number;
  vendor_id: number;
  vehicle_type_id: number;
  vehicle_id: number;
  driver_id: number;
  driverAssignmentId: number;
}) {
  const itinerary_plan_id = this.reqInt(
    dto.itineraryPlanId,
    'itineraryPlanId',
  );

  const vendor_id = this.reqInt(
    dto.vendor_id,
    'vendor_id',
  );

  const vendor_vehicle_type_id = this.reqInt(
    dto.vehicle_type_id,
    'vehicle_type_id',
  );

  const vehicle_id = this.reqInt(
    dto.vehicle_id,
    'vehicle_id',
  );

  const driver_id = this.reqInt(
    dto.driver_id,
    'driver_id',
  );

  const driver_assigned_ID = this.reqInt(
    dto.driverAssignmentId,
    'driverAssignmentId',
  );

  if (
    [
      itinerary_plan_id,
      vendor_id,
      vendor_vehicle_type_id,
      vehicle_id,
      driver_id,
      driver_assigned_ID,
    ].some(id => !Number.isSafeInteger(id) || id <= 0)
  ) {
    throw new BadRequestException(
      'Invalid driver assignment information',
    );
  }

  return this.prisma.$transaction(async tx => {
    const vehicleAssignment =
      await tx
        .dvi_confirmed_itinerary_vendor_vehicle_assigned
        .findFirst({
          where: {
            itinerary_plan_id,
            vendor_id,
            vendor_vehicle_type_id,
            vehicle_id,
            status: 1,
            deleted: 0,
            assigned_vehicle_status: 1,
          },
        });

    if (!vehicleAssignment) {
      throw new BadRequestException(
        'Current vehicle assignment could not be verified',
      );
    }

    const activeDrivers =
      await tx
        .dvi_confirmed_itinerary_vendor_driver_assigned
        .count({
          where: {
            itinerary_plan_id,
            vendor_id,
            vendor_vehicle_type_id,
            vehicle_id,
            status: 1,
            deleted: 0,
            assigned_driver_status: 1,
          },
        });

    if (activeDrivers !== 1) {
      throw new BadRequestException(
        'Current driver assignment is missing or ambiguous',
      );
    }

    const result =
      await tx
        .dvi_confirmed_itinerary_vendor_driver_assigned
        .updateMany({
          where: {
            driver_assigned_ID,
            itinerary_plan_id,
            vendor_id,
            vendor_vehicle_type_id,
            vehicle_id,
            driver_id,
            status: 1,
            deleted: 0,
            assigned_driver_status: 1,
          },
          data: {
            assigned_driver_status: 0,
            status: 0,
          },
        });

    if (result.count !== 1) {
      throw new BadRequestException(
        'Driver assignment changed. Refresh before retrying.',
      );
    }

    return {
      success: true,
      message: 'Driver unassigned successfully',
      itineraryPlanId: itinerary_plan_id,
      vehicleId: vehicle_id,
      driverId: null,
      driverAssignmentId: null,
    };
  }, {
    isolationLevel:
      Prisma.TransactionIsolationLevel.Serializable,
    timeout: 30000,
  });
}
async reassignDriver(dto: {
  itineraryPlanId: number;
  vendor_id: number;
  vehicle_id?: number | null;
  driver_id: number;
  createdby?: number | null;
}) {
  const itineraryPlanId = this.reqInt(
    dto.itineraryPlanId,
    'itineraryPlanId',
  );

  const vendorId = this.reqInt(
    dto.vendor_id,
    'vendor_id',
  );

  const driverId = this.reqInt(
    dto.driver_id,
    'driver_id',
  );

  const requestedVehicleId =
    dto.vehicle_id == null
      ? null
      : this.reqInt(dto.vehicle_id, 'vehicle_id');

  const assignments = await this.prisma
    .dvi_confirmed_itinerary_vendor_vehicle_assigned
    .findMany({
      where: {
        itinerary_plan_id: itineraryPlanId,
        vendor_id: vendorId,
        status: 1,
        deleted: 0,
        assigned_vehicle_status: 1,

        ...(requestedVehicleId !== null
          ? { vehicle_id: requestedVehicleId }
          : {}),
      },

      select: {
        vehicle_id: true,
        vendor_vehicle_type_id: true,
      },

      take: 2,
    });

  if (assignments.length === 0) {
    throw new NotFoundException(
      'Active vehicle assignment not found',
    );
  }

  if (assignments.length !== 1) {
    throw new BadRequestException(
      'Multiple vehicle assignments found. Select a specific vehicle.',
    );
  }

  const assignment = assignments[0];

  const vehicleId = this.reqInt(
    assignment.vehicle_id,
    'vehicle_id',
  );

  const vehicleTypeId = this.reqInt(
    assignment.vendor_vehicle_type_id,
    'vendor_vehicle_type_id',
  );

  return this.assignVehicle(
    {
      itineraryPlanId,
      vendor_id: vendorId,
      vehicle_type_id: vehicleTypeId,
      vehicle_id: vehicleId,
      driver_id: driverId,
      createdby: dto.createdby,
    },
    vehicleId,
  );
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
private registrationKey(
  value: string | null | undefined,
): string {
  return (value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '');
}

private normalizeRegistrationNumber(v: any): string {
  return this.safeLabel(v)
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}
private toInt(value: unknown): number | null {
  if (
    typeof value !== 'number' &&
    typeof value !== 'string'
  ) {
    return null;
  }

  if (
    typeof value === 'string' &&
    !/^\d+$/.test(value.trim())
  ) {
    return null;
  }

  const id = Number(value);

  return Number.isSafeInteger(id) && id > 0
    ? id
    : null;
}

private reqInt(value: unknown, name: string): number {
  const id = this.toInt(value);

  if (id === null) {
    throw new BadRequestException(
      `${name} must be a valid positive integer`,
    );
  }

  return id;
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
