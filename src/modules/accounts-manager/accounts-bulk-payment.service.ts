import {
  BadRequestException,
  Injectable,
} from "@nestjs/common";

import {
  PrismaService,
} from "../../prisma.service";

import {
  AccountsManagerBulkPayDto,
  AccountsManagerBulkPayItemDto,
} from "./dto/accounts-manager-extra.dto";


/*
 * Map each Accounts component to its existing
 * details and transaction-history tables.
 */
const COMPONENT_CONFIG = {
  hotel: {
    detailModel:
      "dvi_accounts_itinerary_hotel_details",

    detailIdField:
      "accounts_itinerary_hotel_details_ID",

    payeeIdField:
      "hotel_id",

    historyModel:
      "dvi_accounts_itinerary_hotel_transaction_history",

    historyDetailIdField:
      "accounts_itinerary_hotel_details_ID",
  },


  vehicle: {
    detailModel:
      "dvi_accounts_itinerary_vehicle_details",

    detailIdField:
      "accounts_itinerary_vehicle_details_ID",

    /*
     * Vehicle Accounts detail already stores
     * its actual vendor_id.
     */
    payeeIdField:
      "vendor_id",

    historyModel:
      "dvi_accounts_itinerary_vehicle_transaction_history",

    historyDetailIdField:
      "accounts_itinerary_vehicle_details_ID",
  },


  guide: {
    detailModel:
      "dvi_accounts_itinerary_guide_details",

    detailIdField:
      "accounts_itinerary_guide_details_ID",

    payeeIdField:
      "guide_id",

    historyModel:
      "dvi_accounts_itinerary_guide_transaction_history",

    historyDetailIdField:
      "accounts_itinerary_guide_details_ID",
  },


  hotspot: {
    detailModel:
      "dvi_accounts_itinerary_hotspot_details",

    detailIdField:
      "accounts_itinerary_hotspot_details_ID",

    payeeIdField:
      "hotspot_ID",

    historyModel:
      "dvi_accounts_itinerary_hotspot_transaction_history",

    historyDetailIdField:
      "accounts_itinerary_hotspot_details_ID",
  },


  activity: {
    detailModel:
      "dvi_accounts_itinerary_activity_details",

    detailIdField:
      "accounts_itinerary_activity_details_ID",

    payeeIdField:
      "activity_ID",

    historyModel:
      "dvi_accounts_itinerary_activity_transaction_history",

    historyDetailIdField:
      "accounts_itinerary_activity_details_ID",
  },
} as const;


@Injectable()
export class AccountsBulkPaymentService {
  constructor(
    private readonly prisma:
      PrismaService,
  ) {}


