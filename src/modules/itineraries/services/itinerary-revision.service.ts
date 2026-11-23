import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ItineraryHotelDetailsResponseDto } from '../itinerary-hotel-details.service';

type RevisionDb = Prisma.TransactionClient;

export type RevisionPriceSnapshot = {
  overallCost: string;
  costBreakdown: Prisma.InputJsonValue;
  hotels: Prisma.InputJsonValue;
};

type DraftRow = Record<string, any>;
type DraftTable = {
  findMany(args: { where: DraftRow; orderBy: DraftRow }): Promise<DraftRow[]>;
  create(args: { data: DraftRow }): Promise<DraftRow>;
  createMany(args: { data: DraftRow[] }): Promise<unknown>;
};

async function copyDraftRows(
  table: unknown,
  primaryKey: string,
  planKey: string,
  sourcePlanId: number,
  targetPlanId: number,
  references: Record<string, Map<number, number>> = {},
  where: DraftRow = {},
  mapIds = false,
) {
  const delegate = table as DraftTable;
  const rows = await delegate.findMany({ where: { [planKey]: sourcePlanId, ...where }, orderBy: { [primaryKey]: 'asc' } });
  const ids = new Map<number, number>();
  const data = rows.map(({ [primaryKey]: sourceId, ...row }) => {
    row[planKey] = targetPlanId;
    for (const [key, idMap] of Object.entries(references)) {
      const oldId = Number(row[key]);
      if (oldId) row[key] = idMap.get(oldId) ?? 0;
    }
    return { sourceId, row };
  });
  if (mapIds) {
    for (const { sourceId, row } of data) {
      const created = await delegate.create({ data: row });
      ids.set(Number(sourceId), Number(created[primaryKey]));
    }
  } else if (data.length) {
    await delegate.createMany({ data: data.map(({ row }) => row) });
  }
  return ids;
}

async function copyDraft(tx: RevisionDb, sourceId: number, targetId: number) {
  const copy = (table: unknown, primaryKey: string, planKey: string, refs?: Record<string, Map<number, number>>, where?: DraftRow, mapIds?: boolean) =>
    copyDraftRows(table, primaryKey, planKey, sourceId, targetId, refs, where, mapIds);
  const routeIds = await copy(tx.dvi_itinerary_route_details, 'itinerary_route_ID', 'itinerary_plan_ID', {}, {}, true);
  const upperRoute = { itinerary_route_ID: routeIds };
  const lowerRoute = { itinerary_route_id: routeIds };
  const hotspotIds = await copy(tx.dvi_itinerary_route_hotspot_details, 'route_hotspot_ID', 'itinerary_plan_ID', upperRoute, {}, true);
  const activityIds = await copy(tx.dvi_itinerary_route_activity_details, 'route_activity_ID', 'itinerary_plan_ID', { ...upperRoute, route_hotspot_ID: hotspotIds }, {}, true);
  const guideIds = await copy(tx.dvi_itinerary_route_guide_details, 'route_guide_ID', 'itinerary_plan_ID', upperRoute, {}, true);
  const vendorIds = await copy(tx.dvi_itinerary_plan_vendor_eligible_list, 'itinerary_plan_vendor_eligible_ID', 'itinerary_plan_id', {}, {}, true);

  await copy(tx.dvi_itinerary_via_route_details, 'itinerary_via_route_ID', 'itinerary_plan_ID', upperRoute);
  await copy(tx.dvi_itinerary_traveller_details, 'traveller_details_ID', 'itinerary_plan_ID');
  await copy(tx.dvi_itinerary_route_hotspot_entry_cost_details, 'hotspot_cost_detail_id', 'itinerary_plan_id', { ...lowerRoute, route_hotspot_id: hotspotIds });
  await copy(tx.dvi_itinerary_route_activity_entry_cost_details, 'activity_cost_detail_id', 'itinerary_plan_id', { ...lowerRoute, route_activity_id: activityIds });
  await copy(tx.dvi_itinerary_route_hotspot_parking_charge, 'itinerary_hotspot_parking_charge_ID', 'itinerary_plan_ID', upperRoute);
  await copy(tx.dvi_itinerary_manual_hotspot_displacement, 'displacement_ID', 'itinerary_plan_ID', upperRoute);
  await copy(tx.dvi_itinerary_route_guide_slot_cost_details, 'guide_slot_cost_details_id', 'itinerary_plan_id', { ...lowerRoute, route_guide_id: guideIds });
  await copy(tx.dvi_itinerary_plan_route_permit_charge, 'route_permit_charge_ID', 'itinerary_plan_ID', upperRoute);
  await copy(tx.dvi_itinerary_plan_vehicle_details, 'vehicle_details_ID', 'itinerary_plan_id');
  await copy(tx.dvi_itinerary_plan_vehicle_vendor_selection, 'itinerary_plan_vehicle_vendor_selection_ID', 'itinerary_plan_id');
  await copy(tx.dvi_itinerary_plan_vendor_vehicle_details, 'itinerary_plan_vendor_vehicle_details_ID', 'itinerary_plan_id', { ...lowerRoute, itinerary_plan_vendor_eligible_ID: vendorIds });
  await copy(tx.dvi_itinerary_plan_hotel_details, 'itinerary_plan_hotel_details_ID', 'itinerary_plan_id', lowerRoute, {
    deleted: 0, OR: [{ selection_origin: 'USER_REMOVED' }, { hotel_required: 2, hotel_id: 0 }],
  });

  const pricing = await tx.dvi_itinerary_agent_pricing.findUnique({ where: { itinerary_plan_ID: sourceId } });
  if (pricing) {
    await tx.dvi_itinerary_agent_pricing.create({ data: { ...pricing, itinerary_plan_ID: targetId, final_selling_price: null } });
  }
  return routeIds;
}

