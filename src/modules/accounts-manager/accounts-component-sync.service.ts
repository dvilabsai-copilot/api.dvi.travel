import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma.service";

const toNumber = (value: unknown): number => {
  const parsed = Number(value ?? 0);

  return Number.isFinite(parsed)
    ? parsed
    : 0;
};

@Injectable()
export class AccountsComponentSyncService {
  /**
   * Prevent duplicate repair work when:
   *
   * /accounts-manager
   * /accounts-manager/summary
   * /accounts-ledger
   *
   * are requested very close together.
   */
  private readonly inFlight =
    new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Makes sure a fully CONFIRMED itinerary has:
   *
   * 1. dvi_accounts_itinerary_details
   * 2. hotel account components
   * 3. vehicle account components
   * 4. guide account components
   * 5. hotspot account components
   * 6. activity account components
   *
   * Latest / unconfirmed itineraries are deliberately ignored.
   */
  async ensureConfirmedQuote(
    quoteId?: string,
  ): Promise<void> {
    const normalizedQuoteId =
      String(quoteId || "").trim();

    if (!normalizedQuoteId) {
      return;
    }

    const key =
      normalizedQuoteId.toLowerCase();

    const running =
      this.inFlight.get(key);

    if (running) {
      await running;
      return;
    }

    const work =
      this.syncConfirmedQuote(
        normalizedQuoteId,
      ).finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(
      key,
      work,
    );

    await work;
  }

  private async syncConfirmedQuote(
    quoteId: string,
  ): Promise<void> {
    /**
     * IMPORTANT:
     * exact quote match only.
     *
     * Do not use "contains" here because this code
     * writes finance records.
     */
    const confirmedPlan =
      await this.prisma
        .dvi_confirmed_itinerary_plan_details
        .findFirst({
          where: {
            itinerary_quote_ID:
              quoteId,
            deleted: 0,
            status: 1,
          },
          orderBy: {
            confirmed_itinerary_plan_ID:
              "desc",
          },
        });

    /**
     * Latest itinerary / invalid quote:
     * do not manufacture Accounts data.
     */
    if (!confirmedPlan) {
      return;
    }

    await this.prisma.$transaction(
      async (
        tx: Prisma.TransactionClient,
      ) => {
        let accountHeader =
          await tx
            .dvi_accounts_itinerary_details
            .findFirst({
              where: {
                deleted: 0,

                OR: [
                  {
                    confirmed_itinerary_plan_ID:
                      confirmedPlan
                        .confirmed_itinerary_plan_ID,
                  },

                  {
                    itinerary_plan_ID:
                      confirmedPlan
                        .itinerary_plan_ID,
                  },
                ],
              },

              orderBy: {
                accounts_itinerary_details_ID:
                  "desc",
              },
            });

        /*
         * Repair old confirmed bookings where even
         * the Accounts header was never generated.
         */
        if (!accountHeader) {
          const totalBilled =
            toNumber(
              confirmedPlan
                .itinerary_total_net_payable_amount,
            );

          const storedPaid =
            toNumber(
              confirmedPlan
                .itinerary_total_paid_amount,
            );

          const storedBalance =
            toNumber(
              confirmedPlan
                .itinerary_total_balance_amount,
            );

          /*
           * Current confirmation flow deducts the
           * confirmed amount before the finance
           * context is complete.
           *
           * For older records where both persisted
           * paid/balance fields are zero, treat the
           * confirmed billed amount as received.
           */
          const hasStoredPaymentState =
            storedPaid > 0 ||
            storedBalance > 0;

          const totalReceived =
            hasStoredPaymentState
              ? storedPaid
              : totalBilled;

          const totalReceivable =
            hasStoredPaymentState
              ? storedBalance
              : 0;

          accountHeader =
            await tx
              .dvi_accounts_itinerary_details
              .create({
                data: {
                  itinerary_plan_ID:
                    Number(
                      confirmedPlan
                        .itinerary_plan_ID ||
                        0,
                    ),

                  agent_id:
                    Number(
                      confirmedPlan
                        .agent_id ||
                        0,
                    ),

                  staff_id:
                    Number(
                      confirmedPlan
                        .staff_id ||
                        0,
                    ),

                  confirmed_itinerary_plan_ID:
                    Number(
                      confirmedPlan
                        .confirmed_itinerary_plan_ID ||
                        0,
                    ),

                  itinerary_quote_ID:
                    String(
                      confirmedPlan
                        .itinerary_quote_ID ||
                        quoteId,
                    ),

                  trip_start_date_and_time:
                    confirmedPlan
                      .trip_start_date_and_time,

                  trip_end_date_and_time:
                    confirmedPlan
                      .trip_end_date_and_time,

                  total_billed_amount:
                    totalBilled,

                  total_received_amount:
                    totalReceived,

                  total_receivable_amount:
                    totalReceivable,

                  /*
                   * This matches the existing
                   * confirmation implementation:
                   * cost.totalAmount is saved as
                   * itinerary_gross_total_amount.
                   */
                  total_payable_amount:
                    toNumber(
                      confirmedPlan
                        .itinerary_gross_total_amount,
                    ),

                  total_payout_amount: 0,

                  createdby:
                    Number(
                      confirmedPlan
                        .createdby ||
                        0,
                    ),

                  createdon:
                    new Date(),

                  status: 1,
                  deleted: 0,
                },
              });
        }

        const headerId =
          Number(
            accountHeader
              .accounts_itinerary_details_ID,
          );

        const planId =
          Number(
            confirmedPlan
              .itinerary_plan_ID,
          );

        const createdBy =
          Number(
            confirmedPlan
              .createdby ||
              0,
          );

        await this.syncHotels(
          tx,
          headerId,
          planId,
          createdBy,
        );

        await this.syncVehicles(
          tx,
          headerId,
          planId,
          createdBy,
        );

        await this.syncGuides(
          tx,
          headerId,
          planId,
          createdBy,
        );

        await this.syncHotspots(
          tx,
          headerId,
          planId,
          createdBy,
        );

        await this.syncActivities(
          tx,
          headerId,
          planId,
          createdBy,
        );
      },
    );
  }