  async recordBulkPayment(
    body:
      AccountsManagerBulkPayDto,
  ): Promise<void> {
    const payments = [...(body.payments || [])];
    // Consistent lock ordering for vehicle batches reduces deadlocks.
    if (payments.every(p => p.componentType === "vehicle")) {
      payments.sort((a,b) => Number(a.componentDetailId)-Number(b.componentDetailId));
    }


    if (
      payments.length ===
      0
    ) {
      throw new BadRequestException(
        "Select at least one payment task.",
      );
    }


    if (
      payments.length >
      100
    ) {
      throw new BadRequestException(
        "A maximum of 100 tasks can be paid at once.",
      );
    }


    /*
     * IMPORTANT:
     *
     * Everything happens inside ONE transaction.
     *
     * If Task 3 fails after Task 1 and 2,
     * Task 1 and 2 are rolled back too.
     */
    await this.prisma
      .$transaction(
        async (
          tx:
            any,
        ) => {
          const seenTasks =
            new Set<
              string
            >();


          let expectedPayeeKey:
            string | null =
            null;


          for (
            const payment
            of payments
          ) {
            const config =
              COMPONENT_CONFIG[
                payment
                  .componentType
              ];


            if (!config) {
              throw new BadRequestException(
                `Unsupported component type: ${payment.componentType}`,
              );
            }


            const taskKey =
              [
                payment
                  .componentType,

                payment
                  .accountsItineraryDetailsId,

                payment
                  .componentDetailId,
              ].join(
                ":",
              );


            if (
              seenTasks.has(
                taskKey,
              )
            ) {
              throw new BadRequestException(
                "The same payment task cannot be selected twice.",
              );
            }


            seenTasks.add(
              taskKey,
            );


            const detailModel =
              tx[
                config
                  .detailModel
              ];


            // Vehicle payments use a locking read, not the transaction's older snapshot.
            const vehicleId = Number(payment.componentDetailId);
            if (payment.componentType === "vehicle" && (!Number.isSafeInteger(vehicleId) || vehicleId <= 0)) throw new BadRequestException("Invalid vehicle finance identity.");
            const lockedVehicle = payment.componentType === "vehicle"
              ? (await tx.$queryRaw`SELECT v.* FROM dvi_accounts_itinerary_vehicle_details v INNER JOIN dvi_accounts_itinerary_details h ON h.accounts_itinerary_details_ID=v.accounts_itinerary_details_ID WHERE v.accounts_itinerary_vehicle_details_ID=${vehicleId} AND v.deleted=0 AND v.status=1 AND h.deleted=0 FOR UPDATE`)[0]
              : null;
            const detail = payment.componentType === "vehicle" ? lockedVehicle :
              await detailModel
                .findUnique({
                  where: {
                    [config.detailIdField]:
                      Number(
                        payment
                          .componentDetailId,
                      ),
                  },
                });


            if (
              !detail ||
              Number(
                detail.deleted ||
                  0,
              ) === 1
            ) {
              throw new BadRequestException(
                "One of the selected payment tasks no longer exists.",
              );
            }


            const headerId =
              Number(
                detail
                  .accounts_itinerary_details_ID ||
                  0,
              );


            /*
             * Never trust an ID pairing sent only
             * by the browser.
             */
            if (
              headerId !==
              Number(
                payment
                  .accountsItineraryDetailsId,
              )
            ) {
              throw new BadRequestException(
                "Payment task does not belong to the supplied Accounts booking.",
              );
            }


            const amount =
              Number(
                payment.amount ||
                  0,
              );


            const currentPaid =
              Number(
                detail
                  .total_paid ??
                  0,
              );


            const currentBalance =
              Number(
                detail
                  .total_balance ??
                  0,
              );


            if (
              !Number.isFinite(
                amount,
              ) ||
              amount <= 0
            ) {
              throw new BadRequestException(
                "Payment amount must be greater than zero.",
              );
            }


            if (
              currentBalance <=
              0
            ) {
              throw new BadRequestException(
                "One of the selected tasks is already fully paid.",
              );
            }


            if (
              (payment.componentType === "vehicle" ? Math.round(amount*100) > Math.round(currentBalance*100) : amount > currentBalance)
            ) {
              throw new BadRequestException(
                "Payment amount cannot be greater than the current balance.",
              );
            }


            /*
             * Determine the REAL persisted Vendor/Supplier
             * from the Accounts row.
             */
            const payeeId =
              Number(
                detail[
                  config
                    .payeeIdField
                ] ||
                  0,
              );


            if (
              payeeId <=
              0
            ) {
              throw new BadRequestException(
                "Unable to determine the supplier/vendor for one selected payment task.",
              );
            }


            /*
             * Component type is intentionally part of this key.
             *
             * A Hotel ID 10 and Vehicle Vendor ID 10 are not
             * necessarily the same business/payee.
             */
            const payeeKey =
              `${payment.componentType}:${payeeId}`;


            if (
              expectedPayeeKey ===
              null
            ) {
              expectedPayeeKey =
                payeeKey;
            } else if (
              expectedPayeeKey !==
              payeeKey
            ) {
              throw new BadRequestException(
                "Multiple payment tasks must belong to the same vendor.",
              );
            }


            /*
             * Update that component's individual
             * paid/balance figures.
             */
            // DVI_HOTEL_BULK_ATOMIC_V1: compare persisted balances before changing a hotel row.
            if (payment.componentType === "hotel") {
              const asCents = (n: number) => Math.round(n * 100);
              const precise = (n: number) => Number.isFinite(n) && n >= 0 && Number.isSafeInteger(asCents(n)) && Math.abs(n * 100 - asCents(n)) < 0.000001;
              if (Number(detail.status) !== 1 || !precise(currentPaid) || !precise(currentBalance) || !precise(amount) || asCents(amount) <= 0 || asCents(amount) > asCents(currentBalance)) {
                throw new BadRequestException("Hotel payment or persisted balance is invalid. Review the Accounts record.");
              }
              const reference = String(body.utrNumber || "").trim();
              if (!reference) throw new BadRequestException("Hotel payment reference is required.");
              const duplicate = await tx.dvi_accounts_itinerary_hotel_transaction_history.findFirst({where: {
                accounts_itinerary_hotel_details_ID: Number(payment.componentDetailId),
                transaction_utr_no: reference, deleted: 0,
              }});
              if (duplicate) throw new BadRequestException("This transfer reference is already recorded for the hotel task. Review payment history.");
              const changed = await detailModel.updateMany({where: {
                [config.detailIdField]: Number(payment.componentDetailId),
                accounts_itinerary_details_ID: headerId, hotel_id: payeeId, deleted: 0, status: 1,
                total_paid: detail.total_paid, total_balance: detail.total_balance,
              }, data: {
                total_paid: (asCents(currentPaid) + asCents(amount)) / 100,
                total_balance: (asCents(currentBalance) - asCents(amount)) / 100,
              }});
              if (changed.count !== 1) throw new BadRequestException("Hotel balance changed during payment. Reload before retrying.");
            } else if (payment.componentType === "vehicle") {
              // The row is exclusively locked until transaction commit/rollback.
              const cents = (v: number) => Math.round(v*100);
              const paid = cents(currentPaid), balance = cents(currentBalance), requested = cents(amount), purchase = cents(Number(detail.total_payable));
              if (![paid,balance,requested,purchase].every(Number.isSafeInteger) || paid < 0 || balance < 0 || requested <= 0 || requested > balance || paid+balance !== purchase || Math.abs(amount*100-requested)>0.000001) throw new BadRequestException("Invalid vehicle finance amount or balance. Review the record.");
              const reference = String(body.utrNumber || "").trim();
              if (!reference || !String(body.processedBy || "").trim()) throw new BadRequestException("Vehicle payment reference and processor are required.");
              // Locking read also sees a reference committed while this request waited for the row.
              const prior = await tx.$queryRaw`SELECT accounts_itinerary_vehicle_transaction_ID FROM dvi_accounts_itinerary_vehicle_transaction_history WHERE accounts_itinerary_vehicle_details_ID=${vehicleId} AND deleted=0 AND LOWER(TRIM(transaction_utr_no))=LOWER(${reference}) FOR UPDATE`;
              if (prior.length) throw new BadRequestException("This vehicle transfer reference is already recorded. Review history.");
              await detailModel.update({where:{accounts_itinerary_vehicle_details_ID:vehicleId},data:{total_paid:(paid+requested)/100,total_balance:(balance-requested)/100}});
            } else {
            await detailModel
              .update({
                where: {
                  [config.detailIdField]:
                    Number(
                      payment
                        .componentDetailId,
                    ),
                },

                data: {
                  total_paid:
                    currentPaid +
                    amount,

                  total_balance:
                    currentBalance -
                    amount,
                },
              });
            }


            /*
             * Every task still gets its own history row,
             * all sharing the same UTR/mode/proof.
             */
            await this
              .createTransactionHistory(
                tx,
                payment,
                body,
                headerId,
                amount,
              );
          }
        },
      );
  }


