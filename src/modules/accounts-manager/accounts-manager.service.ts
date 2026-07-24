// FILE: src/modules/accounts-manager/accounts-manager.service.ts

import { Injectable, BadRequestException } from "@nestjs/common";
import { PrismaService } from "../../prisma.service";
import {
  AccountsManagerQueryDto,
  AccountsManagerStatus,
  AccountsManagerComponentType,
} from "./dto/accounts-manager-query.dto";
import {
  AccountsManagerRowDto,
  AccountsManagerRowComponentType,
} from "./dto/accounts-manager-row.dto";
import {
  AccountsManagerSummaryDto,
  AccountsManagerQuoteDto,
  AccountsManagerAgentDto,
  AccountsManagerPaymentModeDto,
  AccountsManagerPayDto,
} from "./dto/accounts-manager-extra.dto";

@Injectable()
export class AccountsManagerService {
  constructor(private readonly prisma: PrismaService) {}

 // MAIN LIST now also exposes headerId, routeDate, vendorId, vehicleId
  async list(query: AccountsManagerQueryDto): Promise<AccountsManagerRowDto[]> {
    const status: AccountsManagerStatus = query.status || "all";
    const componentType: AccountsManagerComponentType =
      query.componentType || "all";

    const fromDate = parseDDMMYYYY(query.fromDate);
 const toDate = parseDDMMYYYY(query.toDate, true); // end of day

 // 1 Base filter on accounts header
    const detailsWhere: any = {
      deleted: 0,
    };

    if (query.quoteId) {
      detailsWhere.itinerary_quote_ID = {
        contains: query.quoteId,
      };
    }

    if (query.agentId) {
      detailsWhere.agent_id = Number(query.agentId);
    } else if ((query as any).travelExpertId) {
      const teAgents = await this.prisma.dvi_agent.findMany({
        where: { travel_expert_id: Number((query as any).travelExpertId), deleted: 0 },
        select: { agent_ID: true },
      });
      const teAgentIds = teAgents.map((a) => Number(a.agent_ID));
      detailsWhere.agent_id = { in: teAgentIds };
    }

    if (fromDate && toDate) {
      detailsWhere.trip_start_date_and_time = { gte: fromDate };
      detailsWhere.trip_end_date_and_time = { lte: toDate };
    } else if (fromDate) {
      detailsWhere.trip_start_date_and_time = { gte: fromDate };
    } else if (toDate) {
      detailsWhere.trip_end_date_and_time = { lte: toDate };
    }

    const headers = await this.prisma.dvi_accounts_itinerary_details.findMany({
      where: detailsWhere,
      select: {
        accounts_itinerary_details_ID: true,
        itinerary_quote_ID: true,
        itinerary_plan_ID: true,
        agent_id: true,
        trip_start_date_and_time: true,
        trip_end_date_and_time: true,
        total_received_amount: true,
        total_payout_amount: true,
      },
    });

    if (!headers.length) {
      return [];
    }

    const headersById = new Map<number, (typeof headers)[number]>();
    const headerIds: number[] = [];

    for (const h of headers) {
      headersById.set(h.accounts_itinerary_details_ID, h);
      headerIds.push(h.accounts_itinerary_details_ID);
    }

    const planIds = Array.from(new Set(headers.map(h => h.itinerary_plan_ID).filter(id => id > 0)));
    const plans = planIds.length
      ? await this.prisma.dvi_itinerary_plan_details.findMany({
          where: { itinerary_plan_ID: { in: planIds } },
          select: {
            itinerary_plan_ID: true,
            arrival_location: true,
            departure_location: true,
            total_adult: true,
            total_children: true,
            total_infants: true,
          }
        })
      : [];

    const planMap = new Map<number, any>();
    for (const p of plans) {
      planMap.set(p.itinerary_plan_ID, p);
    }

 // 2 Agents map (for agent name filter + display)
    const agentIds = Array.from(
      new Set(headers.map((h) => h.agent_id).filter((x) => x && x > 0)),
    );

    const agents = agentIds.length
      ? await this.prisma.dvi_agent.findMany({
          where: {
            agent_ID: { in: agentIds },
          },
          select: {
            agent_ID: true,
            agent_name: true,
          },
        })
      : [];

    const agentMap = new Map<number, string>();
    for (const a of agents) {
      agentMap.set(a.agent_ID, a.agent_name || "");
    }

 // If agent name filter is provided, restrict headers here
    let filteredHeaderIds = headerIds;
    if (query.agent) {
      const needle = query.agent.toLowerCase();
      filteredHeaderIds = headerIds.filter((id) => {
        const header = headersById.get(id);
        if (!header) return false;
        const aName = (agentMap.get(header.agent_id) || "").toLowerCase();
        return aName.includes(needle);
      });
    }

    if (!filteredHeaderIds.length) {
      return [];
    }

    const shouldIncludeByStatus = (balance: number): boolean => {
      const rowStatus: "paid" | "due" = balance === 0 ? "paid" : "due";
      if (status === "all") return true;
      return status === rowStatus;
    };

    const rows: AccountsManagerRowDto[] = [];

 // Shared helper to build base row from header
    const buildBaseRow = (
      detailHeaderId: number,
      vendorName: string,
      amount: number,
      paid: number,
      balance: number,
      component: AccountsManagerRowComponentType,
    ): AccountsManagerRowDto | null => {
      if (!shouldIncludeByStatus(balance)) return null;

      const header = headersById.get(detailHeaderId);
      if (!header) return null;

      const plan = planMap.get(header.itinerary_plan_ID);
      const quoteId = header.itinerary_quote_ID || "";
      const agentName = agentMap.get(header.agent_id) || "";

 // search filter (quote + vendor name)
      if (query.search) {
        const s = query.search.toLowerCase();
        if (
          !quoteId.toLowerCase().includes(s) &&
          !vendorName.toLowerCase().includes(s)
        ) {
          return null;
        }
      }

      const rowStatus: "paid" | "due" = balance === 0 ? "paid" : "due";

      const startDate = formatToDDMMYYYY(header.trip_start_date_and_time);
      const endDate = formatToDDMMYYYY(header.trip_end_date_and_time);
 // In PHP this is itinerary_route_date; here we default to trip start date
      const routeDate = startDate;

      return {
 headerId: detailHeaderId, // header row ID (accounts_itinerary_details_ID)
 id: detailHeaderId, // will be overwritten per component with detail row id
        quoteId,
        hotelName: vendorName,
        amount,
        payout: paid,
        payable: balance,
        status: rowStatus,
        componentType: component,
        agent: agentName,
        startDate,
        endDate,
        routeDate,
 // per-component enrichments will fill these:
        vendorId: undefined,
        vehicleId: undefined,
        arrivalLocation: plan?.arrival_location || "",
        departureLocation: plan?.departure_location || "",
        guestName: plan ? `Adult: ${plan.total_adult}, Child: ${plan.total_children}` : "",
        inhandAmount: (header.total_received_amount || 0) - (header.total_payout_amount || 0),
      };
    };

 // 3 HOTEL component
    if (componentType === "all" || componentType === "hotel") {
      const hotelDetails =
        await this.prisma.dvi_accounts_itinerary_hotel_details.findMany({
          where: {
            deleted: 0,
            accounts_itinerary_details_ID: { in: filteredHeaderIds },
          },
          select: {
            accounts_itinerary_hotel_details_ID: true,
            accounts_itinerary_details_ID: true,
            hotel_id: true,
            total_payable: true,
            total_paid: true,
            total_balance: true,
            total_hotel_cost: true,
            total_hotel_tax_amount: true,
            total_purchase_cost: true,
          },
        });

      const hotelIds = Array.from(
        new Set(hotelDetails.map((h) => h.hotel_id).filter((x) => x && x > 0)),
      );

      const hotels = hotelIds.length
        ? await this.prisma.dvi_hotel.findMany({
            where: { hotel_id: { in: hotelIds } },
            select: { hotel_id: true, hotel_name: true },
          })
        : [];

      const hotelMap = new Map<number, string>();
      for (const h of hotels) {
        hotelMap.set(h.hotel_id, h.hotel_name || "");
      }

      for (const hd of hotelDetails) {
        const vendorName = hotelMap.get(hd.hotel_id) || "Hotel";
        const base = buildBaseRow(
          hd.accounts_itinerary_details_ID,
          vendorName,
          hd.total_payable,
          hd.total_paid,
          hd.total_balance,
          "hotel",
        );
        if (!base) continue;
        base.id = hd.accounts_itinerary_hotel_details_ID;
 // match PHP: hotel_id as vendorId
        base.vendorId = hd.hotel_id || undefined;

        base.receivableFromAgentAmount = (hd.total_hotel_cost || 0) + (hd.total_hotel_tax_amount || 0);
        base.marginAmount = (hd.total_hotel_cost || 0) - (hd.total_purchase_cost || 0);
        base.tax = hd.total_hotel_tax_amount || 0;

        rows.push(base);
      }
    }

 // 4 GUIDE component
    if (componentType === "all" || componentType === "guide") {
      const guideDetails =
        await this.prisma.dvi_accounts_itinerary_guide_details.findMany({
          where: {
            deleted: 0,
            accounts_itinerary_details_ID: { in: filteredHeaderIds },
          },
          select: {
            accounts_itinerary_guide_details_ID: true,
            accounts_itinerary_details_ID: true,
            guide_id: true,
            total_payable: true,
            total_paid: true,
            total_balance: true,
            guide_slot_cost: true,
          },
        });

      const guideIds = Array.from(
        new Set(
          guideDetails.map((g) => g.guide_id).filter((x) => x && x > 0),
        ),
      );

      const guides = guideIds.length
        ? await this.prisma.dvi_guide_details.findMany({
            where: { guide_id: { in: guideIds } },
            select: { guide_id: true, guide_name: true },
          })
        : [];

      const guideMap = new Map<number, string>();
      for (const g of guides) {
        guideMap.set(g.guide_id, g.guide_name || "");
      }

      for (const gd of guideDetails) {
        const vendorName = guideMap.get(gd.guide_id) || "Guide";
        const base = buildBaseRow(
          gd.accounts_itinerary_details_ID,
          vendorName,
          gd.total_payable,
          gd.total_paid,
          gd.total_balance,
          "guide",
        );
        if (!base) continue;
        base.id = gd.accounts_itinerary_guide_details_ID;
 // PHP semantics: guide_id as vendorId
        base.vendorId = gd.guide_id || undefined;
        rows.push(base);
      }
    }

 // 5 HOTSPOT component
    if (componentType === "all" || componentType === "hotspot") {
      const hotspotDetails =
        await this.prisma.dvi_accounts_itinerary_hotspot_details.findMany({
          where: {
            deleted: 0,
            accounts_itinerary_details_ID: { in: filteredHeaderIds },
          },
          select: {
            accounts_itinerary_hotspot_details_ID: true,
            accounts_itinerary_details_ID: true,
            hotspot_ID: true,
            hotspot_amount: true,
            total_payable: true,
            total_paid: true,
            total_balance: true,
          },
        });

      const hotspotIds = Array.from(
        new Set(
          hotspotDetails.map((h) => h.hotspot_ID).filter((x) => x && x > 0),
        ),
      );

      const hotspots = hotspotIds.length
        ? await this.prisma.dvi_hotspot_place.findMany({
            where: { hotspot_ID: { in: hotspotIds } },
            select: { hotspot_ID: true, hotspot_name: true },
          })
        : [];

      const hotspotMap = new Map<number, string>();
      for (const h of hotspots) {
        hotspotMap.set(h.hotspot_ID, h.hotspot_name || "");
      }

      for (const hd of hotspotDetails) {
        const vendorName = hotspotMap.get(hd.hotspot_ID) || "Hotspot";
        const amount = hd.hotspot_amount ?? hd.total_payable;
        const base = buildBaseRow(
          hd.accounts_itinerary_details_ID,
          vendorName,
          amount,
          hd.total_paid,
          hd.total_balance,
          "hotspot",
        );
        if (!base) continue;
        base.id = hd.accounts_itinerary_hotspot_details_ID;
 // PHP semantics: hotspot_ID as vendorId
        base.vendorId = hd.hotspot_ID || undefined;
        rows.push(base);
      }
    }

 // 6 ACTIVITY component
    if (componentType === "all" || componentType === "activity") {
      const activityDetails =
        await this.prisma.dvi_accounts_itinerary_activity_details.findMany({
          where: {
            deleted: 0,
            accounts_itinerary_details_ID: { in: filteredHeaderIds },
          },
          select: {
            accounts_itinerary_activity_details_ID: true,
            accounts_itinerary_details_ID: true,
            activity_ID: true,
            activity_amount: true,
            total_payable: true,
            total_paid: true,
            total_balance: true,
          },
        });

      const activityIds = Array.from(
        new Set(
          activityDetails.map((a) => a.activity_ID).filter((x) => x && x > 0),
        ),
      );

      const activities = activityIds.length
        ? await this.prisma.dvi_activity.findMany({
            where: { activity_id: { in: activityIds } },
            select: { activity_id: true, activity_title: true },
          })
        : [];

      const activityMap = new Map<number, string>();
      for (const a of activities) {
        activityMap.set(a.activity_id, a.activity_title || "");
      }

      for (const ad of activityDetails) {
        const vendorName = activityMap.get(ad.activity_ID) || "Activity";
        const amount = ad.activity_amount ?? ad.total_payable;
        const base = buildBaseRow(
          ad.accounts_itinerary_details_ID,
          vendorName,
          amount,
          ad.total_paid,
          ad.total_balance,
          "activity",
        );
        if (!base) continue;
        base.id = ad.accounts_itinerary_activity_details_ID;
 // PHP semantics: activity_ID as vendorId
        base.vendorId = ad.activity_ID || undefined;
        rows.push(base);
      }
    }

 // 7 VEHICLE component
    if (componentType === "all" || componentType === "vehicle") {
      const vehicleDetails =
        await this.prisma.dvi_accounts_itinerary_vehicle_details.findMany({
          where: {
            deleted: 0,
            accounts_itinerary_details_ID: { in: filteredHeaderIds },
          },
          select: {
            accounts_itinerary_vehicle_details_ID: true,
            accounts_itinerary_details_ID: true,
            vehicle_id: true,
            total_payable: true,
            total_paid: true,
            total_balance: true,
            vehicle_grand_total: true,
            total_purchase: true,
          },
        });

      const vehicleIds = Array.from(
        new Set(
          vehicleDetails.map((v) => v.vehicle_id).filter((x) => x && x > 0),
        ),
      );

      const vehicles = vehicleIds.length
        ? await this.prisma.dvi_vehicle.findMany({
            where: { vehicle_id: { in: vehicleIds } },
            select: {
              vehicle_id: true,
              registration_number: true,
              owner_name: true,
            },
          })
        : [];

// (continue)
      const vehicleMap = new Map<number, string>();
      for (const v of vehicles) {
        const label =
          v.registration_number ||
          v.owner_name ||
          `Vehicle #${v.vehicle_id}`;
        vehicleMap.set(v.vehicle_id, label);
      }

      for (const vd of vehicleDetails) {
        const vendorName = vehicleMap.get(vd.vehicle_id) || "Vehicle";
        const base = buildBaseRow(
          vd.accounts_itinerary_details_ID,
          vendorName,
          vd.total_payable,
          vd.total_paid,
          vd.total_balance,
          "vehicle",
        );
        if (!base) continue;
        base.id = vd.accounts_itinerary_vehicle_details_ID;
 // expose both vehicleId (for detail popup) and vendorId if needed
        base.vehicleId = vd.vehicle_id || undefined;
 // vendorId can also point to the same, like PHP often uses vendor/vehicle lookup
        base.vendorId = vd.vehicle_id || undefined;

        base.receivableFromAgentAmount = (vd.vehicle_grand_total || 0);
        base.marginAmount = (vd.vehicle_grand_total || 0) - (vd.total_purchase || 0);
        base.tax = 0;

        rows.push(base);
      }
    }

 // 8 Sort by start date desc + quoteId as fallback
    rows.sort((a, b) => {
      const da = toComparable(a.startDate);
      const db = toComparable(b.startDate);
      if (da === db) {
        return (b.quoteId || "").localeCompare(a.quoteId || "");
      }
      return db.localeCompare(da);
    });

    return rows;
  }

