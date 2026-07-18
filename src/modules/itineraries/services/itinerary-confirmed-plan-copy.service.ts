// FILE: src/modules/itineraries/services/itinerary-confirmed-plan-copy.service.ts

import { Injectable } from '@nestjs/common';

@Injectable()
export class ItineraryConfirmedPlanCopyService {
  async copyDraftToConfirmed(
    tx: any,
    draftPlanId: number,
    confirmedPlanId: number,
    userId: number,
    options: {
      copyHotels?: boolean;
      hotelGroupType?: number;
      selectedHotelRouteIds?: number[];
    } = {},
  ) {
    // 2. Vehicles
    const vehicles = await tx.dvi_itinerary_plan_vehicle_details.findMany({
      where: { itinerary_plan_id: draftPlanId, deleted: 0 },
    });
    for (const v of vehicles) {
      await tx.dvi_confirmed_itinerary_plan_vehicle_details.create({
        data: {
          vehicle_details_ID: v.vehicle_details_ID,
          itinerary_plan_id: draftPlanId,
          vehicle_type_id: v.vehicle_type_id,
          vehicle_count: v.vehicle_count,
          createdby: userId,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });
    }

    // 3. Routes
    const routes = await tx.dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: draftPlanId, deleted: 0 },
    });
    for (const r of routes) {
      await tx.dvi_confirmed_itinerary_route_details.create({
        data: {
          itinerary_route_ID: r.itinerary_route_ID,
          itinerary_plan_ID: draftPlanId,
          location_id: r.location_id,
          location_name: r.location_name,
          itinerary_route_date: r.itinerary_route_date,
          no_of_days: r.no_of_days,
          no_of_km: r.no_of_km,
          direct_to_next_visiting_place: r.direct_to_next_visiting_place,
          next_visiting_location: r.next_visiting_location,
          route_start_time: r.route_start_time,
          route_end_time: r.route_end_time,
          createdby: userId,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });
    }

    // 4. Via Routes
    const viaRoutes = await tx.dvi_itinerary_via_route_details.findMany({
      where: { itinerary_plan_ID: draftPlanId, deleted: 0 },
    });
    for (const vr of viaRoutes) {
      await tx.dvi_confirmed_itinerary_via_route_details.create({
        data: {
          itinerary_via_route_ID: vr.itinerary_via_route_ID,
          itinerary_route_ID: vr.itinerary_route_ID,
          itinerary_route_date: vr.itinerary_route_date,
          itinerary_plan_ID: draftPlanId,
          source_location: vr.source_location,
          destination_location: vr.destination_location,
          itinerary_via_location_ID: vr.itinerary_via_location_ID,
          itinerary_via_location_name: vr.itinerary_via_location_name,
          itinerary_session_id: vr.itinerary_session_id,
          createdby: userId,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });
    }

    if (options.copyHotels !== false) {
      // 5. Hotels
      const hotelWhere: any = {
        itinerary_plan_id: draftPlanId,
        hotel_required: { not: 2 },
        deleted: 0,
        status: 1,
      };

      if (Number(options.hotelGroupType || 0) > 0) {
        hotelWhere.group_type = Number(options.hotelGroupType);
      }

      if ((options.selectedHotelRouteIds || []).length > 0) {
        hotelWhere.itinerary_route_id = {
          in: options.selectedHotelRouteIds,
        };
      }

      const hotels = await tx.dvi_itinerary_plan_hotel_details.findMany({
        where: hotelWhere,
      });
      const confirmedHotelIdByDraftHotelId = new Map<number, number>();
      for (const h of hotels) {
        const confirmedHotel = await tx.dvi_confirmed_itinerary_plan_hotel_details.create({
          data: {
            itinerary_plan_hotel_details_ID: h.itinerary_plan_hotel_details_ID,
            group_type: h.group_type,
            itinerary_plan_id: draftPlanId,
            itinerary_route_id: h.itinerary_route_id,
            itinerary_route_date: h.itinerary_route_date,
            itinerary_route_location: h.itinerary_route_location,
            hotel_required: h.hotel_required,
            hotel_category_id: h.hotel_category_id,
            hotel_id: h.hotel_id,
            hotel_margin_percentage: h.hotel_margin_percentage,
            hotel_margin_gst_type: h.hotel_margin_gst_type,
            hotel_margin_gst_percentage: h.hotel_margin_gst_percentage,
            hotel_margin_rate: h.hotel_margin_rate,
            hotel_margin_rate_tax_amt: h.hotel_margin_rate_tax_amt,
            hotel_breakfast_cost: h.hotel_breakfast_cost,
            hotel_breakfast_cost_gst_amount: h.hotel_breakfast_cost_gst_amount,
            hotel_lunch_cost: h.hotel_lunch_cost,
            hotel_lunch_cost_gst_amount: h.hotel_lunch_cost_gst_amount,
            hotel_dinner_cost: h.hotel_dinner_cost,
            hotel_dinner_cost_gst_amount: h.hotel_dinner_cost_gst_amount,
            total_no_of_persons: h.total_no_of_persons,
            total_hotel_meal_plan_cost: h.total_hotel_meal_plan_cost,
            total_hotel_meal_plan_cost_gst_amount: h.total_hotel_meal_plan_cost_gst_amount,
            total_extra_bed_cost: h.total_extra_bed_cost,
            total_extra_bed_cost_gst_amount: h.total_extra_bed_cost_gst_amount,
            total_childwith_bed_cost: h.total_childwith_bed_cost,
            total_childwith_bed_cost_gst_amount: h.total_childwith_bed_cost_gst_amount,
            total_childwithout_bed_cost: h.total_childwithout_bed_cost,
            total_childwithout_bed_cost_gst_amount: h.total_childwithout_bed_cost_gst_amount,
            total_no_of_rooms: h.total_no_of_rooms,
            total_room_cost: h.total_room_cost,
            total_room_gst_amount: h.total_room_gst_amount,
            total_hotel_cost: h.total_hotel_cost,
            total_amenities_cost: h.total_amenities_cost,
            total_amenities_gst_amount: h.total_amenities_gst_amount,
            total_hotel_tax_amount: h.total_hotel_tax_amount,
            hotel_code: h.hotel_code,
            hotel_check_in_date: h.hotel_check_in_date,
            actual_guest_arrival_at: h.actual_guest_arrival_at,
            hotel_check_out_date: h.hotel_check_out_date,
            early_checkin: h.early_checkin,
            early_checkin_extra_payment_applicable:
              h.early_checkin_extra_payment_applicable,
            early_checkin_payment_status: h.early_checkin_payment_status,
            early_checkin_note: h.early_checkin_note,
          },
        });

        confirmedHotelIdByDraftHotelId.set(
          Number(h.itinerary_plan_hotel_details_ID || 0),
          Number(confirmedHotel.confirmed_itinerary_plan_hotel_details_ID || 0),
        );
      }

      // 5a. Hotel Room Details
      const selectedConfirmedHotelRouteIds = Array.from(
        new Set(hotels.map((h) => Number(h.itinerary_route_id || 0)).filter((id) => id > 0)),
      );

      const hotelRooms = selectedConfirmedHotelRouteIds.length > 0
        ? await tx.dvi_itinerary_plan_hotel_room_details.findMany({
            where: {
              itinerary_plan_id: draftPlanId,
              deleted: 0,
              ...(Number(options.hotelGroupType || 0) > 0
                ? { group_type: Number(options.hotelGroupType) }
                : {}),
              itinerary_route_id: {
                in: selectedConfirmedHotelRouteIds,
              },
            } as any,
          })
        : [];
      for (const hr of hotelRooms) {
        await tx.dvi_confirmed_itinerary_plan_hotel_room_details.create({
          data: {
            itinerary_plan_hotel_room_details_ID: hr.itinerary_plan_hotel_room_details_ID,
            itinerary_plan_hotel_details_id: hr.itinerary_plan_hotel_details_id,
            confirmed_itinerary_plan_hotel_details_id:
              confirmedHotelIdByDraftHotelId.get(Number(hr.itinerary_plan_hotel_details_id || 0)) || 0,
            group_type: hr.group_type,
            itinerary_plan_id: draftPlanId,
            itinerary_route_id: hr.itinerary_route_id,
            itinerary_route_date: hr.itinerary_route_date,
            hotel_id: hr.hotel_id,
            room_type_id: hr.room_type_id,
            room_id: hr.room_id,
            room_qty: hr.room_qty,
            room_rate: hr.room_rate,
            gst_type: hr.gst_type,
            gst_percentage: hr.gst_percentage,
            extra_bed_count: hr.extra_bed_count,
            extra_bed_rate: hr.extra_bed_rate,
            child_without_bed_count: hr.child_without_bed_count,
            child_without_bed_charges: hr.child_without_bed_charges,
            child_with_bed_count: hr.child_with_bed_count,
            child_with_bed_charges: hr.child_with_bed_charges,
            breakfast_required: hr.breakfast_required,
            lunch_required: hr.lunch_required,
            dinner_required: hr.dinner_required,
            breakfast_cost_per_person: hr.breakfast_cost_per_person,
            lunch_cost_per_person: hr.lunch_cost_per_person,
            dinner_cost_per_person: hr.dinner_cost_per_person,
            total_breafast_cost: hr.total_breafast_cost,
            total_lunch_cost: hr.total_lunch_cost,
            total_dinner_cost: hr.total_dinner_cost,
            total_room_cost: hr.total_room_cost,
            total_room_gst_amount: hr.total_room_gst_amount,
            createdby: userId,
            createdon: new Date(),
            status: 1,
            deleted: 0,
          },
        });
      }

      // 5b. Hotel Room Amenities
      const hotelAmenities = selectedConfirmedHotelRouteIds.length > 0
        ? await tx.dvi_itinerary_plan_hotel_room_amenities.findMany({
            where: {
              itinerary_plan_id: draftPlanId,
              deleted: 0,
              ...(Number(options.hotelGroupType || 0) > 0
                ? { group_type: Number(options.hotelGroupType) }
                : {}),
              itinerary_route_id: {
                in: selectedConfirmedHotelRouteIds,
              },
            } as any,
          })
        : [];
      for (const ha of hotelAmenities) {
        await tx.dvi_confirmed_itinerary_plan_hotel_room_amenities.create({
          data: {
            itinerary_plan_hotel_room_amenities_details_ID: ha.itinerary_plan_hotel_room_amenities_details_ID,
            itinerary_plan_hotel_details_id: ha.itinerary_plan_hotel_details_id,
            confirmed_itinerary_plan_hotel_details_id:
              confirmedHotelIdByDraftHotelId.get(Number(ha.itinerary_plan_hotel_details_id || 0)) || 0,
            group_type: ha.group_type,
            itinerary_plan_id: draftPlanId,
            itinerary_route_id: ha.itinerary_route_id,
            itinerary_route_date: ha.itinerary_route_date,
            hotel_id: ha.hotel_id,
            hotel_amenities_id: ha.hotel_amenities_id,
            total_qty: ha.total_qty,
            amenitie_rate: ha.amenitie_rate,
            total_amenitie_cost: ha.total_amenitie_cost,
            total_amenitie_gst_amount: ha.total_amenitie_gst_amount,
            createdby: userId,
            createdon: new Date(),
            status: 1,
            deleted: 0,
          },
        });
      }
    }

    // 6. Hotspots
    const hotspots = await tx.dvi_itinerary_route_hotspot_details.findMany({
      where: { itinerary_plan_ID: draftPlanId, deleted: 0 },
    });
    for (const hs of hotspots) {
      await tx.dvi_confirmed_itinerary_route_hotspot_details.create({
        data: {
          route_hotspot_ID: hs.route_hotspot_ID,
          itinerary_plan_ID: draftPlanId,
          itinerary_route_ID: hs.itinerary_route_ID,
          item_type: hs.item_type,
          hotspot_order: hs.hotspot_order,
          hotspot_ID: hs.hotspot_ID,
          hotspot_adult_entry_cost: hs.hotspot_adult_entry_cost,
          hotspot_child_entry_cost: hs.hotspot_child_entry_cost,
          hotspot_infant_entry_cost: hs.hotspot_infant_entry_cost,
          hotspot_foreign_adult_entry_cost: hs.hotspot_foreign_adult_entry_cost,
          hotspot_foreign_child_entry_cost: hs.hotspot_foreign_child_entry_cost,
          hotspot_foreign_infant_entry_cost: hs.hotspot_foreign_infant_entry_cost,
          hotspot_amout: hs.hotspot_amout,
          hotspot_traveling_time: hs.hotspot_traveling_time,
          itinerary_travel_type_buffer_time: hs.itinerary_travel_type_buffer_time,
          hotspot_travelling_distance: hs.hotspot_travelling_distance,
          hotspot_start_time: hs.hotspot_start_time,
          hotspot_end_time: hs.hotspot_end_time,
          allow_break_hours: hs.allow_break_hours,
          allow_via_route: hs.allow_via_route,
          via_location_name: hs.via_location_name,
          hotspot_plan_own_way: hs.hotspot_plan_own_way,
          createdby: userId,
          status: 1,
        },
      });
    }

    // 7. Activities
    const activities = await tx.dvi_itinerary_route_activity_details.findMany({
      where: { itinerary_plan_ID: draftPlanId, deleted: 0 },
    });
    for (const a of activities) {
      await tx.dvi_confirmed_itinerary_route_activity_details.create({
        data: {
          route_activity_ID: a.route_activity_ID,
          itinerary_plan_ID: draftPlanId,
          itinerary_route_ID: a.itinerary_route_ID,
          route_hotspot_ID: a.route_hotspot_ID,
          hotspot_ID: a.hotspot_ID,
          activity_ID: a.activity_ID,
          activity_order: a.activity_order,
          activity_charges_for_foreign_adult: a.activity_charges_for_foreign_adult,
          activity_charges_for_foreign_children: a.activity_charges_for_foreign_children,
          activity_charges_for_foreign_infant: a.activity_charges_for_foreign_infant,
          activity_charges_for_adult: a.activity_charges_for_adult,
          activity_charges_for_children: a.activity_charges_for_children,
          activity_charges_for_infant: a.activity_charges_for_infant,
          activity_amout: a.activity_amout,
          activity_traveling_time: a.activity_traveling_time,
          activity_start_time: a.activity_start_time,
          activity_end_time: a.activity_end_time,
          createdby: userId,
          status: 1,
        },
      });
    }

    // 8. Guides
    const guides = await tx.dvi_itinerary_route_guide_details.findMany({
      where: { itinerary_plan_ID: draftPlanId, deleted: 0 },
    });
    for (const g of guides) {
      await tx.dvi_confirmed_itinerary_route_guide_details.create({
        data: {
          route_guide_ID: g.route_guide_ID,
          itinerary_plan_ID: draftPlanId,
          itinerary_route_ID: g.itinerary_route_ID,
          guide_id: g.guide_id,
          guide_type: g.guide_type,
          guide_language: g.guide_language,
          guide_slot: g.guide_slot,
          guide_cost: g.guide_cost,
          createdby: userId,
          status: 1,
        },
      });
    }

    const guideSlotCosts = await tx.dvi_itinerary_route_guide_slot_cost_details.findMany({
      where: { itinerary_plan_id: draftPlanId, deleted: 0 },
    });
    for (const slotCost of guideSlotCosts) {
      await tx.dvi_confirmed_itinerary_route_guide_slot_cost_details.create({
        data: {
          guide_slot_cost_details_id: Number(slotCost.guide_slot_cost_details_id || 0),
          route_guide_id: Number(slotCost.route_guide_id || 0),
          itinerary_plan_id: draftPlanId,
          itinerary_route_id: Number(slotCost.itinerary_route_id || 0),
          itinerary_route_date: slotCost.itinerary_route_date,
          guide_id: Number(slotCost.guide_id || 0),
          guide_type: Number(slotCost.guide_type || 0),
          guide_slot: Number(slotCost.guide_slot || 0),
          guide_slot_cost: Number(slotCost.guide_slot_cost || 0),
          cancellation_status: 0,
          cancellation_defect_type: 0,
          createdby: userId,
          status: 1,
        },
      });
    }

    // 9. Vendor Eligible List
    const vendorEligible = await tx.dvi_itinerary_plan_vendor_eligible_list.findMany({
      where: { itinerary_plan_id: draftPlanId, deleted: 0 },
    });
    for (const ve of vendorEligible) {
      await tx.dvi_confirmed_itinerary_plan_vendor_eligible_list.create({
        data: {
          itinerary_plan_vendor_eligible_ID: ve.itinerary_plan_vendor_eligible_ID,
          itineary_plan_assigned_status: ve.itineary_plan_assigned_status,
          itinerary_plan_id: draftPlanId,
          vehicle_type_id: ve.vehicle_type_id,
          total_vehicle_qty: ve.total_vehicle_qty,
          vendor_id: ve.vendor_id,
          outstation_allowed_km_per_day: ve.outstation_allowed_km_per_day,
          vendor_vehicle_type_id: ve.vendor_vehicle_type_id,
          vehicle_id: ve.vehicle_id,
          vendor_branch_id: ve.vendor_branch_id,
          vehicle_orign: ve.vehicle_orign,
          vehicle_count: ve.vehicle_count,
          total_kms: ve.total_kms,
          total_outstation_km: ve.total_outstation_km,
          total_time: ve.total_time,
          total_rental_charges: ve.total_rental_charges,
          total_toll_charges: ve.total_toll_charges,
          total_parking_charges: ve.total_parking_charges,
          total_driver_charges: ve.total_driver_charges,
          total_permit_charges: ve.total_permit_charges,
          total_before_6_am_extra_time: ve.total_before_6_am_extra_time,
          total_after_8_pm_extra_time: ve.total_after_8_pm_extra_time,
          total_before_6_am_charges_for_driver: ve.total_before_6_am_charges_for_driver,
          total_before_6_am_charges_for_vehicle: ve.total_before_6_am_charges_for_vehicle,
          total_after_8_pm_charges_for_driver: ve.total_after_8_pm_charges_for_driver,
          total_after_8_pm_charges_for_vehicle: ve.total_after_8_pm_charges_for_vehicle,
          extra_km_rate: ve.extra_km_rate,
          total_allowed_kms: ve.total_allowed_kms,
          total_extra_kms: ve.total_extra_kms,
          total_extra_kms_charge: ve.total_extra_kms_charge,
          total_allowed_local_kms: ve.total_allowed_local_kms,
          total_extra_local_kms: ve.total_extra_local_kms,
          total_extra_local_kms_charge: ve.total_extra_local_kms_charge,
          vehicle_gst_type: ve.vehicle_gst_type,
          vehicle_gst_percentage: ve.vehicle_gst_percentage,
          vehicle_gst_amount: ve.vehicle_gst_amount,
          vehicle_total_amount: ve.vehicle_total_amount,
          vendor_margin_percentage: ve.vendor_margin_percentage,
          vendor_margin_gst_type: ve.vendor_margin_gst_type,
          vendor_margin_gst_percentage: ve.vendor_margin_gst_percentage,
          vendor_margin_amount: ve.vendor_margin_amount,
          vendor_margin_gst_amount: ve.vendor_margin_gst_amount,
          vehicle_grand_total: ve.vehicle_grand_total,
          createdby: userId,
          status: 1,
        },
      });
    }

    // 10. Vendor Vehicle Details
    const vendorVehicleDetails = await tx.dvi_itinerary_plan_vendor_vehicle_details.findMany({
      where: { itinerary_plan_id: draftPlanId, deleted: 0 },
    });
    for (const vvd of vendorVehicleDetails) {
      await tx.dvi_confirmed_itinerary_plan_vendor_vehicle_details.create({
        data: {
          itinerary_plan_vendor_vehicle_details_ID: vvd.itinerary_plan_vendor_vehicle_details_ID,
          itinerary_plan_vendor_eligible_ID: vvd.itinerary_plan_vendor_eligible_ID,
          itinerary_plan_id: draftPlanId,
          itinerary_route_id: vvd.itinerary_route_id,
          itinerary_route_date: vvd.itinerary_route_date,
          vehicle_type_id: vvd.vehicle_type_id,
          vehicle_qty: vvd.vehicle_qty,
          vendor_id: vvd.vendor_id,
          vendor_vehicle_type_id: vvd.vendor_vehicle_type_id,
          vehicle_id: vvd.vehicle_id,
          vendor_branch_id: vvd.vendor_branch_id,
          time_limit_id: vvd.time_limit_id,
          travel_type: vvd.travel_type,
          itinerary_route_location_from: vvd.itinerary_route_location_from,
          itinerary_route_location_to: vvd.itinerary_route_location_to,
          total_running_km: vvd.total_running_km,
          total_running_time: vvd.total_running_time,
          total_siteseeing_km: vvd.total_siteseeing_km,
          total_siteseeing_time: vvd.total_siteseeing_time,
          total_pickup_km: vvd.total_pickup_km,
          total_pickup_duration: vvd.total_pickup_duration,
          total_drop_km: vvd.total_drop_km,
          total_drop_duration: vvd.total_drop_duration,
          total_extra_km: vvd.total_extra_km,
          extra_km_rate: vvd.extra_km_rate,
          total_extra_km_charges: vvd.total_extra_km_charges,
          total_travelled_km: vvd.total_travelled_km,
          total_travelled_time: vvd.total_travelled_time,
          vehicle_rental_charges: vvd.vehicle_rental_charges,
          vehicle_toll_charges: vvd.vehicle_toll_charges,
          vehicle_parking_charges: vvd.vehicle_parking_charges,
          vehicle_driver_charges: vvd.vehicle_driver_charges,
          vehicle_permit_charges: vvd.vehicle_permit_charges,
          before_6_am_extra_time: vvd.before_6_am_extra_time,
          after_8_pm_extra_time: vvd.after_8_pm_extra_time,
          before_6_am_charges_for_driver: vvd.before_6_am_charges_for_driver,
          before_6_am_charges_for_vehicle: vvd.before_6_am_charges_for_vehicle,
          after_8_pm_charges_for_driver: vvd.after_8_pm_charges_for_driver,
          after_8_pm_charges_for_vehicle: vvd.after_8_pm_charges_for_vehicle,
          total_vehicle_amount: vvd.total_vehicle_amount,
          createdby: userId,
          status: 1,
        },
      });
    }

    // 11. Route Permit Charges
    const permitCharges = await tx.dvi_itinerary_plan_route_permit_charge.findMany({
      where: { itinerary_plan_ID: draftPlanId, status: 1, deleted: 0 },
    });
    for (const pc of permitCharges) {
      await tx.dvi_confirmed_itinerary_plan_route_permit_charge.create({
        data: {
          // cnf_itinerary_route_permit_charge_ID is auto-increment, don't set it manually
          route_permit_charge_ID: pc.route_permit_charge_ID,
          itinerary_plan_ID: draftPlanId,
          itinerary_route_ID: pc.itinerary_route_ID,
          itinerary_route_date: pc.itinerary_route_date,
          vendor_id: pc.vendor_id,
          vendor_branch_id: pc.vendor_branch_id,
          vendor_vehicle_type_id: pc.vendor_vehicle_type_id,
          source_state_id: pc.source_state_id,
          destination_state_id: pc.destination_state_id,
          permit_cost: pc.permit_cost,
          createdby: userId,
          status: 1,
        },
      });
    }
  }

}
