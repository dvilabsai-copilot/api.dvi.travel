// FILE: src/modules/accounts-ledger/accounts-ledger.service.ts

import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import {
  AccountsLedgerComponentType,
  AccountsLedgerQueryDto,
} from './dto/accounts-ledger-query.dto';
import { AccountsLedgerOptionsDto } from './dto/accounts-ledger-options.dto';

function parseDdMmYyyyPair(
  fromDate?: string,
  toDate?: string,
): { from?: Date; toExclusive?: Date } {
  if (!fromDate || !toDate) return {};
  const [fd, fm, fy] = fromDate.split('/');
  const [td, tm, ty] = toDate.split('/');

  const fDay = Number(fd),
    fMonth = Number(fm),
    fYear = Number(fy);
  const tDay = Number(td),
    tMonth = Number(tm),
    tYear = Number(ty);

  if (!fDay || !fMonth || !fYear || !tDay || !tMonth || !tYear) return {};

  const from = new Date(fYear, fMonth - 1, fDay);
  const to = new Date(tYear, tMonth - 1, tDay);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return {};

  const toExclusive = new Date(to);
  toExclusive.setDate(toExclusive.getDate() + 1);

  return { from, toExclusive };
}

@Injectable()
export class AccountsLedgerService {
  constructor(private readonly prisma: PrismaService) {}

 /**
   * Main entry – mirrors PHP ledger split:
   *   agent / guide / activity / hotel / hotspot / vehicle / all
   *
   * Returns *raw* DB rows so you have EVERY column:
   *   - AGENT: header rows from dvi_accounts_itinerary_details
   *   - others: { header, details, transactions[] }
 */
 async getLedger(
  query: AccountsLedgerQueryDto,
): Promise<any[]> {
  switch (query.componentType) {
    case AccountsLedgerComponentType.AGENT:
      return this.getAgentLedger(query);

    case AccountsLedgerComponentType.GUIDE:
      return this.getGuideLedger(query);

    case AccountsLedgerComponentType.ACTIVITY:
      return this.getActivityLedger(query);

    case AccountsLedgerComponentType.HOTEL:
      return this.getHotelLedger(query);

    case AccountsLedgerComponentType.HOTSPOT:
      return this.getHotspotLedger(query);

    case AccountsLedgerComponentType.VEHICLE:
      return this.getVehicleLedger(query);

    case AccountsLedgerComponentType.ALL:
      return this.getAllLedger(query);

    default:
      throw new BadRequestException(
        'Unknown component type',
      );
  }
}

 //
 // Common header (dvi_accounts_itinerary_details) filter
 //
  private buildHeaderWhere(query: AccountsLedgerQueryDto): any {
    const where: any = { deleted: 0 };

 // Quote filter: overrides date range
    if (query.quoteId && query.quoteId.trim() !== '') {
      where.itinerary_quote_ID = { contains: query.quoteId.trim() };
      if (query.agentId && query.agentId > 0) {
        where.agent_id = query.agentId;
      }
      return where;
    }

 // Date range
    if (query.fromDate && query.toDate) {
      const { from, toExclusive } = parseDdMmYyyyPair(
        query.fromDate,
        query.toDate,
      );
      if (from && toExclusive) {
        where.trip_start_date_and_time = {
          gte: from,
          lt: toExclusive,
        };
      }
    }

    if (query.agentId && query.agentId > 0) {
      where.agent_id = query.agentId;
    }

    return where;
  }

 //
 // AGENT LEDGER
 //
  private async getAgentLedger(
    query: AccountsLedgerQueryDto,
  ): Promise<any[]> {
    const where = this.buildHeaderWhere(query);

    return this.prisma.dvi_accounts_itinerary_details.findMany({
      where,
      orderBy: { trip_start_date_and_time: 'asc' },
    });
  }