 /**
   * 🔹 Internal helper used by summary/query endpoints.
   * Rebuilds the same header filtering logic used in list(),
   * but only returns the header IDs + normalized status/componentType.
 */
  private async getFilteredHeaderIds(
    query: AccountsManagerQueryDto,
  ): Promise<{
    headerIds: number[];
    status: AccountsManagerStatus;
    componentType: AccountsManagerComponentType;
  }> {
    const status: AccountsManagerStatus = query.status || "all";
    const componentType: AccountsManagerComponentType =
      query.componentType || "all";

    const fromDate = parseDDMMYYYY(query.fromDate);
    const toDate = parseDDMMYYYY(query.toDate, true);

    const where: any = {
      deleted: 0,
    };

    if (query.quoteId) {
      where.itinerary_quote_ID = {
        contains: query.quoteId,
      };
    }

    if (query.agentId) {
      where.agent_id = Number(query.agentId);
    } else if ((query as any).travelExpertId) {
      const teAgents = await this.prisma.dvi_agent.findMany({
        where: { travel_expert_id: Number((query as any).travelExpertId), deleted: 0 },
        select: { agent_ID: true },
      });
      const teAgentIds = teAgents.map((a) => Number(a.agent_ID));
      where.agent_id = { in: teAgentIds };
    }

    if (fromDate && toDate) {
      where.trip_start_date_and_time = { gte: fromDate };
      where.trip_end_date_and_time = { lte: toDate };
    } else if (fromDate) {
      where.trip_start_date_and_time = { gte: fromDate };
    } else if (toDate) {
      where.trip_end_date_and_time = { lte: toDate };
    }

    const headers = await this.prisma.dvi_accounts_itinerary_details.findMany({
      where,
      select: {
        accounts_itinerary_details_ID: true,
        agent_id: true,
      },
    });

    if (!headers.length) {
      return { headerIds: [], status, componentType };
    }

    const headerIds = headers.map(
      (h) => h.accounts_itinerary_details_ID,
    );

 // Agent filter (same behaviour as list)
    if (query.agent) {
      const agentIds = Array.from(
        new Set(headers.map((h) => h.agent_id).filter((x) => x && x > 0)),
      );

      const agents = agentIds.length
        ? await this.prisma.dvi_agent.findMany({
            where: {
              agent_ID: { in: agentIds },
            },
            select: {
              agent_ID: true,
              agent_name: true,
            },
          })
        : [];

      const agentMap = new Map<number, string>();
      for (const a of agents) {
        agentMap.set(a.agent_ID, a.agent_name || "");
      }

      const needle = query.agent.toLowerCase();
      const filtered = headers.filter((h) => {
        const aName = (agentMap.get(h.agent_id) || "").toLowerCase();
        return aName.includes(needle);
      });

      return {
        headerIds: filtered.map(
          (h) => h.accounts_itinerary_details_ID,
        ),
        status,
        componentType,
      };
    }

    return { headerIds, status, componentType };
  }

