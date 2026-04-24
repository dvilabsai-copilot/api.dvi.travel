// REPLACE-WHOLE-FILE
// FILE: src/itineraries/engines/travellers-engine.service.ts

import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { CreateTravellerDto } from "../dto/create-itinerary.dto";

type Tx = Prisma.TransactionClient;

@Injectable()
export class TravellersEngineService {
  async rebuildTravellers(
    planId: number,
    travellers: CreateTravellerDto[],
    tx: Tx,
    userId: number,
  ) {
    await (tx as any).dvi_itinerary_traveller_details.deleteMany({
      where: { itinerary_plan_ID: planId },
    });

    const rows = (travellers || []).map((t, idx) => ({
      itinerary_plan_ID: planId,
      traveller_type: t.traveller_type,
      room_id: t.room_id,
      traveller_age: t.traveller_age ?? null,
      child_bed_type: Number(t.child_bed_type ?? 0),
      createdby: userId,
      createdon: new Date(),
      updatedon: idx === 0 ? new Date() : null,
      status: 1,
      deleted: 0,
    }));

    if (rows.length) {
      await (tx as any).dvi_itinerary_traveller_details.createMany({
        data: rows,
      });
    }
  }
}