 //
 // GUIDE LEDGER
 //
  private async getGuideLedger(
    query: AccountsLedgerQueryDto,
  ): Promise<any[]> {
    const headerWhere = this.buildHeaderWhere(query);
    const headers =
      await this.prisma.dvi_accounts_itinerary_details.findMany({
        where: headerWhere,
      });
    if (!headers.length) return [];

    const headerIds = headers.map(
      (h) => h.accounts_itinerary_details_ID,
    );

const detailsWhere: any = {
  deleted: 0,
  accounts_itinerary_details_ID: { in: headerIds },
};

if (query.guideId && query.guideId > 0) {
  detailsWhere.guide_id = query.guideId;
}

    const details =
      await this.prisma.dvi_accounts_itinerary_guide_details.findMany({
        where: detailsWhere,
      });
    if (!details.length) return [];

    const detailIds = details.map(
      (d) => d.accounts_itinerary_guide_details_ID,
    );

    const txns =
      await this.prisma.dvi_accounts_itinerary_guide_transaction_history.findMany(
        {
          where: {
            deleted: 0,
            accounts_itinerary_guide_details_ID: { in: detailIds },
          },
        },
      );

    const headerById = new Map<number, any>();
    headers.forEach((h) =>
      headerById.set(h.accounts_itinerary_details_ID, h),
    );

    const txnsByDetailId = new Map<number, any[]>();
    for (const t of txns) {
      const key = t.accounts_itinerary_guide_details_ID;
      if (!txnsByDetailId.has(key)) txnsByDetailId.set(key, []);
      txnsByDetailId.get(key)!.push(t);
    }

    return details.map((d) => ({
      header: headerById.get(d.accounts_itinerary_details_ID) || null,
      details: d,
      transactions:
        txnsByDetailId.get(d.accounts_itinerary_guide_details_ID) ||
        [],
    }));
  }

 //
 // ACTIVITY LEDGER
 //
  private async getActivityLedger(
    query: AccountsLedgerQueryDto,
  ): Promise<any[]> {
    const headerWhere = this.buildHeaderWhere(query);
    const headers =
      await this.prisma.dvi_accounts_itinerary_details.findMany({
        where: headerWhere,
      });
    if (!headers.length) return [];

    const headerIds = headers.map(
      (h) => h.accounts_itinerary_details_ID,
    );
const detailsWhere: any = {
  deleted: 0,
  accounts_itinerary_details_ID: { in: headerIds },
};

if (query.activityId && query.activityId > 0) {
  detailsWhere.activity_ID = query.activityId;
}
    const details =
      await this.prisma.dvi_accounts_itinerary_activity_details.findMany(
        {
          where: detailsWhere,
        },
      );
    if (!details.length) return [];

    const detailIds = details.map(
      (d) => d.accounts_itinerary_activity_details_ID,
    );

    const txns =
      await this.prisma.dvi_accounts_itinerary_activity_transaction_history.findMany(
        {
          where: {
            deleted: 0,
            accounts_itinerary_activity_details_ID: { in: detailIds },
          },
        },
      );

    const headerById = new Map<number, any>();
    headers.forEach((h) =>
      headerById.set(h.accounts_itinerary_details_ID, h),
    );

    const txnsByDetailId = new Map<number, any[]>();
    for (const t of txns) {
      const key = t.accounts_itinerary_activity_details_ID;
      if (!txnsByDetailId.has(key)) txnsByDetailId.set(key, []);
      txnsByDetailId.get(key)!.push(t);
    }

    return details.map((d) => ({
      header: headerById.get(d.accounts_itinerary_details_ID) || null,
      details: d,
      transactions:
        txnsByDetailId.get(
          d.accounts_itinerary_activity_details_ID,
        ) || [],
    }));
  }

 //
 // HOTEL LEDGER
 //
  private async getHotelLedger(
    query: AccountsLedgerQueryDto,
  ): Promise<any[]> {
    const headerWhere = this.buildHeaderWhere(query);
    const headers =
      await this.prisma.dvi_accounts_itinerary_details.findMany({
        where: headerWhere,
      });
    if (!headers.length) return [];

    const headerIds = headers.map(
      (h) => h.accounts_itinerary_details_ID,
    );
const detailsWhere: any = {
  deleted: 0,
  accounts_itinerary_details_ID: { in: headerIds },
};

if (query.hotelId && query.hotelId > 0) {
  detailsWhere.hotel_id = query.hotelId;
}

    const details =
      await this.prisma.dvi_accounts_itinerary_hotel_details.findMany(
        {
          where: detailsWhere,
        },
      );
    if (!details.length) return [];

    const detailIds = details.map(
      (d) => d.accounts_itinerary_hotel_details_ID,
    );

    const txns =
      await this.prisma.dvi_accounts_itinerary_hotel_transaction_history.findMany(
        {
          where: {
            deleted: 0,
            accounts_itinerary_hotel_details_ID: { in: detailIds },
          },
        },
      );

    const headerById = new Map<number, any>();
    headers.forEach((h) =>
      headerById.set(h.accounts_itinerary_details_ID, h),
    );

    const txnsByDetailId = new Map<number, any[]>();
    for (const t of txns) {
      const key = t.accounts_itinerary_hotel_details_ID;
      if (!txnsByDetailId.has(key)) txnsByDetailId.set(key, []);
      txnsByDetailId.get(key)!.push(t);
    }

    return details.map((d) => ({
      header: headerById.get(d.accounts_itinerary_details_ID) || null,
      details: d,
      transactions:
        txnsByDetailId.get(d.accounts_itinerary_hotel_details_ID) ||
        [],
    }));
  }