  private async syncHotels(
    tx: Prisma.TransactionClient,
    headerId: number,
    planId: number,
    createdBy: number,
  ) {
    const [
      confirmedRows,
      existingRows,
    ] = await Promise.all([
      tx
        .dvi_confirmed_itinerary_plan_hotel_details
        .findMany({
          where: {
            itinerary_plan_id:
              planId,
            deleted: 0,
            status: 1,
          },
        }),

      tx
        .dvi_accounts_itinerary_hotel_details
        .findMany({
          where: {
            accounts_itinerary_details_ID:
              headerId,
            deleted: 0,
          },

          select: {
            cnf_itinerary_plan_hotel_details_ID:
              true,

            itinerary_route_id:
              true,

            hotel_id:
              true,
          },
        }),
    ]);

    const confirmedIds =
      new Set(
        existingRows
          .map((row) =>
            Number(
              row
                .cnf_itinerary_plan_hotel_details_ID ||
                0,
            ),
          )
          .filter(
            (id) => id > 0,
          ),
      );

    const routeHotelKeys =
      new Set(
        existingRows.map(
          (row) =>
            `${Number(
              row.itinerary_route_id ||
                0,
            )}:${Number(
              row.hotel_id || 0,
            )}`,
        ),
      );

    for (
      const row of confirmedRows
    ) {
      const confirmedId =
        Number(
          row
            .confirmed_itinerary_plan_hotel_details_ID ||
            0,
        );

      const routeId =
        Number(
          row
            .itinerary_route_id ||
            0,
        );

      const hotelId =
        Number(
          row.hotel_id || 0,
        );

      if (
        !confirmedId ||
        !hotelId
      ) {
        continue;
      }

      const fallbackKey =
        `${routeId}:${hotelId}`;

      if (
        confirmedIds.has(
          confirmedId,
        ) ||
        routeHotelKeys.has(
          fallbackKey,
        )
      ) {
        continue;
      }

      /*
       * Confirmed hotel price:
       *
       * total_hotel_cost contains base + margin.
       * total_hotel_tax_amount contains supplier
       * tax + margin tax.
       *
       * Vendor payable must exclude both margin
       * and margin GST.
       */
      const hotelSellingBase =
        toNumber(
          row.total_hotel_cost,
        );

      const hotelSellingTax =
        toNumber(
          row
            .total_hotel_tax_amount,
        );

      const hotelMargin =
        toNumber(
          row.hotel_margin_rate,
        );

      const hotelMarginTax =
        toNumber(
          row
            .hotel_margin_rate_tax_amt,
        );

      const purchaseBase =
        Math.max(
          0,
          hotelSellingBase -
            hotelMargin,
        );

      const purchaseTax =
        Math.max(
          0,
          hotelSellingTax -
            hotelMarginTax,
        );

      const vendorPayable =
        purchaseBase +
        purchaseTax;

      /*
       * Completely zero rows aren't useful
       * Accounts components.
       */
      if (
        vendorPayable <= 0 &&
        hotelSellingBase +
          hotelSellingTax <=
          0
      ) {
        continue;
      }

      await tx
        .dvi_accounts_itinerary_hotel_details
        .create({
          data: {
            accounts_itinerary_details_ID:
              headerId,

            itinerary_plan_hotel_details_ID:
              Number(
                row
                  .itinerary_plan_hotel_details_ID ||
                  0,
              ),

            cnf_itinerary_plan_hotel_details_ID:
              confirmedId,

            itinerary_plan_ID:
              planId,

            itinerary_route_id:
              routeId,

            itinerary_route_date:
              row
                .itinerary_route_date,

            hotel_id:
              hotelId,

            total_hotel_cost:
              hotelSellingBase,

            total_hotel_tax_amount:
              hotelSellingTax,

            total_purchase_cost:
              purchaseBase,

            total_payable:
              vendorPayable,

            total_paid: 0,

            total_balance:
              vendorPayable,

            createdby:
              createdBy,

            createdon:
              new Date(),

            status: 1,
            deleted: 0,
          },
        });

      confirmedIds.add(
        confirmedId,
      );

      routeHotelKeys.add(
        fallbackKey,
      );
    }
  }

