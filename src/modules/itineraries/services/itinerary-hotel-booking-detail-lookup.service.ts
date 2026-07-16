import { Injectable } from '@nestjs/common';

export interface ItineraryHotelBookingDetailLookupResult {
  detailsMap: Map<string, number>;
  voucherStatusMap: Map<number, boolean>;
}

/** Loads persisted hotel-detail identities and voucher cancellation flags for response rows. */
@Injectable()
export class ItineraryHotelBookingDetailLookupService {
  async load(input: {
    loadDetails: () => Promise<any[]>;
    loadVoucherStatuses: (detailIds: number[]) => Promise<any[]>;
  }): Promise<ItineraryHotelBookingDetailLookupResult> {
    const details = await input.loadDetails();
    const detailIds = details.map((detail) => Number(detail.itinerary_plan_hotel_details_ID));
    const voucherStatuses = detailIds.length
      ? await input.loadVoucherStatuses(detailIds)
      : [];
    const detailsMap = new Map<string, number>(
      details.map((detail) => [
        `${detail.itinerary_route_id}-${detail.hotel_id}-${detail.group_type}`,
        detail.itinerary_plan_hotel_details_ID,
      ]),
    );
    const voucherStatusMap = new Map<number, boolean>(
      voucherStatuses.map((voucher) => [
        voucher.itinerary_plan_hotel_details_ID,
        voucher.hotel_voucher_cancellation_status === 1,
      ]),
    );
    return { detailsMap, voucherStatusMap };
  }
}
