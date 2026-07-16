import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryDetailsAttractionActivityService } from '../src/modules/itineraries/services/itinerary-details-attraction-activity.service';

test('hydrates attraction activities, masters, and gallery URLs in route order', async () => {
  const service = new ItineraryDetailsAttractionActivityService();
  const calls: string[] = [];
  const prisma = {
    dvi_activity: {
      count: async () => 1,
      findMany: async () => [{ activity_id: 7, activity_title: 'Boat Ride', activity_description: 'Lake tour' }],
    },
    dvi_itinerary_route_activity_details: {
      findMany: async () => [{
        route_activity_ID: 22,
        activity_ID: 7,
        activity_amout: '125.50',
        activity_start_time: '09:00:00',
        activity_end_time: '10:00:00',
        activity_traveling_time: '01:00:00',
      }],
    },
    dvi_activity_image_gallery_details: {
      findMany: async () => {
        calls.push('gallery');
        return [
          { activity_id: 7, activity_image_gallery_name: 'boat.jpg' },
          { activity_id: 7, activity_image_gallery_name: 'lake.jpg' },
        ];
      },
    },
  };

  const result = await service.build({
    prisma,
    planId: 4,
    route: { itinerary_route_ID: 5 },
    routeHotspot: { hotspot_ID: 6, route_hotspot_ID: 8 },
    formatTime: (value) => `time:${value}`,
    formatDuration: (value) => `duration:${value}`,
  });

  assert.equal(calls[0], 'gallery');
  assert.equal(result.hasAvailableActivities, true);
  assert.deepEqual(result.activityList, [{
    id: 22,
    activityId: 7,
    title: 'Boat Ride',
    description: 'Lake tour',
    amount: 125.5,
    startTime: 'time:09:00:00',
    endTime: 'time:10:00:00',
    duration: 'duration:01:00:00',
    image: '/uploads/activity_gallery/boat.jpg',
    galleryImages: [
      '/uploads/activity_gallery/boat.jpg',
      '/uploads/activity_gallery/lake.jpg',
    ],
  }]);
});

test('returns an empty activity projection when no route activities are configured', async () => {
  const service = new ItineraryDetailsAttractionActivityService();
  const prisma = {
    dvi_activity: {
      count: async () => 0,
      findMany: async () => { throw new Error('master query should be skipped'); },
    },
    dvi_itinerary_route_activity_details: { findMany: async () => [] },
    dvi_activity_image_gallery_details: { findMany: async () => { throw new Error('gallery query should be skipped'); } },
  };

  const result = await service.build({
    prisma,
    planId: 4,
    route: { itinerary_route_ID: 5 },
    routeHotspot: { hotspot_ID: 0, route_hotspot_ID: 8 },
    formatTime: String,
    formatDuration: String,
  });

  assert.deepEqual(result, { hasAvailableActivities: false, activityList: [] });
});
