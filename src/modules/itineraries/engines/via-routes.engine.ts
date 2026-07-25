// FILE: src/modules/itineraries/engines/via-routes.engine.ts

import { Injectable } from '@nestjs/common';
import { CreateRouteDto } from '../dto/create-itinerary.dto';

@Injectable()
export class ViaRoutesEngine {
 /**
   * Rebuild via routes for a plan:
   * 1. Delete all existing via routes for this plan
   * 2. Insert new via routes from routes[].via_routes arrays
 */
  async rebuildViaRoutes(
    tx: any,
    planId: number,
    routes: CreateRouteDto[],
    routeIds: number[],
    userId: number,
  ): Promise<void> {
 // 1. Delete all existing via routes for this plan
    const deletedCount = await tx.dvi_itinerary_via_route_details.updateMany({
      where: {
        itinerary_plan_ID: planId,
      },
      data: {
        deleted: 1,
      },
    });

 // 2. Insert new via routes
    let insertedCount = 0;

    for (let i = 0; i < routes.length; i++) {
      const route = routes[i];
      const routeId = routeIds[i];

 // Skip if no via routes for this route segment
      if (!route.via_routes || route.via_routes.length === 0) {
        continue;
      }

      for (const viaRoute of route.via_routes) {
        await tx.dvi_itinerary_via_route_details.create({
          data: {
            itinerary_plan_ID: planId,
            itinerary_route_ID: routeId,
            itinerary_route_date: new Date(route.itinerary_route_date),
            source_location: route.location_name,
            destination_location: route.next_visiting_location,
            itinerary_via_location_ID: viaRoute.itinerary_via_location_ID,
            itinerary_via_location_name: viaRoute.itinerary_via_location_name,
            createdby: userId,
            createdon: new Date(),
            status: 1,
            deleted: 0,
          },
        });
        insertedCount++;
      }
    }
  }
}