export async function getRevisionSaveState(tx: RevisionDb, sourcePlanId: number) {
  await tx.$queryRaw`SELECT itinerary_plan_ID FROM dvi_itinerary_plan_details WHERE itinerary_plan_ID = ${sourcePlanId} FOR UPDATE`;
  const source = await tx.dvi_itinerary_quote_revision.findUnique({ where: { plan_id: sourcePlanId } });
  if (source && (source.superseded_at || source.status !== 'READY')) {
    throw new ConflictException('This quote is read-only. Open the current revision from Revision History to edit it.');
  }
  const pending = await tx.dvi_itinerary_quote_revision.findFirst({
    where: { parent_plan_id: sourcePlanId, status: { in: ['PENDING', 'FAILED'] } },
  });
  return { source, pending };
}

export async function createPendingItineraryRevision(
  tx: RevisionDb,
  sourcePlanId: number,
  state: Awaited<ReturnType<typeof getRevisionSaveState>>,
  changedBy: number,
  reasons: string[],
  editKey: string,
  capturePrices: (quoteId: string) => Promise<RevisionPriceSnapshot>,
) {
  const { pending, source } = state;
  if (pending && pending.status === 'FAILED' && pending.edit_key !== editKey && !pending.search_run_id) {
    await tx.dvi_itinerary_quote_revision.update({
      where: { plan_id: pending.plan_id },
      data: { status: 'ABANDONED' },
    });
  } else if (pending) {
    if (pending.edit_key !== editKey || pending.status !== 'FAILED') {
      throw new ConflictException('This quote already has a pending revision. Retry the same edit if the hotel search failed.');
    }
    if (!source) throw new ConflictException('The original quote for the pending revision could not be found.');
    const prices = await capturePrices(source.quote_id);
    await tx.dvi_itinerary_quote_revision.update({ where: { plan_id: sourcePlanId }, data: {
      overall_cost: prices.overallCost, frozen_cost_breakdown: prices.costBreakdown, frozen_hotels: prices.hotels,
    } });
    await tx.dvi_itinerary_quote_revision.update({ where: { plan_id: pending.plan_id }, data: { status: 'PENDING' } });
    return { planId: pending.plan_id, quoteId: pending.quote_id, retry: true, routeIds: new Map<number, number>() };
  }

  const plan = await tx.dvi_itinerary_plan_details.findUniqueOrThrow({ where: { itinerary_plan_ID: sourcePlanId } });
  const previousQuoteId = String(plan.itinerary_quote_ID || '').trim();
  if (!previousQuoteId) throw new ConflictException('The saved itinerary needs a quote ID before it can be revised.');
  const confirmed = await tx.dvi_confirmed_itinerary_plan_details.findFirst({
    where: { itinerary_plan_ID: sourcePlanId, deleted: 0 }, select: { itinerary_plan_ID: true },
  });
  if (confirmed) throw new ConflictException('Confirmed itineraries cannot be revised through the draft editor.');

  const originalPlanId = source?.original_plan_id ?? sourcePlanId;
  const originalQuoteId = source ? previousQuoteId.replace(/-V\d+$/, '') : previousQuoteId;
  const latestFamilyRevision = await tx.dvi_itinerary_quote_revision.findFirst({
    where: { original_plan_id: originalPlanId },
    orderBy: { revision_number: 'desc' },
    select: { revision_number: true },
  });
  const revisionNumber = Math.max(
    Number(source?.revision_number ?? 0),
    Number(latestFamilyRevision?.revision_number ?? 0),
  ) + 1;
  const quoteId = `${originalQuoteId}-V${revisionNumber}`;
  const existing = await tx.dvi_itinerary_plan_details.findFirst({ where: { itinerary_quote_ID: quoteId } });
  if (existing) throw new ConflictException(`Quote ${quoteId} already exists.`);
  const prices = await capturePrices(previousQuoteId);
  const frozen = { overall_cost: prices.overallCost, frozen_cost_breakdown: prices.costBreakdown, frozen_hotels: prices.hotels };

  if (source) {
    await tx.dvi_itinerary_quote_revision.update({ where: { plan_id: sourcePlanId }, data: frozen });
  } else {
    await tx.dvi_itinerary_quote_revision.create({ data: {
      plan_id: sourcePlanId, original_plan_id: originalPlanId, revision_number: 0, quote_id: previousQuoteId,
      status: 'READY', reasons: [], changed_by: plan.createdby, changed_at: plan.createdon ?? new Date(), ...frozen,
    } });
  }

  const { itinerary_plan_ID, ...draft } = plan;
  const child = await tx.dvi_itinerary_plan_details.create({ data: {
    ...draft, itinerary_quote_ID: quoteId, quotation_status: 0, createdby: changedBy, createdon: new Date(), updatedon: new Date(),
  } });
  const planId = child.itinerary_plan_ID;
  await tx.dvi_itinerary_quote_revision.create({ data: {
    plan_id: planId, original_plan_id: originalPlanId, parent_plan_id: itinerary_plan_ID, revision_number: revisionNumber,
    quote_id: quoteId, status: 'PENDING', edit_key: editKey, reasons, changed_by: changedBy,
  } });
  const routeIds = await copyDraft(tx, sourcePlanId, planId);
  return { planId, quoteId, retry: false, routeIds };
}