 /**
   * 🔹 GET /accounts-manager/summary
   * Aggregates total_payable / total_paid / total_balance across
   * all visible component rows based on filters.
 */
  async getSummary(
    query: AccountsManagerQueryDto,
  ): Promise<AccountsManagerSummaryDto> {
    const { headerIds, status, componentType } =
      await this.getFilteredHeaderIds(query);

    if (!headerIds.length) {
      return {
        totalPayable: 0,
        totalPaid: 0,
        totalBalance: 0,
        rowCount: 0,
      };
    }

    const includeTypes: AccountsManagerRowComponentType[] =
      componentType === "all"
        ? ["guide", "hotspot", "activity", "hotel", "vehicle"]
        : [componentType as AccountsManagerRowComponentType];

    const applyStatusFilter = <
      T extends { total_balance: number | null | undefined },
    >(
      rows: T[],
    ) => {
      if (status === "all") return rows;
      return rows.filter((r) => {
        const bal = Number(r.total_balance ?? 0);
        const isPaid = bal === 0;
        return status === "paid" ? isPaid : !isPaid;
      });
    };

    let totalPayable = 0;
    let totalPaid = 0;
    let totalBalance = 0;
    let rowCount = 0;

 // HOTEL
    if (includeTypes.includes("hotel")) {
      const rows =
        await this.prisma.dvi_accounts_itinerary_hotel_details.findMany(
          {
            where: {
              deleted: 0,
              accounts_itinerary_details_ID: { in: headerIds },
            },
            select: {
              total_payable: true,
              total_paid: true,
              total_balance: true,
            },
          },
        );
      const filtered = applyStatusFilter(rows);
      for (const r of filtered) {
        totalPayable += Number(r.total_payable ?? 0);
        totalPaid += Number(r.total_paid ?? 0);
        totalBalance += Number(r.total_balance ?? 0);
      }
      rowCount += filtered.length;
    }

 // VEHICLE
    if (includeTypes.includes("vehicle")) {
      const rows =
        await this.prisma.dvi_accounts_itinerary_vehicle_details.findMany(
          {
            where: {
              deleted: 0,
              accounts_itinerary_details_ID: { in: headerIds },
            },
            select: {
              total_payable: true,
              total_paid: true,
              total_balance: true,
            },
          },
        );
      const filtered = applyStatusFilter(rows);
      for (const r of filtered) {
        totalPayable += Number(r.total_payable ?? 0);
        totalPaid += Number(r.total_paid ?? 0);
        totalBalance += Number(r.total_balance ?? 0);
      }
      rowCount += filtered.length;
    }

 // GUIDE
    if (includeTypes.includes("guide")) {
      const rows =
        await this.prisma.dvi_accounts_itinerary_guide_details.findMany(
          {
            where: {
              deleted: 0,
              accounts_itinerary_details_ID: { in: headerIds },
            },
            select: {
              total_payable: true,
              total_paid: true,
              total_balance: true,
            },
          },
        );
      const filtered = applyStatusFilter(rows);
      for (const r of filtered) {
        totalPayable += Number(r.total_payable ?? 0);
        totalPaid += Number(r.total_paid ?? 0);
        totalBalance += Number(r.total_balance ?? 0);
      }
      rowCount += filtered.length;
    }

 // HOTSPOT
    if (includeTypes.includes("hotspot")) {
      const rows =
        await this.prisma.dvi_accounts_itinerary_hotspot_details.findMany(
          {
            where: {
              deleted: 0,
              accounts_itinerary_details_ID: { in: headerIds },
            },
            select: {
              total_payable: true,
              total_paid: true,
              total_balance: true,
            },
          },
        );
      const filtered = applyStatusFilter(rows);
      for (const r of filtered) {
        totalPayable += Number(r.total_payable ?? 0);
        totalPaid += Number(r.total_paid ?? 0);
        totalBalance += Number(r.total_balance ?? 0);
      }
      rowCount += filtered.length;
    }

 // ACTIVITY
    if (includeTypes.includes("activity")) {
      const rows =
        await this.prisma.dvi_accounts_itinerary_activity_details.findMany(
          {
            where: {
              deleted: 0,
              accounts_itinerary_details_ID: { in: headerIds },
            },
            select: {
              total_payable: true,
              total_paid: true,
              total_balance: true,
            },
          },
        );
      const filtered = applyStatusFilter(rows);
      for (const r of filtered) {
        totalPayable += Number(r.total_payable ?? 0);
        totalPaid += Number(r.total_paid ?? 0);
        totalBalance += Number(r.total_balance ?? 0);
      }
      rowCount += filtered.length;
    }

    return {
      totalPayable,
      totalPaid,
      totalBalance,
      rowCount,
    };
  }

