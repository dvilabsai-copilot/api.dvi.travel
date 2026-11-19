import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicItineraryLinksService } from '../src/modules/public-itinerary-links/public-itinerary-links.service';
import { PublicItineraryReadService } from '../src/modules/public-itinerary-links/public-itinerary-read.service';

test('new links retain the issued property, room, meal and total while legacy links follow the draft', async () => {
  const plan = { itinerary_plan_ID: 1, itinerary_quote_ID: 'QA-ISSUE', quotation_status: 0, agent_id: 0 };
  const links = new Map<string, any>();
  const prisma: any = {
    dvi_itinerary_plan_details: { findFirst: async () => plan },
    dvi_cancelled_itineraries: { findFirst: async () => null },
    dvi_global_settings: { findFirst: async () => null },
    public_itinerary_links: {
      create: async ({ data }: any) => links.set(data.tokenHash, { ...data, id: links.size + 1 }),
      findUnique: async ({ where }: any) => links.get(where.tokenHash),
      update: () => null,
      updateMany: () => null,
    },
    $transaction: async () => [],
  };
  let selected = { hotelName: 'Hotel A', roomType: 'Deluxe', mealPlan: 'CP', selectedTotalPrice: 9000 };
  const read = new PublicItineraryReadService(prisma, {
    getItineraryDetails: async () => ({ nightCount: 1, costBreakdown: { netPayable: selected.selectedTotalPrice + 5000 } }),
  } as any, {
    getHotelDetailsByQuoteId: async () => ({
      hotelTabs: [{ groupType: 1, totalAmount: selected.selectedTotalPrice }],
      hotelSelectionState: [{ groupType: 1, routes: [{ routeId: 1, routeDate: '2027-01-10', selected }] }],
    }),
  } as any);
  const issue = new PublicItineraryLinksService(prisma, { getPlanAccessDecision: async () => ({ exists: true, allowed: true }) } as any, read);
  (issue as any).getConfiguration = () => ({ ttlHours: 72, tokenBytes: 32, baseUrl: 'https://qa.invalid', frontendPath: '/view-itinerary' });
  const first = await issue.createPublicLink({ itineraryPlanId: 1, groupType: 1 });
  const token = new URL(first.url).pathname.split('/').at(-1)!;
  const issued = await read.resolvePublicItinerary(token);
  selected = { hotelName: 'Hotel B', roomType: 'Suite', mealPlan: 'MAP', selectedTotalPrice: 12500 };
  assert.deepEqual(await read.resolvePublicItinerary(token), issued);
  assert.equal(issued.issued, true);
  assert.equal((issued.itinerary as any).hotelGroups[0].hotels[0].hotelName, 'Hotel A');
  assert.equal((issued.itinerary as any).costSummary.netPay, 14000);
  const second = await issue.createPublicLink({ itineraryPlanId: 1, groupType: 1 });
  const secondToken = new URL(second.url).pathname.split('/').at(-1)!;
  const revised = await read.resolvePublicItinerary(secondToken);
  assert.equal((revised.itinerary as any).hotelGroups[0].hotels[0].mealPlan, 'MAP');
  assert.equal((revised.itinerary as any).costSummary.netPay, 17500);
  const legacy = [...links.values()][1];
  legacy.issuedItinerary = null;
  selected = { ...selected, selectedTotalPrice: 13000 };
  const linkedDraft = await read.resolvePublicItinerary(secondToken);
  assert.equal(linkedDraft.issued, false);
  assert.equal((linkedDraft.itinerary as any).costSummary.netPay, 18000);
  legacy.revokedAt = new Date();
  await assert.rejects(() => read.resolvePublicItinerary(secondToken), /expired/);
});