 //
 // HOTSPOT LEDGER
 //
  private async getHotspotLedger(
    query: AccountsLedgerQueryDto,
  ): Promise<any[]> {
    const headerWhere = this.buildHeaderWhere(query);
    const headers =
      await this.prisma.dvi_accounts_itinerary_details.findMany({
        where: headerWhere,
      });
    if (!headers.length) return [];

    const headerIds = headers.map(
      (h) => h.accounts_itinerary_details_ID,
    );

    const detailsWhere: any = {
      deleted: 0,
      accounts_itinerary_details_ID: { in: headerIds },
    };
    if (query.hotspotId && query.hotspotId > 0) {
      detailsWhere.hotspot_ID = query.hotspotId;
    }

    const details =
      await this.prisma.dvi_accounts_itinerary_hotspot_details.findMany(
        {
          where: detailsWhere,
        },
      );
    if (!details.length) return [];

    const detailIds = details.map(
      (d) => d.accounts_itinerary_hotspot_details_ID,
    );

    const txns =
      await this.prisma.dvi_accounts_itinerary_hotspot_transaction_history.findMany(
        {
          where: {
            deleted: 0,
            accounts_itinerary_hotspot_details_ID: { in: detailIds },
          },
        },
      );

    const headerById = new Map<number, any>();
    headers.forEach((h) =>
      headerById.set(h.accounts_itinerary_details_ID, h),
    );

    const txnsByDetailId = new Map<number, any[]>();
    for (const t of txns) {
      const key = t.accounts_itinerary_hotspot_details_ID;
      if (!txnsByDetailId.has(key)) txnsByDetailId.set(key, []);
      txnsByDetailId.get(key)!.push(t);
    }

    return details.map((d) => ({
      header: headerById.get(d.accounts_itinerary_details_ID) || null,
      details: d,
      transactions:
        txnsByDetailId.get(
          d.accounts_itinerary_hotspot_details_ID,
        ) || [],
    }));
  }

 //
 // VEHICLE LEDGER
 //
  private async getVehicleLedger(
    query: AccountsLedgerQueryDto,
  ): Promise<any[]> {
    const headerWhere = this.buildHeaderWhere(query);
    const headers =
      await this.prisma.dvi_accounts_itinerary_details.findMany({
        where: headerWhere,
      });
    if (!headers.length) return [];

    const headerIds = headers.map(
      (h) => h.accounts_itinerary_details_ID,
    );

 const detailsWhere: any = {
  deleted: 0,
  accounts_itinerary_details_ID: { in: headerIds },
};

// Vendor
if (query.vendorId && query.vendorId > 0) {
  detailsWhere.vendor_id = query.vendorId;
}

// Vendor Branch
if (
  query.vendorBranchId &&
  query.vendorBranchId > 0
) {
  detailsWhere.vendor_branch_id =
    query.vendorBranchId;
}

// Vehicle Type
if (
  query.vehicleTypeId &&
  query.vehicleTypeId > 0
) {
  detailsWhere.vehicle_type_id =
    query.vehicleTypeId;
}

    const details =
      await this.prisma.dvi_accounts_itinerary_vehicle_details.findMany(
        {
          where: detailsWhere,
        },
      );
    if (!details.length) return [];

    const detailIds = details.map(
      (d) => d.accounts_itinerary_vehicle_details_ID,
    );

    const txns =
      await this.prisma.dvi_accounts_itinerary_vehicle_transaction_history.findMany(
        {
          where: {
            deleted: 0,
            accounts_itinerary_vehicle_details_ID: { in: detailIds },
          },
        },
      );

    const headerById = new Map<number, any>();
    headers.forEach((h) =>
      headerById.set(h.accounts_itinerary_details_ID, h),
    );

    const txnsByDetailId = new Map<number, any[]>();
    for (const t of txns) {
      const key = t.accounts_itinerary_vehicle_details_ID;
      if (!txnsByDetailId.has(key)) txnsByDetailId.set(key, []);
      txnsByDetailId.get(key)!.push(t);
    }

    return details.map((d) => ({
      header: headerById.get(d.accounts_itinerary_details_ID) || null,
      details: d,
      transactions:
        txnsByDetailId.get(
          d.accounts_itinerary_vehicle_details_ID,
        ) || [],
    }));
  }