 /**
   * 🔹 GET /accounts-manager/quotes?q=...
   * Quote autocomplete – distinct itinerary_quote_ID values.
 */
  async searchQuotes(
    phrase: string,
  ): Promise<AccountsManagerQuoteDto[]> {
    const where: any = {};

    if (phrase) {
      where.itinerary_quote_ID = {
        contains: phrase,
      };
    }

    const rows =
      await this.prisma.dvi_accounts_itinerary_details.findMany({
        where,
        distinct: ["itinerary_quote_ID"],
        select: {
          itinerary_quote_ID: true,
        },
        orderBy: {
          accounts_itinerary_details_ID: "desc",
        },
        take: 20,
      });

    return rows
      .map((r) => (r.itinerary_quote_ID || "").trim())
      .filter((q) => !!q)
      .map((q) => ({ quoteId: q }));
  }

 /**
   * 🔹 GET /accounts-manager/agents
   * Agent dropdown – simple list of all agents.
 */
  async listAgents(): Promise<AccountsManagerAgentDto[]> {
    const agents = await this.prisma.dvi_agent.findMany({
      select: {
        agent_ID: true,
        agent_name: true,
      },
      orderBy: {
        agent_name: "asc",
      },
    });

 console.log("Fetched agents:", agents.length);

    return agents.map((a) => ({
      id: a.agent_ID,
      name: a.agent_name || "",
    }));
  }