  private async createTransactionHistory(
    tx:
      any,

    payment:
      AccountsManagerBulkPayItemDto,

    body:
      AccountsManagerBulkPayDto,

    headerId:
      number,

    amount:
      number,
  ): Promise<void> {
    const config =
      COMPONENT_CONFIG[
        payment
          .componentType
      ];


    const transactionDate = payment.componentType === "vehicle" ? new Date() :
      payment.routeDate
        ? parseDDMMYYYY(
            payment.routeDate,
          ) ||
          new Date()
        : new Date();


    const common:
      any = {
      accounts_itinerary_details_ID:
        headerId,

      transaction_amount:
        amount,

      transaction_date:
        transactionDate,
      ...(payment.componentType === "vehicle" ? { createdon: transactionDate } : {}),

      transaction_done_by:
        body.processedBy ??
        null,

      mode_of_pay:
        body.modeOfPaymentId ??
        null,

      transaction_utr_no:
        body.utrNumber ??
        null,

      transaction_attachment:
        body
          .paymentScreenshotPath ??
        "",

      deleted:
        0,
    };


    const historyModel =
      tx[
        config
          .historyModel
      ];


    await historyModel
      .create({
        data: {
          ...common,

          [config.historyDetailIdField]:
            Number(
              payment
                .componentDetailId,
            ),
        },
      });
  }
}


function parseDDMMYYYY(
  value?:
    string,
): Date | undefined {
  if (!value) {
    return undefined;
  }


  const parts =
    value.split(
      "/",
    );


  if (
    parts.length !==
    3
  ) {
    return undefined;
  }


  const [
    dd,
    mm,
    yyyy,
  ] =
    parts;


  const day =
    Number(
      dd,
    );

  const month =
    Number(
      mm,
    );

  const year =
    Number(
      yyyy,
    );


  if (
    !day ||
    !month ||
    !year
  ) {
    return undefined;
  }


  const date =
    new Date(
      year,
      month - 1,
      day,
    );


  if (
    date.getFullYear() !==
      year ||
    date.getMonth() !==
      month - 1 ||
    date.getDate() !==
      day
  ) {
    return undefined;
  }


  return date;
}