  private async syncVehicles(
    tx: Prisma.TransactionClient,
    headerId: number,
    planId: number,
    createdBy: number,
  ) {
    const [
      confirmedRows,
      existingRows,
    ] = await Promise.all([
      tx
        .dvi_confirmed_itinerary_plan_vendor_eligible_list
        .findMany({
          where: {
            itinerary_plan_id:
              planId,

            deleted: 0,
            status: 1,

            itineary_plan_assigned_status:
              1,
          },
        }),

      tx
        .dvi_accounts_itinerary_vehicle_details
        .findMany({
          where: {
            accounts_itinerary_details_ID:
              headerId,
            deleted: 0,
          },

          select: {
            confirmed_itinerary_plan_vendor_eligible_ID:
              true,

            itinerary_plan_vendor_eligible_ID:
              true,
          },
        }),
    ]);

    const confirmedIds =
      new Set(
        existingRows
          .map((row) =>
            Number(
              row
                .confirmed_itinerary_plan_vendor_eligible_ID ||
                0,
            ),
          )
          .filter(
            (id) => id > 0,
          ),
      );

    const draftIds =
      new Set(
        existingRows
          .map((row) =>
            Number(
              row
                .itinerary_plan_vendor_eligible_ID ||
                0,
            ),
          )
          .filter(
            (id) => id > 0,
          ),
      );

    for (
      const row of confirmedRows
    ) {
      const confirmedId =
        Number(
          row
            .confirmed_itinerary_plan_vendor_eligible_ID ||
            0,
        );

      const draftId =
        Number(
          row
            .itinerary_plan_vendor_eligible_ID ||
            0,
        );

      if (!confirmedId) {
        continue;
      }

      if (
        confirmedIds.has(
          confirmedId,
        ) ||
        (
          draftId > 0 &&
          draftIds.has(
            draftId,
          )
        )
      ) {
        continue;
      }

      /*
       * Legacy B2B purchase calculation:
       * vehicle_total_amount + vehicle_gst_amount.
       *
       * Vendor margin and vendor-margin GST are
       * separate selling-side values.
       */
      const totalPurchase =
        toNumber(
          row.vehicle_total_amount,
        ) +
        toNumber(
          row.vehicle_gst_amount,
        );

      const vehicleGrandTotal =
        toNumber(
          row.vehicle_grand_total,
        ) ||
        (
          totalPurchase +
          toNumber(
            row.vendor_margin_amount,
          ) +
          toNumber(
            row
              .vendor_margin_gst_amount,
          )
        );

      if (
        totalPurchase <= 0 &&
        vehicleGrandTotal <= 0
      ) {
        continue;
      }

      await tx
        .dvi_accounts_itinerary_vehicle_details
        .create({
          data: {
            accounts_itinerary_details_ID:
              headerId,

            itinerary_plan_ID:
              planId,

            itinerary_plan_vendor_eligible_ID:
              draftId,

            confirmed_itinerary_plan_vendor_eligible_ID:
              confirmedId,

            vehicle_id:
              Number(
                row.vehicle_id || 0,
              ),

            vehicle_type_id:
              Number(
                row
                  .vehicle_type_id ||
                  0,
              ),

            vendor_id:
              Number(
                row.vendor_id || 0,
              ),

            vendor_vehicle_type_id:
              Number(
                row
                  .vendor_vehicle_type_id ||
                  0,
              ),

            vendor_branch_id:
              Number(
                row
                  .vendor_branch_id ||
                  0,
              ),

            vehicle_grand_total:
              vehicleGrandTotal,

            total_vehicle_qty:
              Number(
                row
                  .total_vehicle_qty ||
                  row.vehicle_count ||
                  0,
              ),

            total_purchase:
              totalPurchase,

            total_payable:
              totalPurchase,

            total_paid: 0,

            total_balance:
              totalPurchase,

            createdby:
              createdBy,

            createdon:
              new Date(),

            status: 1,
            deleted: 0,
          },
        });

      confirmedIds.add(
        confirmedId,
      );

      if (draftId > 0) {
        draftIds.add(
          draftId,
        );
      }
    }
  }