 /**
   * 🔹 GET /accounts-manager/payment-modes
   * Returns static payment modes (aligned with PHP: 1=Cash, 2=UPI, 3=Net Banking).
 */
  async listPaymentModes(): Promise<AccountsManagerPaymentModeDto[]> {
    return [
      { id: 1, label: "Cash" },
      { id: 2, label: "UPI" },
      { id: 3, label: "Net Banking" },
    ];
  }

 /**
   * 🔹 POST /accounts-manager/pay
   * Updates total_paid & total_balance for a single component row
   * AND inserts a row into the corresponding *_transaction_history table.
 */
  async recordPayment(body: AccountsManagerPayDto): Promise<void> {
    const {
      componentType,
      componentDetailId,
 // accountsItineraryDetailsId, // ignored for now to avoid strict mismatch
      amount,
    } = body;

    if (amount <= 0) {
      throw new BadRequestException("Amount must be greater than zero");
    }

    let detail: any;
    let updateFn: (data: any) => Promise<any>;

    switch (componentType) {
      case "hotel": {
        const model = this.prisma.dvi_accounts_itinerary_hotel_details;
        detail = await model.findUnique({
          where: {
            accounts_itinerary_hotel_details_ID: componentDetailId,
          },
        });
        updateFn = (data) =>
          model.update({
            where: {
              accounts_itinerary_hotel_details_ID: componentDetailId,
            },
            data,
          });
        break;
      }
      case "vehicle": {
        const model = this.prisma.dvi_accounts_itinerary_vehicle_details;
        detail = await model.findUnique({
          where: {
            accounts_itinerary_vehicle_details_ID: componentDetailId,
          },
        });
        updateFn = (data) =>
          model.update({
            where: {
              accounts_itinerary_vehicle_details_ID: componentDetailId,
            },
            data,
          });
        break;
      }
      case "guide": {
        const model = this.prisma.dvi_accounts_itinerary_guide_details;
        detail = await model.findUnique({
          where: {
            accounts_itinerary_guide_details_ID: componentDetailId,
          },
        });
        updateFn = (data) =>
          model.update({
            where: {
              accounts_itinerary_guide_details_ID: componentDetailId,
            },
            data,
          });
        break;
      }
      case "hotspot": {
        const model = this.prisma.dvi_accounts_itinerary_hotspot_details;
        detail = await model.findUnique({
          where: {
            accounts_itinerary_hotspot_details_ID: componentDetailId,
          },
        });
        updateFn = (data) =>
          model.update({
            where: {
              accounts_itinerary_hotspot_details_ID: componentDetailId,
            },
            data,
          });
        break;
      }
      case "activity": {
        const model = this.prisma.dvi_accounts_itinerary_activity_details;
        detail = await model.findUnique({
          where: {
            accounts_itinerary_activity_details_ID: componentDetailId,
          },
        });
        updateFn = (data) =>
          model.update({
            where: {
              accounts_itinerary_activity_details_ID: componentDetailId,
            },
            data,
          });
        break;
      }
      default:
        throw new BadRequestException(
          `Unsupported componentType: ${componentType}`,
        );
    }

    if (!detail || detail.deleted === 1) {
      throw new BadRequestException("Component row not found or deleted");
    }

 // Use the header ID from detail row to avoid strict mismatch errors
    const headerId = Number(detail.accounts_itinerary_details_ID);

    const currentPaid = Number(detail.total_paid ?? 0);
    const currentBalance = Number(detail.total_balance ?? 0);

    if (amount > currentBalance) {
      throw new BadRequestException(
        "Amount cannot be greater than current balance",
      );
    }

    const newPaid = currentPaid + amount;
    const newBalance = currentBalance - amount;

 // 1 Update running totals on the *_details row
    await updateFn({
      total_paid: newPaid,
      total_balance: newBalance,
    });

 // 2 Insert into the appropriate *_transaction_history table
    await this.createTransactionHistory(body, amount, headerId);
  }

