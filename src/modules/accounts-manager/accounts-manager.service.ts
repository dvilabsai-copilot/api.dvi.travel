// FILE: src/modules/accounts-manager/accounts-manager.service.ts

import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";

import { Response } from "express";
import PDFDocument from "pdfkit";

import { PrismaService } from "../../prisma.service";
import { AccountsComponentSyncService } from "./accounts-component-sync.service";
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
  constructor(
  private readonly prisma: PrismaService,
  private readonly accountsComponentSync:
    AccountsComponentSyncService,
) {}


/**
 * Resolve the Accounts Overview search against the
 * real confirmed-itinerary sources BEFORE reading
 * flattened Accounts rows.
 *
 * Supported:
 * - confirmed Booking ID
 * - original Quote ID
 * - Agent
 * - Vehicle Vendor
 * - Vendor Code
 * - Vendor Branch
 * - Hotel / Supplier
 */
private async ensureConfirmedAccountsForSearch(
  query: AccountsManagerQueryDto,
): Promise<void> {
  /*
   * Existing explicit quoteId filters remain
   * exact-quote repair requests.
   */
  const explicitQuote =
    String(
      query.quoteId || "",
    ).trim();

  if (explicitQuote) {
    await this.accountsComponentSync
      .ensureConfirmedQuote(
        explicitQuote,
      );

    return;
  }


  const search =
    String(
      query.search || "",
    ).trim();

  if (!search) {
    return;
  }


  /*
   * ============================================================
   * ACCESS SCOPE
   * ============================================================
   *
   * Agent login:
   *   only that Agent's itineraries.
   *
   * Travel Expert / Staff:
   *   only Agents assigned to that Travel Expert.
   *
   * Admin / Accounts:
   *   no Agent restriction here.
   */
  let allowedAgentIds:
    number[] | null = null;


  if (query.agentId) {
    const agentId =
      Number(
        query.agentId,
      );

    allowedAgentIds =
      agentId > 0
        ? [agentId]
        : [];
  } else if (
    Number(
      (query as any)
        .travelExpertId || 0,
    ) > 0
  ) {
    const travelExpertId =
      Number(
        (query as any)
          .travelExpertId,
      );

    const allowedAgents =
      await this.prisma
        .dvi_agent
        .findMany({
          where: {
            travel_expert_id:
              travelExpertId,

            deleted: 0,
          },

          select: {
            agent_ID: true,
          },
        });

    allowedAgentIds =
      allowedAgents
        .map((row) =>
          Number(
            row.agent_ID,
          ),
        )
        .filter(
          (id) => id > 0,
        );
  }


  if (
    allowedAgentIds &&
    allowedAgentIds.length === 0
  ) {
    return;
  }


  /*
   * ============================================================
   * 1. AGENT SEARCH
   * ============================================================
   */
  const agentWhere: any = {
    deleted: 0,

    OR: [
      {
        agent_name: {
          contains: search,
        },
      },

      {
        agent_lastname: {
          contains: search,
        },
      },
    ],
  };


  if (allowedAgentIds) {
    agentWhere.agent_ID = {
      in: allowedAgentIds,
    };
  }


  /*
   * ============================================================
   * 2. VENDOR SEARCH
   * ============================================================
   *
   * Vendor master gives us:
   * - vendor name
   * - vendor code
   *
   * Branch table gives us:
   * - branch name
   * - branch location
   */
  const [
    matchingAgents,
    matchingVendors,
    matchingVendorBranches,
    matchingHotels,
    matchingOriginalQuotes,
  ] =
    await Promise.all([
      this.prisma
        .dvi_agent
        .findMany({
          where: agentWhere,

          select: {
            agent_ID: true,
          },
        }),

      this.prisma
        .dvi_vendor_details
        .findMany({
          where: {
            deleted: 0,

            OR: [
              {
                vendor_name: {
                  contains: search,
                },
              },

              {
                vendor_code: {
                  contains: search,
                },
              },
            ],
          },

          select: {
            vendor_id: true,
          },
        }),

      this.prisma
        .dvi_vendor_branches
        .findMany({
          where: {
            deleted: 0,

            OR: [
              {
                vendor_branch_name: {
                  contains: search,
                },
              },

              {
                vendor_branch_location: {
                  contains: search,
                },
              },
            ],
          },

          select: {
            vendor_branch_id: true,
            vendor_id: true,
          },
        }),

      /*
       * Hotel rows are also Suppliers in
       * Service Components.
       */
      this.prisma
  .dvi_hotel
  .findMany({
    where: {
      deleted: false,

      hotel_name: {
        contains: search,
      },
    },

    select: {
      hotel_id: true,
    },
  }),

      /*
       * Original Quote ID.
       *
       * The confirmed listing can conceptually have
       * both the original Quote ID and confirmed
       * Booking ID, so preserve both search paths.
       */
      this.prisma
        .dvi_itinerary_plan_details
        .findMany({
          where: {
            deleted: 0,

            itinerary_quote_ID: {
              contains: search,
            },

            ...(allowedAgentIds
              ? {
                  agent_id: {
                    in:
                      allowedAgentIds,
                  },
                }
              : {}),
          },

          select: {
            itinerary_plan_ID:
              true,
          },
        }),
    ]);


  const matchingAgentIds =
    matchingAgents
      .map((row) =>
        Number(
          row.agent_ID,
        ),
      )
      .filter(
        (id) => id > 0,
      );


  const vendorIds =
    new Set<number>();


  for (
    const vendor
    of matchingVendors
  ) {
    const id =
      Number(
        vendor.vendor_id,
      );

    if (id > 0) {
      vendorIds.add(id);
    }
  }


  for (
    const branch
    of matchingVendorBranches
  ) {
    const id =
      Number(
        branch.vendor_id,
      );

    if (id > 0) {
      vendorIds.add(id);
    }
  }


  const vendorBranchIds =
    matchingVendorBranches
      .map((row) =>
        Number(
          row.vendor_branch_id,
        ),
      )
      .filter(
        (id) => id > 0,
      );


  const hotelIds =
    matchingHotels
      .map((row) =>
        Number(
          row.hotel_id,
        ),
      )
      .filter(
        (id) => id > 0,
      );


  /*
   * ============================================================
   * 3. FIND CONFIRMED ITINERARIES USING THOSE VENDORS
   * ============================================================
   */
  const [
    vehicleVendorRows,
    hotelSupplierRows,
  ] =
    await Promise.all([
      (
        vendorIds.size ||
        vendorBranchIds.length
      )
        ? this.prisma
            .dvi_confirmed_itinerary_plan_vendor_eligible_list
            .findMany({
              where: {
                deleted: 0,
                status: 1,

                itineary_plan_assigned_status:
                  1,

                OR: [
                  ...(vendorIds.size
                    ? [
                        {
                          vendor_id: {
                            in: Array.from(
                              vendorIds,
                            ),
                          },
                        },
                      ]
                    : []),

                  ...(vendorBranchIds.length
                    ? [
                        {
                          vendor_branch_id:
                            {
                              in:
                                vendorBranchIds,
                            },
                        },
                      ]
                    : []),
                ],
              },

              select: {
                itinerary_plan_id:
                  true,
              },
            })
        : Promise.resolve([]),

      hotelIds.length
        ? this.prisma
            .dvi_confirmed_itinerary_plan_hotel_details
            .findMany({
              where: {
                deleted: 0,
                status: 1,

                hotel_id: {
                  in: hotelIds,
                },
              },

              select: {
                itinerary_plan_id:
                  true,
              },
            })
        : Promise.resolve([]),
    ]);


  /*
   * All plan IDs discovered from:
   *
   * - original Quote ID
   * - Vendor
   * - Vendor branch
   * - Hotel supplier
   */
  const matchingPlanIds =
    new Set<number>();


  for (
    const row
    of matchingOriginalQuotes
  ) {
    const id =
      Number(
        row.itinerary_plan_ID,
      );

    if (id > 0) {
      matchingPlanIds.add(id);
    }
  }


  for (
    const row
    of vehicleVendorRows
  ) {
    const id =
      Number(
        row.itinerary_plan_id,
      );

    if (id > 0) {
      matchingPlanIds.add(id);
    }
  }


  for (
    const row
    of hotelSupplierRows
  ) {
    const id =
      Number(
        row.itinerary_plan_id,
      );

    if (id > 0) {
      matchingPlanIds.add(id);
    }
  }


  /*
   * ============================================================
   * 4. FIND THE ACTUAL CONFIRMED BOOKINGS
   * ============================================================
   *
   * This covers:
   *
   * A) confirmed Booking ID
   * B) Agent
   * C) original Quote ID
   * D) Vendor
   */
  const searchOr: any[] = [
    /*
     * Confirmed Booking ID / confirmed quote.
     */
    {
      itinerary_quote_ID: {
        contains: search,
      },
    },
  ];


  if (
    matchingAgentIds.length
  ) {
    searchOr.push({
      agent_id: {
        in:
          matchingAgentIds,
      },
    });
  }


  if (
    matchingPlanIds.size
  ) {
    searchOr.push({
      itinerary_plan_ID: {
        in:
          Array.from(
            matchingPlanIds,
          ),
      },
    });
  }


  const confirmedWhere: any = {
    deleted: 0,
    status: 1,

    OR: searchOr,
  };


  /*
   * Preserve role/access restrictions even
   * while doing Vendor/Quote discovery.
   */
  if (allowedAgentIds) {
    confirmedWhere.agent_id = {
      in:
        allowedAgentIds,
    };
  }


  const matchingConfirmedPlans =
    await this.prisma
      .dvi_confirmed_itinerary_plan_details
      .findMany({
        where:
          confirmedWhere,

        select: {
          itinerary_quote_ID:
            true,
        },
      });


  const confirmedQuoteIds =
    Array.from(
      new Set(
        matchingConfirmedPlans
          .map((row) =>
            String(
              row
                .itinerary_quote_ID ||
              "",
            ).trim(),
          )
          .filter(Boolean),
      ),
    );


  /*
   * Sync in small batches.
   *
   * Do not fire hundreds of DB repair
   * transactions simultaneously.
   */
  const BATCH_SIZE = 10;


  for (
    let index = 0;
    index < confirmedQuoteIds.length;
    index += BATCH_SIZE
  ) {
    const batch =
      confirmedQuoteIds.slice(
        index,
        index + BATCH_SIZE,
      );

    await Promise.all(
      batch.map(
        (quoteId) =>
          this.accountsComponentSync
            .ensureConfirmedQuote(
              quoteId,
            ),
      ),
    );
  }
}


