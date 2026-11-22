
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { CreateVehicleDto } from "../dto/create-itinerary.dto";

type Tx = Prisma.TransactionClient;

@Injectable()
export class VehiclesEngineService {
  async rebuildPlanVehicles(
    planId: number,
    vehicles: CreateVehicleDto[],
    tx: Tx,
    userId: number,
    affectedVehicleTypeIds?: number[],
  ) {
    const scopedRebuild = affectedVehicleTypeIds !== undefined;

    const affectedTypes = scopedRebuild
      ? [...new Set(affectedVehicleTypeIds)].filter(
          (id) => Number.isSafeInteger(id) && id > 0,
        )
      : [];

    if (scopedRebuild && affectedTypes.length === 0) {
      throw new Error("Vehicle upgrade scope cannot be empty.");
    }

    const where = scopedRebuild
      ? {
          itinerary_plan_id: planId,
          vehicle_type_id: { in: affectedTypes },
        }
      : {
          itinerary_plan_id: planId,
        };

    await (tx as any).dvi_itinerary_plan_vehicle_details.deleteMany({
      where,
    });

    const rows = (vehicles || [])
      .filter(
        (v) =>
          !scopedRebuild ||
          affectedTypes.includes(Number(v.vehicle_type_id)),
      )
      .map((v) => ({
        itinerary_plan_id: planId,
        vehicle_type_id: v.vehicle_type_id,
        vehicle_count: v.vehicle_count,
        createdby: userId,
        createdon: new Date(),
        updatedon: null,
        status: 1,
        deleted: 0,
      }));

    if (rows.length) {
      await (tx as any).dvi_itinerary_plan_vehicle_details.createMany({
        data: rows,
      });
    }
  }
}