 /**
   * Inserts a row into the legacy transaction history tables:
   * - dvi_accounts_itinerary_hotel_transaction_history
   * - dvi_accounts_itinerary_vehicle_transaction_history
   * - dvi_accounts_itinerary_hotspot_transaction_history
   * - dvi_accounts_itinerary_activity_transaction_history
   * - dvi_accounts_itinerary_guide_transaction_history
 */
  private async createTransactionHistory(
    body: AccountsManagerPayDto,
    amount: number,
    headerId: number,
  ): Promise<void> {
    const {
      componentType,
      componentDetailId,
      modeOfPaymentId,
      utrNumber,
      processedBy,
      routeDate,
      paymentScreenshotPath,
    } = body;

    const transactionDate =
      routeDate ? parseDDMMYYYY(routeDate) ?? new Date() : new Date();

 // `any` avoids Prisma union type mismatch between different *_transaction_history tables
    const common: any = {
      accounts_itinerary_details_ID: headerId,
      transaction_amount: amount,
      transaction_date: transactionDate,
      transaction_done_by: processedBy ?? null,
 mode_of_pay: modeOfPaymentId null, // 1: Cash, 2: UPI, 3: Net Banking
      transaction_utr_no: utrNumber ?? null,
      transaction_attachment: paymentScreenshotPath ?? "",
      deleted: 0,
    };

    switch (componentType) {
      case "hotel":
        await this.prisma.dvi_accounts_itinerary_hotel_transaction_history.create(
          {
            data: {
              ...common,
              accounts_itinerary_hotel_details_ID: componentDetailId,
            } as any,
          },
        );
        break;

      case "vehicle":
        await this.prisma.dvi_accounts_itinerary_vehicle_transaction_history.create(
          {
            data: {
              ...common,
              accounts_itinerary_vehicle_details_ID: componentDetailId,
            } as any,
          },
        );
        break;

      case "hotspot":
        await this.prisma.dvi_accounts_itinerary_hotspot_transaction_history.create(
          {
            data: {
              ...common,
              accounts_itinerary_hotspot_details_ID: componentDetailId,
            } as any,
          },
        );
        break;

      case "activity":
        await this.prisma.dvi_accounts_itinerary_activity_transaction_history.create(
          {
            data: {
              ...common,
              accounts_itinerary_activity_details_ID: componentDetailId,
            } as any,
          },
        );
        break;

      case "guide":
        await this.prisma.dvi_accounts_itinerary_guide_transaction_history.create(
          {
            data: {
              ...common,
              accounts_itinerary_guide_details_ID: componentDetailId,
            } as any,
          },
        );
        break;

      default:
        throw new BadRequestException(
          `Unsupported componentType for history: ${componentType}`,
        );
    }
  }
}

// Helpers (pure functions)

function parseDDMMYYYY(
  value?: string,
  endOfDay = false,
): Date | undefined {
  if (!value) return undefined;
  const parts = value.split("/");
  if (parts.length !== 3) return undefined;
  const [dd, mm, yyyy] = parts;
  const d = parseInt(dd, 10);
  const m = parseInt(mm, 10);
  const y = parseInt(yyyy, 10);
  if (!d || !m || !y) return undefined;

  if (endOfDay) {
    return new Date(y, m - 1, d, 23, 59, 59, 999);
  }
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

function formatToDDMMYYYY(
  date?: Date | string | null,
): string {
  if (!date) return "";
  const dObj = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(dObj.getTime())) return "";
  const dd = `${dObj.getDate()}`.padStart(2, "0");
  const mm = `${dObj.getMonth() + 1}`.padStart(2, "0");
  const yyyy = dObj.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

// for sorting: DD/MM/YYYY -> YYYYMMDD
function toComparable(ddmmyyyy?: string): string {
  if (!ddmmyyyy) return "";
  const [d, m, y] = ddmmyyyy.split("/");
  return `${y || "0000"}${m || "00"}${d || "00"}`;
}