  private async syncGuides(
    tx: Prisma.TransactionClient,
    headerId: number,
    planId: number,
    createdBy: number,
  ) {
    const [
      confirmedRows,
      existingRows,
    ] = await Promise.all([
      tx
        .dvi_confirmed_itinerary_route_guide_slot_cost_details
        .findMany({
          where: {
            itinerary_plan_id:
              planId,

            deleted: 0,
            status: 1,

            cancellation_status:
              0,
          },
        }),

      tx
        .dvi_accounts_itinerary_guide_details
        .findMany({
          where: {
            accounts_itinerary_details_ID:
              headerId,
            deleted: 0,
          },

          select: {
            cnf_itinerary_guide_slot_cost_details_ID:
              true,

            guide_slot_cost_details_ID:
              true,
          },
        }),
    ]);

    const confirmedIds =
      new Set(
        existingRows
          .map((row) =>
            Number(
              row
                .cnf_itinerary_guide_slot_cost_details_ID ||
                0,
            ),
          )
          .filter(
            (id) => id > 0,
          ),
      );

    const sourceIds =
      new Set(
        existingRows
          .map((row) =>
            Number(
              row
                .guide_slot_cost_details_ID ||
                0,
            ),
          )
          .filter(
            (id) => id > 0,
          ),
      );

    for (
      const row of confirmedRows
    ) {
      const confirmedId =
        Number(
          row
            .cnf_itinerary_guide_slot_cost_details_ID ||
            0,
        );

      const sourceId =
        Number(
          row
            .guide_slot_cost_details_id ||
            0,
        );

      const amount =
        toNumber(
          row.guide_slot_cost,
        );

      if (
        !confirmedId ||
        amount <= 0
      ) {
        continue;
      }

      if (
        confirmedIds.has(
          confirmedId,
        ) ||
        (
          sourceId > 0 &&
          sourceIds.has(
            sourceId,
          )
        )
      ) {
        continue;
      }

      await tx
        .dvi_accounts_itinerary_guide_details
        .create({
          data: {
            accounts_itinerary_details_ID:
              headerId,

            cnf_itinerary_guide_slot_cost_details_ID:
              confirmedId,

            itinerary_plan_ID:
              planId,

            itinerary_route_ID:
              Number(
                row
                  .itinerary_route_id ||
                  0,
              ),

            guide_slot_cost_details_ID:
              sourceId,

            route_guide_ID:
              Number(
                row.route_guide_id ||
                  0,
              ),

            guide_id:
              Number(
                row.guide_id || 0,
              ),

            itinerary_route_date:
              row
                .itinerary_route_date,

            guide_type:
              Number(
                row.guide_type || 0,
              ),

            guide_slot:
              Number(
                row.guide_slot || 0,
              ),

            guide_slot_cost:
              amount,

            total_payable:
              amount,

            total_paid: 0,

            total_balance:
              amount,

            createdby:
              createdBy,

            createdon:
              new Date(),

            status: 1,
            deleted: 0,
          },
        });

      confirmedIds.add(
        confirmedId,
      );

      if (sourceId > 0) {
        sourceIds.add(
          sourceId,
        );
      }
    }
  }

