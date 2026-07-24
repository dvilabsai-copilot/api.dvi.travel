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
  async getLedger(query: AccountsLedgerQueryDto): Promise<any[]> {
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
        throw new BadRequestException('Unknown component type');
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

 // vendor filter
    if (query.vendorId && query.vendorId > 0) {
      detailsWhere.vendor_id = query.vendorId;
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
    _query: AccountsLedgerQueryDto,
  ): Promise<AccountsLedgerOptionsDto> {
    const [
      agentRows,
      branchRows,
      vendorRows,
      guideRows,
      hotspotRows,
      activityRows,
      hotelRows,
      vehicleRows,
    ] = await Promise.all([
 // Agents
      this.prisma.dvi_agent.findMany({
        where: { deleted: 0 },
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

 // Vehicle branches (branch dropdown)
      this.prisma.dvi_vendor_branches.findMany({
        where: { deleted: 0 },
        select: {
          vendor_branch_location: true,
        },
        orderBy: {
          vendor_branch_location: 'asc',
        },
      }),

 // Vehicle vendors dvi_vendor_details.vendor_name
      this.prisma.dvi_vendor_details.findMany({
        where: { deleted: 0 },
        select: {
          vendor_name: true,
        },
        orderBy: {
          vendor_name: 'asc',
        },
      }),

 // Guides dvi_guide_details.guide_name
      this.prisma.dvi_guide_details.findMany({
        where: { deleted: 0 },
        select: {
          guide_name: true,
        },
        orderBy: {
          guide_name: 'asc',
        },
      }),

 // Hotspots dvi_hotspot_place.hotspot_name
      this.prisma.dvi_hotspot_place.findMany({
        where: { deleted: 0 },
        select: {
          hotspot_name: true,
        },
        orderBy: {
          hotspot_name: 'asc',
        },
      }),

 // Activities dvi_activity.activity_title
      this.prisma.dvi_activity.findMany({
        where: { deleted: 0 },
        select: {
          activity_title: true,
        },
        orderBy: {
          activity_title: 'asc',
        },
      }),

 // Hotels deleted is boolean in Prisma
      this.prisma.dvi_hotel.findMany({
        where: {
          deleted: false,
        },
        select: {
          hotel_name: true,
        },
        orderBy: {
          hotel_name: 'asc',
        },
      }),

 // Vehicles only to get used vehicle_type_id values
      this.prisma.dvi_vehicle.findMany({
        where: { deleted: 0 },
        select: {
          vehicle_type_id: true,
        },
      }),
    ]);

 // Resolve vehicle_type_id vehicle_type_title
    const usedTypeIds = Array.from(
      new Set(
        vehicleRows
          .map((v) => v.vehicle_type_id)
          .filter((id): id is number => typeof id === 'number'),
      ),
    );

    let vehicleTypeRows:
      | { vehicle_type_title: string | null }[]
      | [] = [];

    if (usedTypeIds.length > 0) {
      vehicleTypeRows =
        await this.prisma.dvi_vehicle_type.findMany({
          where: {
 // assuming PK is vehicle_type_ID
            vehicle_type_id: { in: usedTypeIds },
          },
          select: {
            vehicle_type_title: true,
          },
          orderBy: {
            vehicle_type_title: 'asc',
          },
        });
    }

    const agents = agentRows
      .map((a) => {
        const parts = [a.agent_name, a.agent_lastname]
          .filter((v) => !!v && String(v).trim().length > 0)
          .map((v) => String(v).trim());

        const label = parts.join(' ').trim();
        return label || `Agent #${a.agent_ID}`;
      })
      .filter((v, idx, arr) => v && arr.indexOf(v) === idx)
      .sort((a, b) => a.localeCompare(b));

    const vehicleBranches = branchRows
      .map((b) => (b.vendor_branch_location ?? '').trim())
      .filter((v, idx, arr) => v && arr.indexOf(v) === idx)
      .sort((a, b) => a.localeCompare(b));

    const vehicles = vehicleTypeRows
      .map((v) => (v.vehicle_type_title ?? '').trim())
      .filter((v, idx, arr) => v && arr.indexOf(v) === idx)
      .sort((a, b) => a.localeCompare(b));

    const vendors = vendorRows
      .map((v) => (v.vendor_name ?? '').trim())
      .filter((v, idx, arr) => v && arr.indexOf(v) === idx)
      .sort((a, b) => a.localeCompare(b));

    const guides = guideRows
      .map((g) => (g.guide_name ?? '').trim())
      .filter((v, idx, arr) => v && arr.indexOf(v) === idx)
      .sort((a, b) => a.localeCompare(b));

    const hotspots = hotspotRows
      .map((h) => (h.hotspot_name ?? '').trim())
      .filter((v, idx, arr) => v && arr.indexOf(v) === idx)
      .sort((a, b) => a.localeCompare(b));

    const activities = activityRows
      .map((a) => (a.activity_title ?? '').trim())
      .filter((v, idx, arr) => v && arr.indexOf(v) === idx)
      .sort((a, b) => a.localeCompare(b));

    const hotels = hotelRows
      .map((h) => (h.hotel_name ?? '').trim())
      .filter((v, idx, arr) => v && arr.indexOf(v) === idx)
      .sort((a, b) => a.localeCompare(b));

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
