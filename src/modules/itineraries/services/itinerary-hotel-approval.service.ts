import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';

export const HOTEL_APPROVAL_STATUS = {
  NOT_REQUESTED: 'NOT_REQUESTED',
  NOT_REQUIRED: 'NOT_REQUIRED',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
} as const;

export const MANUAL_CONFIRMATION_STATUS = {
  NOT_STARTED: 'NOT_STARTED',
  PENDING_CONFIRMATION: 'PENDING_CONFIRMATION',
  CONFIRMED: 'CONFIRMED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;

@Injectable()
export class ItineraryHotelApprovalService {
  constructor(private readonly prisma: PrismaService) {}

  async listPendingApproval() {
    const rows = await (this.prisma as any).dvi_itinerary_plan_hotel_details.findMany({
      where: { deleted: 0, status: 1, hotel_provider: 'offline', hotel_approval_status: 'PENDING_APPROVAL' },
      orderBy: [{ hotel_approval_requested_at: 'asc' }, { itinerary_plan_hotel_details_ID: 'asc' }],
    });
    return this.enrichRows(rows);
  }

  async approve(selectionId: number, actorId: number, notes?: string, approvedPrice?: number) {
    return this.transition(selectionId, actorId, 'approve', notes, approvedPrice);
  }

  async reject(selectionId: number, actorId: number, notes?: string) {
    return this.transition(selectionId, actorId, 'reject', notes);
  }

  async confirmManually(selectionId: number, actorId: number, notes?: string) {
    return this.prisma.$transaction(async (tx) => {
      const row = await (tx as any).dvi_itinerary_plan_hotel_details.findUnique({
        where: { itinerary_plan_hotel_details_ID: Number(selectionId) },
      });
      this.assertOffline(row);
      if (row.hotel_approval_status !== HOTEL_APPROVAL_STATUS.APPROVED) {
        throw new BadRequestException('Hotel availability and confirmation are subject to hotel approval.');
      }
      if (row.requires_price_reacceptance) {
        throw new BadRequestException('The approved hotel price changed. Customer reacceptance is required before confirmation.');
      }
      if (row.manual_confirmation_status === MANUAL_CONFIRMATION_STATUS.CONFIRMED) {
        return { success: true, selectionId: row.itinerary_plan_hotel_details_ID, approvalStatus: row.hotel_approval_status, manualConfirmationStatus: row.manual_confirmation_status };
      }
      const now = new Date();
      const updated = await (tx as any).dvi_itinerary_plan_hotel_details.update({
        where: { itinerary_plan_hotel_details_ID: Number(selectionId) },
        data: {
          manual_confirmation_status: MANUAL_CONFIRMATION_STATUS.CONFIRMED,
          manual_confirmation_requested_at: row.manual_confirmation_requested_at || now,
          manually_confirmed_at: now,
          manually_confirmed_by: actorId,
          manual_confirmation_notes: notes || null,
          updatedon: now,
        },
      });
      await this.writeHistory(tx, row, updated, actorId, notes || 'Manual hotel confirmation completed');
      return { success: true, selectionId: updated.itinerary_plan_hotel_details_ID, approvalStatus: updated.hotel_approval_status, manualConfirmationStatus: updated.manual_confirmation_status };
    });
  }

  async assertPlanCanFinalize(planId: number) {
    const rows = await (this.prisma as any).dvi_itinerary_plan_hotel_details.findMany({
      where: { itinerary_plan_id: Number(planId), deleted: 0, status: 1, hotel_required: { not: 2 } },
      select: { hotel_provider: true, hotel_booking_mode: true, hotel_approval_status: true, manual_confirmation_status: true },
    });
    for (const row of rows) {
      if (String(row.hotel_provider || '').toLowerCase() !== 'offline' && String(row.hotel_booking_mode || '').toUpperCase() !== 'MANUAL_APPROVAL') continue;
      if (row.hotel_approval_status === HOTEL_APPROVAL_STATUS.REJECTED) {
        throw new BadRequestException('The selected hotel was rejected. Please select another hotel.');
      }
      if (row.hotel_approval_status !== HOTEL_APPROVAL_STATUS.APPROVED || row.manual_confirmation_status !== MANUAL_CONFIRMATION_STATUS.CONFIRMED) {
        throw new BadRequestException('Hotel availability and confirmation are subject to hotel approval.');
      }
    }
  }

  async assertSelectionsCanCreateVoucher(selectionIds: number[]) {
    if (!selectionIds.length) return;
    const rows = await (this.prisma as any).dvi_itinerary_plan_hotel_details.findMany({
      where: { itinerary_plan_hotel_details_ID: { in: selectionIds }, deleted: 0 },
      select: { hotel_provider: true, hotel_booking_mode: true, hotel_approval_status: true, manual_confirmation_status: true },
    });
    for (const row of rows) {
      if (String(row.hotel_provider || '').toLowerCase() !== 'offline' && String(row.hotel_booking_mode || '').toUpperCase() !== 'MANUAL_APPROVAL') continue;
      if (row.hotel_approval_status === HOTEL_APPROVAL_STATUS.REJECTED) throw new BadRequestException('The selected hotel was rejected. Please select another hotel.');
      if (row.hotel_approval_status !== HOTEL_APPROVAL_STATUS.APPROVED || row.manual_confirmation_status !== MANUAL_CONFIRMATION_STATUS.CONFIRMED) throw new BadRequestException('Hotel availability and confirmation are subject to hotel approval.');
    }
  }

  private async transition(selectionId: number, actorId: number, action: 'approve' | 'reject', notes?: string, approvedPrice?: number) {
    return this.prisma.$transaction(async (tx) => {
      const row = await (tx as any).dvi_itinerary_plan_hotel_details.findUnique({ where: { itinerary_plan_hotel_details_ID: Number(selectionId) } });
      this.assertOffline(row);
      const targetStatus = action === 'approve' ? HOTEL_APPROVAL_STATUS.APPROVED : HOTEL_APPROVAL_STATUS.REJECTED;
      if (row.hotel_approval_status === targetStatus) {
        return { success: true, selectionId: row.itinerary_plan_hotel_details_ID, approvalStatus: row.hotel_approval_status, manualConfirmationStatus: row.manual_confirmation_status };
      }
      if (row.hotel_approval_status !== HOTEL_APPROVAL_STATUS.PENDING_APPROVAL) throw new BadRequestException('Hotel approval is no longer pending.');
      const now = new Date();
      const priceChanged = action === 'approve' && approvedPrice !== undefined && Number(approvedPrice) !== Number(row.selected_total_price);
      const updated = await (tx as any).dvi_itinerary_plan_hotel_details.update({
        where: { itinerary_plan_hotel_details_ID: Number(selectionId) },
        data: action === 'approve'
          ? { hotel_approval_status: targetStatus, hotel_approved_at: now, hotel_approved_by: actorId, manual_confirmation_status: MANUAL_CONFIRMATION_STATUS.PENDING_CONFIRMATION, requires_price_reacceptance: priceChanged, hotel_approval_notes: notes || null, updatedon: now }
          : { hotel_approval_status: targetStatus, hotel_rejected_at: now, hotel_rejected_by: actorId, hotel_approval_notes: notes || null, updatedon: now },
      });
      await this.writeHistory(tx, row, updated, actorId, notes || `Hotel ${action}d`);
      return { success: true, selectionId: updated.itinerary_plan_hotel_details_ID, approvalStatus: updated.hotel_approval_status, manualConfirmationStatus: updated.manual_confirmation_status, requiresPriceReacceptance: updated.requires_price_reacceptance };
    });
  }

  private assertOffline(row: any): void {
    if (!row) throw new NotFoundException('Itinerary hotel selection not found');
    if (String(row.hotel_provider || '').toLowerCase() !== 'offline' || String(row.hotel_booking_mode || '').toUpperCase() !== 'MANUAL_APPROVAL') throw new BadRequestException('Only offline manual-approval hotel selections can use this workflow.');
  }

  private async writeHistory(tx: any, previous: any, current: any, actorId: number, notes: string) {
    await tx.dvi_itinerary_plan_hotel_approval_history.create({
      data: {
        itinerary_plan_hotel_details_id: current.itinerary_plan_hotel_details_ID,
        previous_approval_status: previous.hotel_approval_status,
        new_approval_status: current.hotel_approval_status,
        previous_confirmation_status: previous.manual_confirmation_status,
        new_confirmation_status: current.manual_confirmation_status,
        price: current.selected_total_price,
        currency: current.selected_currency,
        notes,
        acted_by: actorId,
        acted_at: new Date(),
        metadata: current.selected_price_snapshot,
      },
    });
  }

  private async enrichRows(rows: any[]) {
    const hotelIds = Array.from(new Set(rows.map((row) => Number(row.hotel_id)).filter((id) => id > 0)));
    const selectionIds = rows.map((row) => Number(row.itinerary_plan_hotel_details_ID)).filter((id) => id > 0);
    const hotels = hotelIds.length ? await this.prisma.dvi_hotel.findMany({ where: { hotel_id: { in: hotelIds } }, select: { hotel_id: true, hotel_name: true, hotel_city: true } }) : [];
    const rooms = selectionIds.length
      ? await (this.prisma as any).dvi_itinerary_plan_hotel_room_details.findMany({
        where: { itinerary_plan_hotel_details_id: { in: selectionIds }, deleted: 0, status: 1 },
        select: { itinerary_plan_hotel_details_id: true, room_type_id: true, room_qty: true, breakfast_required: true, lunch_required: true, dinner_required: true },
      })
      : [];
    const roomTypeIds = Array.from(new Set(rooms.map((room) => Number(room.room_type_id)).filter((id) => id > 0)));
    const roomTypes = roomTypeIds.length
      ? await (this.prisma as any).dvi_hotel_roomtype.findMany({ where: { room_type_id: { in: roomTypeIds } }, select: { room_type_id: true, room_type_title: true } })
      : [];
    const hotelById = new Map(hotels.map((hotel) => [Number(hotel.hotel_id), hotel]));
    const roomBySelection = new Map<number, any>();
    for (const room of rooms) {
      if (!roomBySelection.has(Number(room.itinerary_plan_hotel_details_id))) roomBySelection.set(Number(room.itinerary_plan_hotel_details_id), room);
    }
    const roomTypeById = new Map<number, any>(roomTypes.map((roomType: any) => [Number(roomType.room_type_id), roomType]));
    return rows.map((row) => ({
      ...this.parseSnapshotFields(row),
      selectionId: row.itinerary_plan_hotel_details_ID,
      itineraryPlanId: row.itinerary_plan_id,
      itineraryQuoteId: null,
      routeId: row.itinerary_route_id,
      hotelId: row.hotel_id,
      hotelName: hotelById.get(Number(row.hotel_id))?.hotel_name || 'Hotel',
      city: hotelById.get(Number(row.hotel_id))?.hotel_city || row.itinerary_route_location || '',
      checkIn: row.hotel_check_in_date,
      checkOut: row.hotel_check_out_date,
      numberOfNights: this.parseSnapshotFields(row).numberOfNights,
      roomType: roomTypeById.get(Number(roomBySelection.get(Number(row.itinerary_plan_hotel_details_ID))?.room_type_id))?.room_type_title || null,
      mealPlan: this.getMealPlan(roomBySelection.get(Number(row.itinerary_plan_hotel_details_ID))),
      roomQuantity: Number(roomBySelection.get(Number(row.itinerary_plan_hotel_details_ID))?.room_qty || row.total_no_of_rooms || 0) || null,
      guestCount: row.total_no_of_persons || null,
      databaseBasePrice: this.parseSnapshotFields(row).databaseBasePrice,
      displayedSellPrice: row.selected_total_price,
      currency: row.selected_currency,
      selectedBy: row.hotel_approval_requested_by,
      selectedAt: row.hotel_approval_requested_at,
      approvalStatus: row.hotel_approval_status,
      manualConfirmationStatus: row.manual_confirmation_status,
      approvalNotes: row.hotel_approval_notes,
    }));
  }

  private parseSnapshotFields(row: any) {
    try {
      const snapshot = row.selected_price_snapshot ? JSON.parse(row.selected_price_snapshot) : {};
      return {
        numberOfNights: snapshot.numberOfNights ?? null,
        databaseBasePrice: snapshot.nightlyRates?.[0]?.baseAmount ?? null,
      };
    } catch {
      return { numberOfNights: null, databaseBasePrice: null };
    }
  }

  private getMealPlan(room: any): string | null {
    if (!room) return null;
    const plans: string[] = [];
    if (Number(room.breakfast_required) === 1) plans.push('Breakfast');
    if (Number(room.lunch_required) === 1) plans.push('Lunch');
    if (Number(room.dinner_required) === 1) plans.push('Dinner');
    return plans.length ? plans.join(' + ') : 'Room only';
  }
}