  private async syncHotspots(
    tx: Prisma.TransactionClient,
    headerId: number,
    planId: number,
    createdBy: number,
  ) {
    const [
      confirmedRows,
      existingRows,
    ] = await Promise.all([
      tx
        .dvi_confirmed_itinerary_route_hotspot_details
        .findMany({
          where: {
            itinerary_plan_ID:
              planId,

            deleted: 0,
            status: 1,
          },
        }),

      tx
        .dvi_accounts_itinerary_hotspot_details
        .findMany({
          where: {
            accounts_itinerary_details_ID:
              headerId,
            deleted: 0,
          },

          select: {
            confirmed_route_hotspot_ID:
              true,

            route_hotspot_ID:
              true,
          },
        }),
    ]);

    const confirmedIds =
      new Set(
        existingRows
          .map((row) =>
            Number(
              row
                .confirmed_route_hotspot_ID ||
                0,
            ),
          )
          .filter(
            (id) => id > 0,
          ),
      );

    const sourceIds =
      new Set(
        existingRows
          .map((row) =>
            Number(
              row.route_hotspot_ID ||
                0,
            ),
          )
          .filter(
            (id) => id > 0,
          ),
      );

    for (
      const row of confirmedRows
    ) {
      const confirmedId =
        Number(
          row
            .confirmed_route_hotspot_ID ||
            0,
        );

      const sourceId =
        Number(
          row.route_hotspot_ID ||
            0,
        );

      const amount =
        toNumber(
          row.hotspot_amout,
        );

      if (
        !confirmedId ||
        amount <= 0
      ) {
        continue;
      }

      if (
        confirmedIds.has(
          confirmedId,
        ) ||
        (
          sourceId > 0 &&
          sourceIds.has(
            sourceId,
          )
        )
      ) {
        continue;
      }

      await tx
        .dvi_accounts_itinerary_hotspot_details
        .create({
          data: {
            accounts_itinerary_details_ID:
              headerId,

            confirmed_route_hotspot_ID:
              confirmedId,

            itinerary_plan_ID:
              planId,

            itinerary_route_ID:
              Number(
                row
                  .itinerary_route_ID ||
                  0,
              ),

            route_hotspot_ID:
              sourceId,

            hotspot_ID:
              Number(
                row.hotspot_ID || 0,
              ),

            hotspot_amount:
              amount,

            total_payable:
              amount,

            total_paid: 0,

            total_balance:
              amount,

            createdby:
              createdBy,

            createdon:
              new Date(),

            status: 1,
            deleted: 0,
          },
        });

      confirmedIds.add(
        confirmedId,
      );

      if (sourceId > 0) {
        sourceIds.add(
          sourceId,
        );
      }
    }
  }

  private async syncActivities(
    tx: Prisma.TransactionClient,
    headerId: number,
    planId: number,
    createdBy: number,
  ) {
    const [
      confirmedRows,
      existingRows,
    ] = await Promise.all([
      tx
        .dvi_confirmed_itinerary_route_activity_details
        .findMany({
          where: {
            itinerary_plan_ID:
              planId,

            deleted: 0,
            status: 1,
          },
        }),

      tx
        .dvi_accounts_itinerary_activity_details
        .findMany({
          where: {
            accounts_itinerary_details_ID:
              headerId,
            deleted: 0,
          },

          select: {
            confirmed_route_activity_ID:
              true,

            route_activity_ID:
              true,
          },
        }),
    ]);

    const confirmedIds =
      new Set(
        existingRows
          .map((row) =>
            Number(
              row
                .confirmed_route_activity_ID ||
                0,
            ),
          )
          .filter(
            (id) => id > 0,
          ),
      );

    const sourceIds =
      new Set(
        existingRows
          .map((row) =>
            Number(
              row.route_activity_ID ||
                0,
            ),
          )
          .filter(
            (id) => id > 0,
          ),
      );

    for (
      const row of confirmedRows
    ) {
      const confirmedId =
        Number(
          row
            .confirmed_route_activity_ID ||
            0,
        );

      const sourceId =
        Number(
          row.route_activity_ID ||
            0,
        );

      const amount =
        toNumber(
          row.activity_amout,
        );

      if (
        !confirmedId ||
        amount <= 0
      ) {
        continue;
      }

      if (
        confirmedIds.has(
          confirmedId,
        ) ||
        (
          sourceId > 0 &&
          sourceIds.has(
            sourceId,
          )
        )
      ) {
        continue;
      }

      await tx
        .dvi_accounts_itinerary_activity_details
        .create({
          data: {
            accounts_itinerary_details_ID:
              headerId,

            confirmed_route_activity_ID:
              confirmedId,

            itinerary_plan_ID:
              planId,

            itinerary_route_ID:
              Number(
                row
                  .itinerary_route_ID ||
                  0,
              ),

            route_hotspot_ID:
              Number(
                row
                  .route_hotspot_ID ||
                  0,
              ),

            route_activity_ID:
              sourceId,

            hotspot_ID:
              Number(
                row.hotspot_ID || 0,
              ),

            activity_ID:
              Number(
                row.activity_ID || 0,
              ),

            activity_amount:
              amount,

            total_payable:
              amount,

            total_paid: 0,

            total_balance:
              amount,

            createdby:
              createdBy,

            createdon:
              new Date(),

            status: 1,
            deleted: 0,
          },
        });

      confirmedIds.add(
        confirmedId,
      );

      if (sourceId > 0) {
        sourceIds.add(
          sourceId,
        );
      }
    }
  }
}