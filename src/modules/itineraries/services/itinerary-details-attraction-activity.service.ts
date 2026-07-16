import { Injectable } from '@nestjs/common';

export interface AttractionActivityProjection {
  hasAvailableActivities: boolean;
  activityList: Array<{
    id: unknown;
    activityId: unknown;
    title: string;
    description: string;
    amount: number;
    startTime: string;
    endTime: string;
    duration: string;
    image: string | null;
    galleryImages: string[];
  }>;
}

@Injectable()
export class ItineraryDetailsAttractionActivityService {
  async build(context: {
    prisma: any;
    planId: number;
    route: any;
    routeHotspot: any;
    formatTime: (value: any) => string;
    formatDuration: (value: any) => string;
  }): Promise<AttractionActivityProjection> {
    const { prisma, planId, route, routeHotspot, formatTime, formatDuration } = context;

    const catalogActivityCount = routeHotspot.hotspot_ID
      ? await prisma.dvi_activity.count({
          where: { hotspot_id: routeHotspot.hotspot_ID as number, deleted: 0, status: 1 },
        })
      : 0;

    const activities = await prisma.dvi_itinerary_route_activity_details.findMany({
      where: {
        itinerary_plan_ID: planId,
        itinerary_route_ID: route.itinerary_route_ID,
        route_hotspot_ID: routeHotspot.route_hotspot_ID,
        hotspot_ID: routeHotspot.hotspot_ID as number,
        deleted: 0,
        status: 1,
      },
      orderBy: { activity_order: 'asc' },
    });

    const activityIds = activities.map((activity: any) => activity.activity_ID).filter((id: any) => id > 0);
    const activityMasters = activityIds.length
      ? await prisma.dvi_activity.findMany({
          where: { activity_id: { in: activityIds }, deleted: 0 },
        })
      : [];
    const activityMap = new Map<number, any>(
      activityMasters.map((activity: any) => [activity.activity_id, activity]),
    );

    const activityGalleryRows = activityIds.length
      ? await prisma.dvi_activity_image_gallery_details.findMany({
          where: { activity_id: { in: activityIds }, deleted: 0 },
          orderBy: { activity_image_gallery_details_id: 'asc' },
          select: { activity_id: true, activity_image_gallery_name: true },
        })
      : [];
    const activityGalleryMap = new Map<number, string[]>();
    for (const galleryRow of activityGalleryRows) {
      const id = galleryRow.activity_id ?? 0;
      const name = (galleryRow.activity_image_gallery_name ?? '').toString().trim();
      if (!name || !id) continue;
      const urls = activityGalleryMap.get(id) ?? [];
      urls.push(`/uploads/activity_gallery/${name}`);
      activityGalleryMap.set(id, urls);
    }

    const activityList = activities.map((activityDetail: any) => {
      const activityMaster = activityMap.get(activityDetail.activity_ID);
      const galleryImages = activityGalleryMap.get(activityDetail.activity_ID) ?? [];
      return {
        id: activityDetail.route_activity_ID,
        activityId: activityDetail.activity_ID,
        title: activityMaster?.activity_title ?? '',
        description: activityMaster?.activity_description ?? '',
        amount: Number(activityDetail.activity_amout || 0),
        startTime: formatTime(activityDetail.activity_start_time as any),
        endTime: formatTime(activityDetail.activity_end_time as any),
        duration: formatDuration(activityDetail.activity_traveling_time as any),
        image: galleryImages[0] ?? null,
        galleryImages,
      };
    });

    return { hasAvailableActivities: catalogActivityCount > 0, activityList };
  }
}