// MAIN LIST
async list(
  query: AccountsManagerQueryDto,
): Promise<AccountsManagerRowDto[]> {
  /*
   * Before reading Accounts rows, make sure all
   * CONFIRMED itineraries matching the current
   * Quote / Agent / Vendor search have Accounts
   * records.
   */
  await this.ensureConfirmedAccountsForSearch(
    query,
  );

  const status:
    AccountsManagerStatus =
    query.status || "all";
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

  total_billed_amount: true,
  total_received_amount: true,
  total_receivable_amount: true,
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

  /*
   * Original quote ID.
   */
  itinerary_quote_ID: true,

  arrival_location: true,
  departure_location: true,
  total_adult: true,
  total_children: true,
  total_infants: true,
},
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
        agent_ID: {
          in: agentIds,
        },
      },

      select: {
        agent_ID: true,
        agent_name: true,
        agent_lastname: true,
      },
    })
  : [];

const agentMap =
  new Map<number, string>();

for (const a of agents) {
  const agentName =
    [
      a.agent_name,
      a.agent_lastname,
    ]
      .map((value) =>
        String(
          value || "",
        ).trim(),
      )
      .filter(Boolean)
      .join(" ");

  agentMap.set(
    a.agent_ID,
    agentName,
  );
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

  /*
   * Optional additional values that should
   * participate in the general search.
   *
   * Vehicle uses this for:
   * - Vendor Code
   * - Vehicle Type
   * - Registration Number
   * - Vendor Branch
   */
  searchAliases: string[] = [],
): AccountsManagerRowDto | null => {
      if (!shouldIncludeByStatus(balance)) return null;

      const header = headersById.get(detailHeaderId);
      if (!header) return null;

     const plan =
  planMap.get(
    header.itinerary_plan_ID,
  );

/*
 * Accounts / confirmed booking ID.
 */
const quoteId =
  String(
    header.itinerary_quote_ID ||
    "",
  ).trim();

/*
 * Original itinerary Quote ID.
 */
const originalQuoteId =
  String(
    plan?.itinerary_quote_ID ||
    "",
  ).trim();

const agentName =
  agentMap.get(
    header.agent_id,
  ) || "";

// Free search:
// Quote / Booking
// Vendor / Supplier
// Agent
// + component-specific aliases
if (query.search?.trim()) {
  const s =
    query.search
      .trim()
      .toLowerCase();

 const searchableValues = [
  /*
   * Confirmed Booking ID
   */
  quoteId,

  /*
   * Original Quote ID
   */
  originalQuoteId,

  /*
   * Agent
   */
  agentName,

  /*
   * Component supplier.
   *
   * Hotel = hotel name
   * Vehicle = resolved vendor
   * Guide etc = component name
   */
  vendorName,

  /*
   * Vehicle-specific aliases:
   * vendor code,
   * vehicle type,
   * registration,
   * vendor branch.
   */
  ...searchAliases,
]
  .filter(Boolean)
  .join(" ")
  .toLowerCase();

  if (
    !searchableValues.includes(
      s,
    )
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
       arrivalLocation:
  plan?.arrival_location || "",

departureLocation:
  plan?.departure_location || "",

guestName:
  plan
    ? `Adult: ${plan.total_adult}, Child: ${plan.total_children}`
    : "",

headerTotalBilled:
  Number(
    header.total_billed_amount || 0,
  ),

headerTotalReceived:
  Number(
    header.total_received_amount || 0,
  ),

headerTotalReceivable:
  Number(
    header.total_receivable_amount || 0,
  ),

headerTotalPayout:
  Number(
    header.total_payout_amount || 0,
  ),

inhandAmount:
  (header.total_received_amount || 0) -
  (header.total_payout_amount || 0),
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
if (
  componentType === "all" ||
  componentType === "vehicle"
) {
  const vehicleDetails =
    await this.prisma
      .dvi_accounts_itinerary_vehicle_details
      .findMany({
        where: {
          deleted: 0,

          accounts_itinerary_details_ID: {
            in: filteredHeaderIds,
          },
        },

        select: {
          accounts_itinerary_vehicle_details_ID: true,
          accounts_itinerary_details_ID: true,

          vehicle_id: true,
          vehicle_type_id: true,
          vendor_id: true,
          vendor_branch_id: true,

          total_payable: true,
          total_paid: true,
          total_balance: true,

          vehicle_grand_total: true,
          total_purchase: true,
        },
      });

  /*
   * Load the actual physical vehicles.
   */
  const vehicleIds =
    Array.from(
      new Set(
        vehicleDetails
          .map((row) =>
            Number(
              row.vehicle_id || 0,
            ),
          )
          .filter(
            (id) => id > 0,
          ),
      ),
    );

  const vehicles =
    vehicleIds.length
      ? await this.prisma.dvi_vehicle.findMany({
          where: {
            vehicle_id: {
              in: vehicleIds,
            },
          },

          select: {
            vehicle_id: true,

            registration_number: true,
            owner_name: true,

            vehicle_type_id: true,
            vendor_id: true,
            vendor_branch_id: true,
          },
        })
      : [];

  const vehicleMap =
    new Map<
      number,
      {
        registrationNumber: string;
        ownerName: string;
        vehicleTypeId: number;
        vendorId: number;
        vendorBranchId: number;
      }
    >();

  for (const vehicle of vehicles) {
    vehicleMap.set(
      vehicle.vehicle_id,
      {
        registrationNumber:
          String(
            vehicle.registration_number || "",
          ).trim(),

        ownerName:
          String(
            vehicle.owner_name || "",
          ).trim(),

        vehicleTypeId:
          Number(
            vehicle.vehicle_type_id || 0,
          ),

        vendorId:
          Number(
            vehicle.vendor_id || 0,
          ),

        vendorBranchId:
          Number(
            vehicle.vendor_branch_id || 0,
          ),
      },
    );
  }

  /*
   * Use IDs saved on Accounts first.
   * The physical vehicle is only a fallback.
   */
  const vendorIds =
    Array.from(
      new Set(
        vehicleDetails
          .map((row) => {
            const vehicle =
              vehicleMap.get(
                Number(
                  row.vehicle_id || 0,
                ),
              );

            return Number(
              row.vendor_id ||
                vehicle?.vendorId ||
                0,
            );
          })
          .filter(
            (id) => id > 0,
          ),
      ),
    );

  const vehicleTypeIds =
    Array.from(
      new Set(
        vehicleDetails
          .map((row) => {
            const vehicle =
              vehicleMap.get(
                Number(
                  row.vehicle_id || 0,
                ),
              );

            return Number(
              row.vehicle_type_id ||
                vehicle?.vehicleTypeId ||
                0,
            );
          })
          .filter(
            (id) => id > 0,
          ),
      ),
    );

  const vendorBranchIds =
    Array.from(
      new Set(
        vehicleDetails
          .map((row) => {
            const vehicle =
              vehicleMap.get(
                Number(
                  row.vehicle_id || 0,
                ),
              );

            return Number(
              row.vendor_branch_id ||
                vehicle?.vendorBranchId ||
                0,
            );
          })
          .filter(
            (id) => id > 0,
          ),
      ),
    );

  const [
    vendors,
    vehicleTypes,
    vendorBranches,
  ] =
    await Promise.all([
      vendorIds.length
        ? this.prisma.dvi_vendor_details.findMany({
            where: {
              vendor_id: {
                in: vendorIds,
              },
            },

           select: {
  vendor_id: true,
  vendor_name: true,
  vendor_code: true,
},
          })
        : [],

      vehicleTypeIds.length
        ? this.prisma.dvi_vehicle_type.findMany({
            where: {
              vehicle_type_id: {
                in: vehicleTypeIds,
              },
            },

            select: {
              vehicle_type_id: true,
              vehicle_type_title: true,
            },
          })
        : [],

      vendorBranchIds.length
        ? this.prisma.dvi_vendor_branches.findMany({
            where: {
              vendor_branch_id: {
                in: vendorBranchIds,
              },
            },

            select: {
              vendor_branch_id: true,
              vendor_branch_name: true,
            },
          })
        : [],
    ]);

 const vendorMap =
  new Map<
    number,
    {
      name: string;
      code: string;
    }
  >();

for (const vendor of vendors) {
  vendorMap.set(
    vendor.vendor_id,
    {
      name:
        String(
          vendor.vendor_name || "",
        ).trim(),

      code:
        String(
          vendor.vendor_code || "",
        ).trim(),
    },
  );
}

  const vehicleTypeMap =
    new Map<number, string>();

  for (const vehicleType of vehicleTypes) {
    vehicleTypeMap.set(
      vehicleType.vehicle_type_id,
      String(
        vehicleType.vehicle_type_title || "",
      ).trim(),
    );
  }

  const vendorBranchMap =
    new Map<number, string>();

  for (const branch of vendorBranches) {
    vendorBranchMap.set(
      branch.vendor_branch_id,
      String(
        branch.vendor_branch_name || "",
      ).trim(),
    );
  }

  for (const vd of vehicleDetails) {
    const vehicleId =
      Number(
        vd.vehicle_id || 0,
      );

    const vehicle =
      vehicleMap.get(
        vehicleId,
      );

    const vendorId =
      Number(
        vd.vendor_id ||
          vehicle?.vendorId ||
          0,
      );

    const vehicleTypeId =
      Number(
        vd.vehicle_type_id ||
          vehicle?.vehicleTypeId ||
          0,
      );

    const vendorBranchId =
      Number(
        vd.vendor_branch_id ||
          vehicle?.vendorBranchId ||
          0,
      );

  const vendor =
  vendorMap.get(
    vendorId,
  );

const vendorName =
  vendor?.name ||
  vehicle?.ownerName ||
  "Vehicle Vendor";

const vendorCode =
  vendor?.code || "";

const vehicleTypeName =
  vehicleTypeMap.get(
    vehicleTypeId,
  ) || "Vehicle";

    const vehicleName =
      vehicle?.registrationNumber ||
      vehicle?.ownerName ||
      (
        vehicleId > 0
          ? `Vehicle #${vehicleId}`
          : "Vehicle"
      );

    const vendorBranchName =
      vendorBranchMap.get(
        vendorBranchId,
      ) || "";

 const base =
  buildBaseRow(
    vd.accounts_itinerary_details_ID,
    vendorName,
    vd.total_payable,
    vd.total_paid,
    vd.total_balance,
    "vehicle",

    [
      vendorCode,
      vehicleTypeName,
      vehicleName,
      vendorBranchName,
    ],
  );

    if (!base) {
      continue;
    }

    base.id =
      vd.accounts_itinerary_vehicle_details_ID;

    base.vehicleId =
      vehicleId || undefined;

    base.vehicleTypeId =
      vehicleTypeId || undefined;

    /*
     * IMPORTANT:
     * vendorId is now the REAL vendor_id,
     * not the vehicle_id.
     */
    base.vendorId =
      vendorId || undefined;

    base.vendorBranchId =
      vendorBranchId || undefined;

    base.vendorName =
      vendorName;

    base.vehicleTypeName =
      vehicleTypeName;

    base.vehicleName =
      vehicleName;

    base.vendorBranchName =
      vendorBranchName;

    base.receivableFromAgentAmount =
      Number(
        vd.vehicle_grand_total || 0,
      );

    base.marginAmount =
      Number(
        vd.vehicle_grand_total || 0,
      ) -
      Number(
        vd.total_purchase || 0,
      );

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

  if (
    query.quoteId?.trim()
  ) {
    await this.accountsComponentSync
      .ensureConfirmedQuote(
        query.quoteId.trim(),
      );
  }

  /*
   * For general Overview search, reuse the already
   * filtered Accounts rows.
   *
   * This guarantees Vendor / Agent / Quote search
   * uses exactly the same rows in both the table
   * and the summary cards.
   */
  if (query.search?.trim()) {
    const filteredRows =
      await this.list(query);

    return {
      totalPayable:
        filteredRows.reduce(
          (total, row) =>
            total +
            Number(
              row.amount || 0,
            ),
          0,
        ),

      totalPaid:
        filteredRows.reduce(
          (total, row) =>
            total +
            Number(
              row.payout || 0,
            ),
          0,
        ),

      totalBalance:
        filteredRows.reduce(
          (total, row) =>
            total +
            Number(
              row.payable || 0,
            ),
          0,
        ),

      rowCount:
        filteredRows.length,
    };
  }

  const {
    headerIds,
    status,
    componentType,
  } =
    await this.getFilteredHeaderIds(
      query,
    );

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
 * Download a complete internal Purchase Cost PDF
 * for one confirmed itinerary / Accounts header.
 *
 * The PDF uses the SAME component calculations
 * as Accounts Overview:
 *
 * Selling  = receivableFromAgentAmount ?? amount
 * Purchase = payout + payable
 * Profit   = Selling - Purchase
 */
async downloadPurchaseCostPdf(
  headerId: number,
  res: Response,
  scope: AccountsManagerQueryDto,
): Promise<void> {
  /*
   * ============================================================
   * 1. RESOLVE ACCOUNTS HEADER
   * ============================================================
   */

  const header =
    await this.prisma
      .dvi_accounts_itinerary_details
      .findFirst({
        where: {
          accounts_itinerary_details_ID:
            headerId,

          deleted: 0,
        },

        select: {
          accounts_itinerary_details_ID:
            true,

          itinerary_plan_ID:
            true,

          itinerary_quote_ID:
            true,

          agent_id:
            true,

          trip_start_date_and_time:
            true,

          trip_end_date_and_time:
            true,

          total_billed_amount:
            true,

          total_received_amount:
            true,

          total_receivable_amount:
            true,

          total_payout_amount:
            true,
        },
      });


  if (!header) {
    throw new NotFoundException(
      "Accounts booking not found.",
    );
  }


  const planId =
    Number(
      header.itinerary_plan_ID ||
        0,
    );


  if (!planId) {
    throw new NotFoundException(
      "Itinerary plan is not available for this Accounts booking.",
    );
  }


  /*
   * ============================================================
   * 2. CONFIRM THAT THIS IS A CONFIRMED ITINERARY
   * ============================================================
   */

  const confirmedPlan =
    await this.prisma
      .dvi_confirmed_itinerary_plan_details
      .findFirst({
        where: {
          itinerary_plan_ID:
            planId,

          status: 1,
          deleted: 0,
        },

        select: {
          itinerary_plan_ID:
            true,

          itinerary_quote_ID:
            true,
        },
      });


  if (!confirmedPlan) {
    throw new NotFoundException(
      "Purchase Cost PDF is available only for a confirmed itinerary.",
    );
  }


  const quoteId =
    String(
      header.itinerary_quote_ID ||
        confirmedPlan.itinerary_quote_ID ||
        "",
    ).trim();


  /*
   * Repair Accounts components first if this
   * confirmed booking is an older booking.
   */
  if (quoteId) {
    await this.accountsComponentSync
      .ensureConfirmedQuote(
        quoteId,
      );
  }


  /*
   * ============================================================
   * 3. LOAD COMPONENTS THROUGH EXISTING ACCOUNTS LOGIC
   * ============================================================
   *
   * This is important:
   * do NOT create a second cost formula for the PDF.
   */

  const scopedRows =
    await this.list({
      ...scope,

      quoteId:
        quoteId ||
        undefined,

      search:
        undefined,

      status:
        "all",

      componentType:
        "all",
    });


  /*
   * quoteId can theoretically have more than one
   * Accounts header, so use the exact header ID.
   */
  const componentRows =
    scopedRows.filter(
      (row) =>
        Number(
          row.headerId,
        ) === headerId,
    );


  /*
   * This also protects Agent / Travel Expert access:
   * their normal Accounts scope is applied above.
   */
  if (
    componentRows.length === 0
  ) {
    throw new NotFoundException(
      "Purchase Cost data is not available for this booking.",
    );
  }


  /*
   * ============================================================
   * 4. CONFIRMED ITINERARY INFORMATION
   * ============================================================
   */

  const [
    plan,
    agent,
    customer,
  ] =
    await Promise.all([
      this.prisma
        .dvi_itinerary_plan_details
        .findUnique({
          where: {
            itinerary_plan_ID:
              planId,
          },

          select: {
            itinerary_plan_ID:
              true,

            itinerary_quote_ID:
              true,

            arrival_location:
              true,

            departure_location:
              true,

            total_adult:
              true,

            total_children:
              true,

            total_infants:
              true,

            trip_start_date_and_time:
              true,

            trip_end_date_and_time:
              true,
          },
        }),

      Number(
        header.agent_id ||
          0,
      ) > 0
        ? this.prisma
            .dvi_agent
            .findUnique({
              where: {
                agent_ID:
                  Number(
                    header.agent_id,
                  ),
              },

              select: {
                agent_name:
                  true,

                agent_lastname:
                  true,
              },
            })
        : Promise.resolve(
            null,
          ),

      this.prisma
        .dvi_confirmed_itinerary_customer_details
        .findFirst({
          where: {
            itinerary_plan_ID:
              planId,

            primary_customer:
              1,

            status:
              1,

            deleted:
              0,
          },

          select: {
            customer_salutation:
              true,

            customer_name:
              true,

            primary_contact_no:
              true,
          },
        }),
    ]);


  /*
   * ============================================================
   * 5. SAME COST CALCULATIONS AS ACCOUNTS OVERVIEW
   * ============================================================
   */

  const toSafeNumber = (
    value: unknown,
  ) => {
    const parsed =
      Number(
        value ?? 0,
      );

    return Number.isFinite(
      parsed,
    )
      ? parsed
      : 0;
  };


  const componentSellingAmount = (
    row: AccountsManagerRowDto,
  ) =>
    toSafeNumber(
      row.receivableFromAgentAmount ??
        row.amount,
    );


  const componentPurchaseAmount = (
    row: AccountsManagerRowDto,
  ) =>
    toSafeNumber(
      row.payout,
    ) +
    toSafeNumber(
      row.payable,
    );


  const sellingFromRows =
    componentRows.reduce(
      (total, row) =>
        total +
        componentSellingAmount(
          row,
        ),
      0,
    );


  const totalSelling =
    toSafeNumber(
      header
        .total_billed_amount,
    ) ||
    sellingFromRows;


  const totalPurchase =
    componentRows.reduce(
      (total, row) =>
        total +
        componentPurchaseAmount(
          row,
        ),
      0,
    );


  const grossProfit =
    totalSelling -
    totalPurchase;


  const totalReceived =
    toSafeNumber(
      header
        .total_received_amount,
    );


  const pendingFromAgent =
    toSafeNumber(
      header
        .total_receivable_amount,
    );


  const vendorPayments =
    toSafeNumber(
      header
        .total_payout_amount,
    );


  const formatMoney = (
    value: unknown,
  ) =>
    `INR ${toSafeNumber(
      value,
    ).toLocaleString(
      "en-IN",
      {
        minimumFractionDigits:
          2,

        maximumFractionDigits:
          2,
      },
    )}`;


  const agentName =
    [
      agent?.agent_name,
      agent?.agent_lastname,
    ]
      .map((value) =>
        String(
          value || "",
        ).trim(),
      )
      .filter(Boolean)
      .join(" ") ||
    "-";


  const guestName =
    [
      customer
        ?.customer_salutation,

      customer
        ?.customer_name,
    ]
      .map((value) =>
        String(
          value || "",
        ).trim(),
      )
      .filter(Boolean)
      .join(" ") ||
    "-";


  const travelStart =
    formatToDDMMYYYY(
      header
        .trip_start_date_and_time ||
        plan
          ?.trip_start_date_and_time,
    ) ||
    "-";


  const travelEnd =
    formatToDDMMYYYY(
      header
        .trip_end_date_and_time ||
        plan
          ?.trip_end_date_and_time,
    ) ||
    "-";


  const route =
    `${String(
      plan?.arrival_location ||
        "-",
    )} - ${String(
      plan?.departure_location ||
        "-",
    )}`;


  const passengers =
    `Adults: ${Number(
      plan?.total_adult ||
        0,
    )} | Children: ${Number(
      plan?.total_children ||
        0,
    )} | Infants: ${Number(
      plan?.total_infants ||
        0,
    )}`;


  /*
   * ============================================================
   * 6. PDF RESPONSE
   * ============================================================
   */

  const safeQuoteId =
    String(
      quoteId ||
        `booking-${headerId}`,
    )
      .replace(
        /[^a-zA-Z0-9_-]+/g,
        "-",
      )
      .replace(
        /-+/g,
        "-",
      );


  res.setHeader(
    "Content-Type",
    "application/pdf",
  );

  res.setHeader(
    "Content-Disposition",
    `attachment; filename="purchase-cost-${safeQuoteId}.pdf"`,
  );


  /*
   * Landscape is intentional because the
   * Service Components table has 10 columns.
   */
  const doc =
    new PDFDocument({
      size: "A4",
      layout:
        "landscape",

      margin:
        28,

      compress:
        true,
    });


  doc.pipe(
    res,
  );


  const left =
    28;

  const pageWidth =
    doc.page.width;

  const contentWidth =
    pageWidth -
    left * 2;


  /*
   * ============================================================
   * DOCUMENT HEADER
   * ============================================================
   */

  doc
    .roundedRect(
      left,
      28,
      contentWidth,
      72,
      10,
    )
    .fill(
      "#17233D",
    );


  doc
    .fillColor(
      "#FFFFFF",
    )
    .font(
      "Helvetica-Bold",
    )
    .fontSize(
      19,
    )
    .text(
      "PURCHASE COST & PACKAGE SUMMARY",
      left + 18,
      45,
    );


  doc
    .font(
      "Helvetica",
    )
    .fontSize(
      8,
    )
    .fillColor(
      "#DCE6F7",
    )
    .text(
      "Confirmed Itinerary - Internal Accounts & Finance Document",
      left + 18,
      72,
    );


  doc
    .font(
      "Helvetica-Bold",
    )
    .fontSize(
      12,
    )
    .fillColor(
      "#FFFFFF",
    )
    .text(
      quoteId ||
        "-",
      pageWidth - 245,
      49,
      {
        width:
          190,

        align:
          "right",
      },
    );


  let y =
    120;


  /*
   * ============================================================
   * CONFIRMED ITINERARY DETAILS
   * ============================================================
   */

  doc
    .font(
      "Helvetica-Bold",
    )
    .fontSize(
      12,
    )
    .fillColor(
      "#17233D",
    )
    .text(
      "Confirmed Itinerary Details",
      left,
      y,
    );


  y +=
    20;


  const infoItems = [
    [
      "Booking / Quote ID",
      quoteId || "-",
    ],

    [
      "Agent",
      agentName,
    ],

    [
      "Guest",
      guestName,
    ],

    [
      "Travel Date",
      `${travelStart} - ${travelEnd}`,
    ],

    [
      "Route",
      route,
    ],

    [
      "Passengers",
      passengers,
    ],
  ];


  const infoGap =
    8;

  const infoWidth =
    (
      contentWidth -
      infoGap * 2
    ) /
    3;


  infoItems.forEach(
    (
      [
        label,
        value,
      ],
      index,
    ) => {
      const rowIndex =
        Math.floor(
          index / 3,
        );

      const columnIndex =
        index % 3;

      const boxX =
        left +
        columnIndex *
          (
            infoWidth +
            infoGap
          );

      const boxY =
        y +
        rowIndex *
          45;


      doc
        .roundedRect(
          boxX,
          boxY,
          infoWidth,
          38,
          6,
        )
        .fillAndStroke(
          "#F8FAFD",
          "#DFE7F2",
        );


      doc
        .font(
          "Helvetica-Bold",
        )
        .fontSize(
          7,
        )
        .fillColor(
          "#71809A",
        )
        .text(
          String(
            label,
          ),
          boxX + 8,
          boxY + 7,
          {
            width:
              infoWidth -
              16,
          },
        );


      doc
        .font(
          "Helvetica",
        )
        .fontSize(
          8,
        )
        .fillColor(
          "#17233D",
        )
        .text(
          String(
            value ||
              "-",
          ),
          boxX + 8,
          boxY + 19,
          {
            width:
              infoWidth -
              16,

            ellipsis:
              true,
          },
        );
    },
  );


  y +=
    100;


  /*
   * ============================================================
   * PACKAGE FINANCIAL SUMMARY
   * ============================================================
   */

  doc
    .font(
      "Helvetica-Bold",
    )
    .fontSize(
      12,
    )
    .fillColor(
      "#17233D",
    )
    .text(
      "Package Financial Summary",
      left,
      y,
    );


  y +=
    20;


  const summaryItems = [
    [
      "Total Selling",
      totalSelling,
    ],

    [
      "Total Purchase",
      totalPurchase,
    ],

    [
      "Gross Profit",
      grossProfit,
    ],

    [
      "Received",
      totalReceived,
    ],

    [
      "Pending from Agent",
      pendingFromAgent,
    ],

    [
      "Vendor Payments",
      vendorPayments,
    ],
  ];


  const cardGap =
    6;

  const cardWidth =
    (
      contentWidth -
      cardGap * 5
    ) /
    6;


  summaryItems.forEach(
    (
      [
        label,
        value,
      ],
      index,
    ) => {
      const cardX =
        left +
        index *
          (
            cardWidth +
            cardGap
          );


      doc
        .roundedRect(
          cardX,
          y,
          cardWidth,
          52,
          7,
        )
        .fillAndStroke(
          "#F5F8FC",
          "#DFE7F2",
        );


      doc
        .font(
          "Helvetica",
        )
        .fontSize(
          7,
        )
        .fillColor(
          "#71809A",
        )
        .text(
          String(
            label,
          ),
          cardX + 7,
          y + 8,
          {
            width:
              cardWidth -
              14,
          },
        );


      doc
        .font(
          "Helvetica-Bold",
        )
        .fontSize(
          9,
        )
        .fillColor(
          "#17233D",
        )
        .text(
          formatMoney(
            value,
          ),
          cardX + 7,
          y + 26,
          {
            width:
              cardWidth -
              14,
          },
        );
    },
  );


  y +=
    72;


  /*
   * ============================================================
   * SERVICE COMPONENTS TABLE
   * ============================================================
   */

  doc
    .font(
      "Helvetica-Bold",
    )
    .fontSize(
      12,
    )
    .fillColor(
      "#17233D",
    )
    .text(
      `Service Components (${componentRows.length})`,
      left,
      y,
    );


  y +=
    19;


  const columns = [
    {
      label:
        "#",

      width:
        24,
    },

    {
      label:
        "Type",

      width:
        55,
    },

    {
      label:
        "Supplier / Vendor",

      width:
        118,
    },

    {
      label:
        "Details",

      width:
        130,
    },

    {
      label:
        "Travel Date",

      width:
        70,
    },

    {
      label:
        "Selling",

      width:
        76,
    },

    {
      label:
        "Purchase",

      width:
        76,
    },

    {
      label:
        "Profit",

      width:
        76,
    },

    {
      label:
        "Status",

      width:
        56,
    },

    {
      label:
        "Payment",

      width:
        80,
    },
  ];


  const tableWidth =
    columns.reduce(
      (
        total,
        column,
      ) =>
        total +
        column.width,
      0,
    );


  const drawTableHeader =
    () => {
      let x =
        left;


      doc
        .rect(
          left,
          y,
          tableWidth,
          25,
        )
        .fill(
          "#EEF3FB",
        );


      columns.forEach(
        (column) => {
          doc
            .font(
              "Helvetica-Bold",
            )
            .fontSize(
              7,
            )
            .fillColor(
              "#596985",
            )
            .text(
              column.label,
              x + 4,
              y + 8,
              {
                width:
                  column.width -
                  8,
              },
            );


          x +=
            column.width;
        },
      );


      y +=
        25;
    };


  const drawContinuationHeader =
    () => {
      doc
        .font(
          "Helvetica-Bold",
        )
        .fontSize(
          11,
        )
        .fillColor(
          "#17233D",
        )
        .text(
          "Purchase Cost & Package Summary",
          left,
          27,
        );


      doc
        .font(
          "Helvetica",
        )
        .fontSize(
          8,
        )
        .fillColor(
          "#71809A",
        )
        .text(
          quoteId ||
            "-",
          pageWidth - 230,
          28,
          {
            width:
              180,

            align:
              "right",
          },
        );
    };


  drawTableHeader();


  componentRows.forEach(
    (
      row,
      index,
    ) => {
      const selling =
        componentSellingAmount(
          row,
        );

      const purchase =
        componentPurchaseAmount(
          row,
        );

      const profit =
        selling -
        purchase;


      const supplier =
        String(
          row.componentType ===
            "vehicle"
            ? (
                row.vendorName ||
                row.hotelName ||
                "Vehicle Vendor"
              )
            : (
                row.hotelName ||
                row.componentType ||
                "-"
              ),
        );


      const vehicleDetails =
        [
          row.vehicleTypeName,
          row.vehicleName,
          row.vendorBranchName,
        ]
          .map((value) =>
            String(
              value ||
                "",
            ).trim(),
          )
          .filter(Boolean)
          .join(
            " / ",
          );


      const details =
        row.componentType ===
        "vehicle"
          ? (
              vehicleDetails ||
              "Vehicle"
            )
          : String(
              row.componentType ||
                "Component",
            );


      const statusText =
        row.status ===
        "paid"
          ? "Paid"
          : "Due";


      const paymentText =
        row.status ===
        "paid"
          ? "Paid"
          : `Due ${formatMoney(
              row.payable,
            )}`;


      const values = [
        String(
          index + 1,
        ),

        String(
          row.componentType ||
            "-",
        ),

        supplier,

        details,

        String(
          row.routeDate ||
            row.startDate ||
            "-",
        ),

        formatMoney(
          selling,
        ),

        formatMoney(
          purchase,
        ),

        formatMoney(
          profit,
        ),

        statusText,

        paymentText,
      ];


      /*
       * Calculate row height from the longest
       * text columns so data is not clipped.
       */
      doc
        .font(
          "Helvetica",
        )
        .fontSize(
          7,
        );


      const supplierHeight =
        doc.heightOfString(
          supplier,
          {
            width:
              columns[2]
                .width -
              8,
          },
        );


      const detailsHeight =
        doc.heightOfString(
          details,
          {
            width:
              columns[3]
                .width -
              8,
          },
        );


      const paymentHeight =
        doc.heightOfString(
          paymentText,
          {
            width:
              columns[9]
                .width -
              8,
          },
        );


      const rowHeight =
        Math.max(
          30,
          supplierHeight +
            14,
          detailsHeight +
            14,
          paymentHeight +
            14,
        );


      if (
        y +
          rowHeight >
        doc.page.height -
          42
      ) {
        doc.addPage();

        drawContinuationHeader();

        y =
          52;

        drawTableHeader();
      }


      if (
        index % 2 ===
        0
      ) {
        doc
          .rect(
            left,
            y,
            tableWidth,
            rowHeight,
          )
          .fill(
            "#FBFCFE",
          );
      }


      let x =
        left;


      values.forEach(
        (
          value,
          columnIndex,
        ) => {
          const column =
            columns[
              columnIndex
            ];


          const isAmount =
            columnIndex >=
              5 &&
            columnIndex <=
              7;


          doc
            .font(
              isAmount
                ? "Helvetica-Bold"
                : "Helvetica",
            )
            .fontSize(
              7,
            )
            .fillColor(
              columnIndex ===
                7
                ? (
                    profit >=
                    0
                      ? "#12945F"
                      : "#D14343"
                  )
                : "#17233D",
            )
            .text(
              value,
              x + 4,
              y + 8,
              {
                width:
                  column.width -
                  8,

                height:
                  rowHeight -
                  12,

                ellipsis:
                  true,
              },
            );


          x +=
            column.width;
        },
      );


      doc
        .moveTo(
          left,
          y +
            rowHeight,
        )
        .lineTo(
          left +
            tableWidth,
          y +
            rowHeight,
        )
        .lineWidth(
          0.5,
        )
        .strokeColor(
          "#E5EBF3",
        )
        .stroke();


      y +=
        rowHeight;
    },
  );


  /*
   * ============================================================
   * FINAL PACKAGE TOTAL
   * ============================================================
   */

  if (
    y + 78 >
    doc.page.height -
      35
  ) {
    doc.addPage();

    drawContinuationHeader();

    y =
      62;
  }


  y +=
    16;


  const totalBoxWidth =
    280;


  doc
    .roundedRect(
      pageWidth -
        left -
        totalBoxWidth,
      y,
      totalBoxWidth,
      58,
      8,
    )
    .fillAndStroke(
      "#F1F6FF",
      "#CFDDF1",
    );


  doc
    .font(
      "Helvetica-Bold",
    )
    .fontSize(
      8,
    )
    .fillColor(
      "#71809A",
    )
    .text(
      "TOTAL PACKAGE SELLING PRICE",
      pageWidth -
        left -
        totalBoxWidth +
        12,
      y + 10,
      {
        width:
          totalBoxWidth -
          24,
      },
    );


  doc
    .font(
      "Helvetica-Bold",
    )
    .fontSize(
      16,
    )
    .fillColor(
      "#17233D",
    )
    .text(
      formatMoney(
        totalSelling,
      ),
      pageWidth -
        left -
        totalBoxWidth +
        12,
      y + 28,
      {
        width:
          totalBoxWidth -
          24,

        align:
          "right",
      },
    );


  doc
    .font(
      "Helvetica",
    )
    .fontSize(
      7,
    )
    .fillColor(
      "#71809A",
    )
    .text(
      `Generated from confirmed itinerary and Accounts & Finance data on ${new Date().toLocaleString(
        "en-IN",
      )}.`,
      left,
      y + 22,
      {
        width:
          430,
      },
    );


  doc.end();
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
      mode_of_pay: modeOfPaymentId ?? null, // 1: Cash, 2: UPI, 3: Net Banking
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
