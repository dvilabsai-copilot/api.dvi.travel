import { Injectable, BadRequestException } from "@nestjs/common";
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

  // DVI_HOTEL_RECONCILE_V1: explicit Accounts-only repair of ONE selected hotel.
  // Never infer an Accounts header or historical payments from the selling quote.
  async reconcileHotel(confirmedId: number, planId: number, hotelId: number) {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const plan = await tx.dvi_confirmed_itinerary_plan_details.findFirst({
        where: { confirmed_itinerary_plan_ID: confirmedId, itinerary_plan_ID: planId, deleted: 0, status: 1 },
      });
      if (!plan) throw new BadRequestException('No active confirmed itinerary matches both IDs. Review the confirmed booking.');
      const headers = await tx.dvi_accounts_itinerary_details.findMany({
        where: { OR: [{ confirmed_itinerary_plan_ID: confirmedId }, { itinerary_plan_ID: planId }] },
      });
      if (headers.length !== 1 || Number(headers[0].deleted) !== 0 || Number(headers[0].confirmed_itinerary_plan_ID) !== confirmedId || Number(headers[0].itinerary_plan_ID) !== planId) {
        throw new BadRequestException('Accounts header is missing, deleted or ambiguous. Finance must reconcile the original header and payment history before posting this hotel.');
      }
      const headerId = Number(headers[0].accounts_itinerary_details_ID);
      const confirmedRows = await tx.dvi_confirmed_itinerary_plan_hotel_details.findMany({
        where: { itinerary_plan_id: planId, hotel_id: hotelId, deleted: 0, status: 1 },
      });
      if (!confirmedRows.length) throw new BadRequestException('No active confirmed hotel rows match this hotel ID. Check the persisted hotel assignment and status.');
      const master = await tx.dvi_hotel.findFirst({where: {hotel_id: hotelId}});
      if (!master || !String(master.hotel_name || '').trim()) throw new BadRequestException('Hotel supplier identity could not be verified.');
      const ids = confirmedRows.map(r => Number(r.confirmed_itinerary_plan_hotel_details_ID));
      const routeIds = confirmedRows.map(r => Number(r.itinerary_route_id));
      if (ids.some(x => !Number.isSafeInteger(x) || x <= 0) || routeIds.some(x => !Number.isSafeInteger(x) || x <= 0) || new Set(routeIds).size !== routeIds.length || new Set(ids).size !== ids.length) throw new BadRequestException('Ambiguous confirmed hotel rows. Review the stay and room records before posting.');
      const originalIds = confirmedRows.map(r => Number(r.itinerary_plan_hotel_details_ID));
      if (originalIds.some(x => !Number.isSafeInteger(x) || x <= 0)) throw new BadRequestException('Original hotel detail identity is missing.');
      const vouchers = await tx.dvi_confirmed_itinerary_plan_hotel_voucher_details.findMany({where: {itinerary_plan_id: planId, deleted: 0}});
      if (confirmedRows.some(r => Number((r as any).hotel_cancellation_status || 0) === 1) || vouchers.some(v => originalIds.includes(Number(v.itinerary_plan_hotel_details_ID)) && (Number(v.hotel_voucher_cancellation_status || 0) === 1 || Number(v.hotel_booking_status || 0) === 2))) throw new BadRequestException('A hotel stay has a cancellation record. Review it before posting.');
      // Include deleted and historical detail IDs. Do not create a replacement for prior finance records.
      const prior = await tx.dvi_accounts_itinerary_hotel_details.findMany({where: {OR: [{itinerary_plan_ID: planId, hotel_id: hotelId}, {cnf_itinerary_plan_hotel_details_ID: {in: ids}}, {itinerary_plan_hotel_details_ID: {in: originalIds}}, {accounts_itinerary_details_ID: headerId, hotel_id: hotelId}]}});
      if (prior.some(r => Number(r.deleted) !== 0 || Number(r.status) !== 1 || Number(r.accounts_itinerary_details_ID) !== headerId || Number(r.hotel_id) !== hotelId || !ids.includes(Number(r.cnf_itinerary_plan_hotel_details_ID)))) throw new BadRequestException('Historical or conflicting hotel finance records exist. Reconcile their payment history manually.');
      const existing = new Set(prior.map(r=>Number(r.cnf_itinerary_plan_hotel_details_ID)));
      if (existing.size !== prior.length) throw new BadRequestException('Duplicate finance records require review.');
      for (const row of confirmedRows.filter(r=>!existing.has(Number(r.confirmed_itinerary_plan_hotel_details_ID)))) {
        const amounts = [row.total_hotel_cost,row.total_hotel_tax_amount,row.hotel_margin_rate,row.hotel_margin_rate_tax_amt];
        if (amounts.some(v=>v===null || v===undefined || !Number.isFinite(Number(v)) || Number(v)<0) || Number(row.total_hotel_cost)<Number(row.hotel_margin_rate) || Number(row.total_hotel_tax_amount)<Number(row.hotel_margin_rate_tax_amt) || Number(row.total_hotel_cost)-Number(row.hotel_margin_rate)+Number(row.total_hotel_tax_amount)-Number(row.hotel_margin_rate_tax_amt)<=0) throw new BadRequestException('Confirmed supplier purchase price or margin is unavailable or invalid. No payable created.');
      }
      // Reuse the existing DVI purchase/margin formula. Scope it to the verified hotel rows only.
      await this.syncHotels(tx, headerId, planId, Number(plan.createdby || 0), ids);
      const posted = await tx.dvi_accounts_itinerary_hotel_details.findMany({where:{accounts_itinerary_details_ID:headerId,hotel_id:hotelId,deleted:0}});
      if (posted.length !== ids.length || !ids.every(i=>posted.some(r=>Number(r.cnf_itinerary_plan_hotel_details_ID)===i))) throw new BadRequestException('Not every verified hotel stay was posted. Repair rolled back; review source records.');
      return {hotelId, confirmedId, posted: posted.length, created: posted.length-prior.length};
    }, {isolationLevel: Prisma.TransactionIsolationLevel.Serializable});
  }

  private async syncHotels(
    tx: Prisma.TransactionClient,
    headerId: number,
    planId: number,
    createdBy: number,
    onlyConfirmedIds?: number[],
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
            ...(onlyConfirmedIds ? { confirmed_itinerary_plan_hotel_details_ID: { in: onlyConfirmedIds } } : {}),
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