export async function assertRevisionEditable(db: RevisionDb, id: number | string) {
  const revision = await db.dvi_itinerary_quote_revision?.findUnique({
    where: typeof id === 'number' ? { plan_id: id } : { quote_id: id },
    select: { plan_id: true, status: true, superseded_at: true },
  });
  if (revision && (revision.status !== 'READY' || revision.superseded_at)) {
    throw new ConflictException('This quote is read-only. Open the current revision from Revision History to edit it.');
  }
  if (revision && await db.dvi_itinerary_quote_revision.findFirst({
    where: { parent_plan_id: revision.plan_id, status: 'PENDING' }, select: { plan_id: true },
  })) {
    throw new ConflictException('A revision is being saved. Try again when the hotel search finishes.');
  }
}

export async function publishItineraryRevision(
  db: { $transaction: <T>(action: (tx: RevisionDb) => Promise<T>) => Promise<T> },
  planId: number,
  searchRunId: string,
  overallCost: string,
) {
  await db.$transaction(async (tx) => {
    const revision = await tx.dvi_itinerary_quote_revision.findUniqueOrThrow({ where: { plan_id: planId } });
    if (revision.status !== 'PENDING' || !revision.parent_plan_id) {
      throw new ConflictException('The pending itinerary revision is no longer current.');
    }
    const parentId = revision.parent_plan_id;
    await tx.$queryRaw`SELECT itinerary_plan_ID FROM dvi_itinerary_plan_details WHERE itinerary_plan_ID = ${parentId} FOR UPDATE`;
    await tx.dvi_itinerary_quote_revision.update({
      where: { plan_id: parentId, status: 'READY', superseded_at: null }, data: { superseded_at: new Date() },
    });
    await tx.dvi_itinerary_quote_revision.update({
      where: { plan_id: planId, status: 'PENDING' }, data: { status: 'READY', search_run_id: searchRunId, overall_cost: overallCost },
    });
  });
}

export function getFrozenRevisionHotels(
  value: Prisma.JsonValue,
  options: { groupType?: number; itineraryRouteId?: number },
): ItineraryHotelDetailsResponseDto {
  const result = value as unknown as ItineraryHotelDetailsResponseDto;
  if (!options.groupType && !options.itineraryRouteId) return result;
  return {
    ...result,
    hotels: (result.hotels || []).filter((hotel) =>
      (!options.groupType || hotel.groupType === options.groupType) &&
      (!options.itineraryRouteId || hotel.itineraryRouteId === options.itineraryRouteId)),
  };
}