 //
 // ALL LEDGER
 //
  private async getAllLedger(
    query: AccountsLedgerQueryDto,
  ): Promise<any[]> {
    const [agent, guide, activity, hotel, hotspot, vehicle] =
      await Promise.all([
        this.getAgentLedger(query),
        this.getGuideLedger(query),
        this.getActivityLedger(query),
        this.getHotelLedger(query),
        this.getHotspotLedger(query),
        this.getVehicleLedger(query),
      ]);

    return [
      ...agent.map((row) => ({
        componentType: AccountsLedgerComponentType.AGENT,
        header: row,
      })),
      ...guide.map((row) => ({
        componentType: AccountsLedgerComponentType.GUIDE,
        ...row,
      })),
      ...activity.map((row) => ({
        componentType: AccountsLedgerComponentType.ACTIVITY,
        ...row,
      })),
      ...hotel.map((row) => ({
        componentType: AccountsLedgerComponentType.HOTEL,
        ...row,
      })),
      ...hotspot.map((row) => ({
        componentType: AccountsLedgerComponentType.HOTSPOT,
        ...row,
      })),
      ...vehicle.map((row) => ({
        componentType: AccountsLedgerComponentType.VEHICLE,
        ...row,
      })),
    ];
  }

 //
 // DROPDOWN OPTIONS dynamic, PHP-style
 //
async getFilterOptions(
  query: AccountsLedgerQueryDto,
): Promise<AccountsLedgerOptionsDto> {
  const vendorId = Number(
    query.vendorId || 0,
  );

  /*
   * When a Vendor is logged in, determine the Agents and
   * Vehicle Types that actually occur in that Vendor's ledger.
   */
  const vendorLedgerRows =
    vendorId > 0
      ? await this.prisma
          .dvi_accounts_itinerary_vehicle_details
          .findMany({
            where: {
              vendor_id: vendorId,
              deleted: 0,
            },
            select: {
              accounts_itinerary_details_ID:
                true,
              vehicle_type_id: true,
            },
          })
      : [];

  const vendorHeaderIds = Array.from(
    new Set(
      vendorLedgerRows
        .map((row) =>
          Number(
            row.accounts_itinerary_details_ID ||
              0,
          ),
        )
        .filter((id) => id > 0),
    ),
  );

  const vendorHeaderRows =
    vendorId > 0 &&
    vendorHeaderIds.length > 0
      ? await this.prisma
          .dvi_accounts_itinerary_details
          .findMany({
            where: {
              accounts_itinerary_details_ID: {
                in: vendorHeaderIds,
              },
              deleted: 0,
            },
            select: {
              agent_id: true,
            },
          })
      : [];

  const vendorAgentIds = Array.from(
    new Set(
      vendorHeaderRows
        .map((row) =>
          Number(row.agent_id || 0),
        )
        .filter((id) => id > 0),
    ),
  );

  const vendorVehicleTypeIds =
    Array.from(
      new Set(
        vendorLedgerRows
          .map((row) =>
            Number(
              row.vehicle_type_id || 0,
            ),
          )
          .filter((id) => id > 0),
      ),
    );

  const [
    agentRows,
    branchRows,
    vendorRows,
    guideRows,
    hotspotRows,
    activityRows,
    hotelRows,
    vehicleTypeRows,
  ] = await Promise.all([
    this.prisma.dvi_agent.findMany({
      where: {
        deleted: 0,
        ...(vendorId > 0
          ? {
              agent_ID: {
                in: vendorAgentIds,
              },
            }
          : {}),
      },
      select: {
        agent_ID: true,
        agent_name: true,
        agent_lastname: true,
      },
      orderBy: [
        { agent_name: 'asc' },
        { agent_lastname: 'asc' },
      ],
    }),

    this.prisma.dvi_vendor_branches.findMany({
      where: {
        deleted: 0,
        ...(vendorId > 0
          ? { vendor_id: vendorId }
          : {}),
      },
      select: {
        vendor_branch_id: true,
        vendor_branch_name: true,
        vendor_branch_location: true,
      },
      orderBy: {
        vendor_branch_name: 'asc',
      },
    }),

    this.prisma.dvi_vendor_details.findMany({
      where: {
        deleted: 0,
        ...(vendorId > 0
          ? { vendor_id: vendorId }
          : {}),
      },
      select: {
        vendor_id: true,
        vendor_name: true,
      },
      orderBy: {
        vendor_name: 'asc',
      },
    }),

    vendorId > 0
      ? Promise.resolve([])
      : this.prisma.dvi_guide_details.findMany({
          where: { deleted: 0 },
          select: {
            guide_id: true,
            guide_name: true,
          },
          orderBy: {
            guide_name: 'asc',
          },
        }),

    vendorId > 0
      ? Promise.resolve([])
      : this.prisma.dvi_hotspot_place.findMany({
          where: { deleted: 0 },
          select: {
            hotspot_ID: true,
            hotspot_name: true,
          },
          orderBy: {
            hotspot_name: 'asc',
          },
        }),

    vendorId > 0
      ? Promise.resolve([])
      : this.prisma.dvi_activity.findMany({
          where: { deleted: 0 },
          select: {
            activity_id: true,
            activity_title: true,
          },
          orderBy: {
            activity_title: 'asc',
          },
        }),

    vendorId > 0
      ? Promise.resolve([])
      : this.prisma.dvi_hotel.findMany({
          where: {
            deleted: false,
          },
          select: {
            hotel_id: true,
            hotel_name: true,
          },
          orderBy: {
            hotel_name: 'asc',
          },
        }),

    this.prisma.dvi_vehicle_type.findMany({
      where: {
        deleted: 0,
        ...(vendorId > 0
          ? {
              vehicle_type_id: {
                in: vendorVehicleTypeIds,
              },
            }
          : {}),
      },
      select: {
        vehicle_type_id: true,
        vehicle_type_title: true,
      },
      orderBy: {
        vehicle_type_title: 'asc',
      },
    }),
  ]);

  const agents = agentRows
    .map((agent) => {
      const name = [
        agent.agent_name,
        agent.agent_lastname,
      ]
        .filter(
          (value) =>
            value &&
            String(value).trim(),
        )
        .map((value) =>
          String(value).trim(),
        )
        .join(' ')
        .trim();

      return {
        id: Number(agent.agent_ID),
        label:
          name ||
          `Agent #${agent.agent_ID}`,
      };
    })
    .filter(
      (item) =>
        item.id > 0 &&
        item.label.length > 0,
    );

  const vehicleBranches =
    branchRows.map((branch) => ({
      id: Number(
        branch.vendor_branch_id,
      ),
      label:
        String(
          branch.vendor_branch_name ||
            branch.vendor_branch_location ||
            `Branch #${branch.vendor_branch_id}`,
        ).trim(),
    }));

  const vendors = vendorRows.map(
    (vendor) => ({
      id: Number(vendor.vendor_id),
      label:
        String(
          vendor.vendor_name ||
            `Vendor #${vendor.vendor_id}`,
        ).trim(),
    }),
  );

  const vehicles =
    vehicleTypeRows.map((vehicle) => ({
      id: Number(
        vehicle.vehicle_type_id,
      ),
      label:
        String(
          vehicle.vehicle_type_title ||
            `Vehicle Type #${vehicle.vehicle_type_id}`,
        ).trim(),
    }));

  const guides = guideRows.map(
    (guide: any) => ({
      id: Number(guide.guide_id),
      label:
        String(
          guide.guide_name ||
            `Guide #${guide.guide_id}`,
        ).trim(),
    }),
  );

  const hotspots = hotspotRows.map(
    (hotspot: any) => ({
      id: Number(hotspot.hotspot_ID),
      label:
        String(
          hotspot.hotspot_name ||
            `Hotspot #${hotspot.hotspot_ID}`,
        ).trim(),
    }),
  );

  const activities = activityRows.map(
    (activity: any) => ({
      id: Number(activity.activity_id),
      label:
        String(
          activity.activity_title ||
            `Activity #${activity.activity_id}`,
        ).trim(),
    }),
  );

  const hotels = hotelRows.map(
    (hotel: any) => ({
      id: Number(hotel.hotel_id),
      label:
        String(
          hotel.hotel_name ||
            `Hotel #${hotel.hotel_id}`,
        ).trim(),
    }),
  );

  return {
    agents,
    vehicleBranches,
    vehicles,
    vendors,
    guides,
    hotspots,
    activities,
    hotels,
  };
}
}