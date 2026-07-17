import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';

/** Owns confirmed itinerary pluck-card and invoice presentation reads. */
@Injectable()
export class ItineraryInvoiceReadService {
  constructor(private readonly prisma: PrismaService) {}
    private buildPluckCardData(plan: any, customer: any, settings: any) {
      return {
        guestName: customer
          ? `${String(customer.customer_salutation || '').trim()} ${String(customer.customer_name || '').trim()}`.trim()
          : 'N/A',
        contactNo: String(customer?.primary_contact_no || 'N/A'),
        arrivalLocation: String(customer?.arrival_place || plan?.arrival_location || ''),
        arrivalDateTime: customer?.arrival_date_and_time || plan?.trip_start_date_and_time || null,
        arrivalFlightDetails: String(customer?.arrival_flight_details || ''),
        departureLocation: String(customer?.departure_place || plan?.departure_location || ''),
        departureDateTime: customer?.departure_date_and_time || plan?.trip_end_date_and_time || null,
        departureFlightDetails: String(customer?.departure_flight_details || ''),
        companyName: String(settings?.company_name || 'DVI'),
        companyLogoUrl: settings?.company_logo ? `/uploads/logo/${String(settings.company_logo)}` : '',
      };
    }

    private getStateNameFromGstCode(gstNo?: string | null): string {
      const code = String(gstNo || '').trim().slice(0, 2);
      const labels: Record<string, string> = {
        '01': 'Jammu and Kashmir',
        '02': 'Himachal Pradesh',
        '03': 'Punjab',
        '04': 'Chandigarh',
        '05': 'Uttarakhand',
        '06': 'Haryana',
        '07': 'Delhi',
        '08': 'Rajasthan',
        '09': 'Uttar Pradesh',
        '10': 'Bihar',
        '11': 'Sikkim',
        '12': 'Arunachal Pradesh',
        '13': 'Nagaland',
        '14': 'Manipur',
        '15': 'Mizoram',
        '16': 'Tripura',
        '17': 'Meghalaya',
        '18': 'Assam',
        '19': 'West Bengal',
        '20': 'Jharkhand',
        '21': 'Odisha',
        '22': 'Chhattisgarh',
        '23': 'Madhya Pradesh',
        '24': 'Gujarat',
        '26': 'Dadra and Nagar Haveli and Daman and Diu',
        '27': 'Maharashtra',
        '28': 'Andhra Pradesh',
        '29': 'Karnataka',
        '30': 'Goa',
        '31': 'Lakshadweep',
        '32': 'Kerala',
        '33': 'Tamil Nadu',
        '34': 'Puducherry',
        '35': 'Andaman and Nicobar Islands',
        '36': 'Telangana',
        '37': 'Andhra Pradesh',
        '38': 'Ladakh',
      };
      return labels[code] || '';
    }

    async getPluckCardData(itineraryPlanId: number) {
      const [plan, customer, settings] = await Promise.all([
        this.prisma.dvi_confirmed_itinerary_plan_details.findFirst({
          where: { itinerary_plan_ID: itineraryPlanId, deleted: 0 },
        }),
        this.prisma.dvi_confirmed_itinerary_customer_details.findFirst({
          where: { itinerary_plan_ID: itineraryPlanId, primary_customer: 1, deleted: 0 },
        }),
        this.prisma.dvi_global_settings.findFirst({
          where: { status: 1, deleted: 0 },
        }),
      ]);

      if (!plan) {
        throw new NotFoundException('Confirmed itinerary plan not found');
      }

      return this.buildPluckCardData(plan, customer, settings);
    }
  
    async getPluckCardDataByConfirmedId(confirmedPlanId: number) {
      const [plan, customer, settings] = await Promise.all([
        this.prisma.dvi_confirmed_itinerary_plan_details.findUnique({
          where: { confirmed_itinerary_plan_ID: confirmedPlanId },
        }),
        this.prisma.dvi_confirmed_itinerary_customer_details.findFirst({
          where: { confirmed_itinerary_plan_ID: confirmedPlanId, primary_customer: 1, deleted: 0 },
        }),
        this.prisma.dvi_global_settings.findFirst({
          where: { status: 1, deleted: 0 },
        }),
      ]);

      if (!plan) {
        throw new NotFoundException('Confirmed itinerary plan not found');
      }

      return this.buildPluckCardData(plan, customer, settings);
    }
  
    async getInvoiceData(itineraryPlanId: number) {
      const plan = await this.prisma.dvi_confirmed_itinerary_plan_details.findFirst({
        where: { itinerary_plan_ID: itineraryPlanId, deleted: 0 },
      });
  
      if (!plan) {
        throw new NotFoundException('Confirmed itinerary plan not found');
      }

      const [
        agent,
        agentConfig,
        customer,
        settings,
        accounts,
        hotels,
        vehicles,
        activities,
        guides,
        hotspots,
        travelExpert,
      ] = await Promise.all([
        this.prisma.dvi_agent.findUnique({
          where: { agent_ID: plan.agent_id },
        }),
        this.prisma.dvi_agent_configuration.findFirst({
          where: { agent_id: plan.agent_id, deleted: 0, status: 1 },
        }),
        this.prisma.dvi_confirmed_itinerary_customer_details.findFirst({
          where: { itinerary_plan_ID: itineraryPlanId, primary_customer: 1, deleted: 0 },
        }),
        this.prisma.dvi_global_settings.findFirst({
          where: { status: 1, deleted: 0 },
        }),
        this.prisma.dvi_accounts_itinerary_details.findFirst({
          where: { itinerary_plan_ID: itineraryPlanId, deleted: 0 },
        }),
        this.prisma.dvi_confirmed_itinerary_plan_hotel_details.findMany({
          where: { itinerary_plan_id: itineraryPlanId, deleted: 0, status: 1 },
          orderBy: [{ itinerary_route_date: 'asc' }, { confirmed_itinerary_plan_hotel_details_ID: 'asc' }],
        }),
        this.prisma.dvi_confirmed_itinerary_plan_vendor_eligible_list.findMany({
          where: { itinerary_plan_id: itineraryPlanId, deleted: 0, status: 1, itineary_plan_assigned_status: 1 },
          orderBy: [{ confirmed_itinerary_plan_vendor_eligible_ID: 'asc' }],
        }),
        this.prisma.dvi_accounts_itinerary_activity_details.findMany({
          where: { itinerary_plan_ID: itineraryPlanId, deleted: 0, status: 1 },
        }),
        this.prisma.dvi_accounts_itinerary_guide_details.findMany({
          where: { itinerary_plan_ID: itineraryPlanId, deleted: 0, status: 1 },
        }),
        this.prisma.dvi_accounts_itinerary_hotspot_details.findMany({
          where: { itinerary_plan_ID: itineraryPlanId, deleted: 0, status: 1 },
        }),
        plan.agent_id
          ? (async () => {
              const currentAgent = await this.prisma.dvi_agent.findUnique({
                where: { agent_ID: plan.agent_id },
                select: { travel_expert_id: true },
              });
              if (!currentAgent?.travel_expert_id) return null;
              return this.prisma.dvi_staff_details.findFirst({
                where: { staff_id: currentAgent.travel_expert_id, deleted: 0 },
              });
            })()
          : Promise.resolve(null),
      ]);

      const hotelIds = Array.from(new Set(hotels.map((row: any) => Number(row.hotel_id || 0)).filter((id) => id > 0)));
      const vendorIds = Array.from(new Set(vehicles.map((row: any) => Number(row.vendor_id || 0)).filter((id) => id > 0)));
      const vehicleTypeIds = Array.from(
        new Set(vehicles.map((row: any) => Number(row.vehicle_type_id || 0)).filter((id) => id > 0)),
      );

      const [hotelMasters, vendorMasters, vehicleTypeMasters] = await Promise.all([
        hotelIds.length
          ? this.prisma.dvi_hotel.findMany({
              where: { hotel_id: { in: hotelIds } as any },
              select: { hotel_id: true, hotel_name: true },
            })
          : Promise.resolve([] as any[]),
        vendorIds.length
          ? this.prisma.dvi_vendor_details.findMany({
              where: { vendor_id: { in: vendorIds } as any },
              select: { vendor_id: true, vendor_name: true },
            })
          : Promise.resolve([] as any[]),
        vehicleTypeIds.length
          ? this.prisma.dvi_vehicle_type.findMany({
              where: { vehicle_type_id: { in: vehicleTypeIds } as any },
              select: { vehicle_type_id: true, vehicle_type_title: true },
            })
          : Promise.resolve([] as any[]),
      ]);

      const hotelNameById = new Map<number, string>();
      hotelMasters.forEach((row: any) => hotelNameById.set(Number(row.hotel_id), String(row.hotel_name || 'Hotel')));
      const vendorNameById = new Map<number, string>();
      vendorMasters.forEach((row: any) => vendorNameById.set(Number(row.vendor_id), String(row.vendor_name || 'Vendor')));
      const vehicleTypeById = new Map<number, string>();
      vehicleTypeMasters.forEach((row: any) =>
        vehicleTypeById.set(Number(row.vehicle_type_id), String(row.vehicle_type_title || 'Vehicle')),
      );

      const hotelBaseAmount = hotels.reduce((sum: number, row: any) => sum + Number(row.total_hotel_cost || 0), 0);
      const hotelMarginAmount = hotels.reduce((sum: number, row: any) => sum + Number(row.hotel_margin_rate || 0), 0);
      const hotelMarginTaxAmount = hotels.reduce(
        (sum: number, row: any) => sum + Number(row.hotel_margin_rate_tax_amt || 0),
        0,
      );
      const vehicleMarginAmount = vehicles.reduce((sum: number, row: any) => sum + Number(row.vendor_margin_amount || 0), 0);
      const vehicleTaxAmount = vehicles.reduce(
        (sum: number, row: any) =>
          sum + Number(row.vendor_margin_gst_amount || 0) + Number(row.vehicle_gst_amount || 0),
        0,
      );
      const serviceBaseAmount =
        Number(plan.itinerary_agent_margin_charges || 0) +
        guides.reduce((sum: number, row: any) => sum + Number(row.total_payable || 0), 0) +
        hotspots.reduce((sum: number, row: any) => sum + Number(row.total_payable || 0), 0) +
        activities.reduce((sum: number, row: any) => sum + Number(row.total_payable || 0), 0);
      const serviceTaxAmount = serviceBaseAmount > 0
        ? (serviceBaseAmount * Number(plan.itinerary_agent_margin_gst_percentage || 0)) / 100
        : 0;

      const companyGst = String(settings?.company_gstin_no || '');
      const buyerGst = String(agentConfig?.invoice_gstin_no || '');
      const isSameState = companyGst.slice(0, 2) === buyerGst.slice(0, 2);
      const gstLabel = isSameState ? 'CGST, SGST' : 'IGST';
      const couponDiscount = Number(plan.itinerary_total_coupon_discount_amount || 0);
      const totalAmount = Number(
        accounts?.total_billed_amount ||
          plan.itinerary_total_net_payable_amount ||
          hotelBaseAmount + hotelMarginAmount + hotelMarginTaxAmount + vehicleMarginAmount + vehicleTaxAmount + serviceBaseAmount + serviceTaxAmount - couponDiscount,
      );

      return {
        meta: {
          invoiceNo: String(plan.itinerary_quote_ID || ''),
          invoiceDate: plan.trip_start_date_and_time,
          deliveryNote: String(plan.itinerary_quote_ID || ''),
          travelExpertName: String(travelExpert?.staff_name || ''),
          itineraryPreference: Number(plan.itinerary_preference || 0),
          gstLabel,
        },
        company: {
          name: String(settings?.company_name || ''),
          address: String(settings?.company_address || ''),
          pincode: String(settings?.company_pincode || ''),
          gstNo: companyGst,
          gstStateCode: companyGst.slice(0, 2),
          gstStateName: this.getStateNameFromGstCode(companyGst),
          cin: String(settings?.company_cin || ''),
          email: String(settings?.company_email_id || ''),
          contactNo: String(settings?.company_contact_no || ''),
          logoUrl: settings?.company_logo ? `/uploads/logo/${String(settings.company_logo)}` : '',
          bank: {
            accountName: String(settings?.bank_acc_holder_name || ''),
            accountNo: String(settings?.bank_acc_no || ''),
            branchName: String(settings?.branch_name || ''),
            ifscCode: String(settings?.bank_ifsc_code || ''),
            bankName: String(settings?.bank_name || ''),
          },
        },
        buyer: {
          companyName: String(agentConfig?.company_name || agent?.agent_name || ''),
          address: String(agentConfig?.invoice_address || ''),
          gstNo: buyerGst,
          gstStateCode: buyerGst.slice(0, 2),
          gstStateName: this.getStateNameFromGstCode(buyerGst),
          panNo: String(agentConfig?.invoice_pan_no || ''),
          agentName: `${String(agent?.agent_name || '').trim()} ${String(agent?.agent_lastname || '').trim()}`.trim(),
          email: String(agent?.agent_email_id || ''),
        },
        guest: {
          name: customer
            ? `${String(customer.customer_salutation || '').trim()} ${String(customer.customer_name || '').trim()}`.trim()
            : 'N/A',
          contactNo: String(customer?.primary_contact_no || ''),
          arrivalPlace: String(customer?.arrival_place || plan.arrival_location || ''),
          arrivalDateTime: customer?.arrival_date_and_time || null,
          departurePlace: String(customer?.departure_place || plan.departure_location || ''),
          departureDateTime: customer?.departure_date_and_time || null,
        },
        itinerary: {
          quoteId: String(plan.itinerary_quote_ID || ''),
          tripStartDateTime: plan.trip_start_date_and_time,
          tripEndDateTime: plan.trip_end_date_and_time,
          routeSummary: `${String(plan.arrival_location || '')} to ${String(plan.departure_location || '')}`.trim(),
        },
        lineItems: [
          {
            key: 'hotel_base',
            serialNo: 1,
            title: 'HOTEL BOOKING CHARGES ONLY A/C (GST PAID)',
            hsnSac: String(settings?.hotel_hsn || ''),
            amount: hotelBaseAmount,
            notes: hotels.map((row: any) => ({
              label: `${row.itinerary_route_date ? new Date(row.itinerary_route_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : ''} - ${String(row.itinerary_route_location || '').trim()} - ${hotelNameById.get(Number(row.hotel_id || 0)) || 'Hotel'}`.replace(/^\s*-\s*/, ''),
            })),
          },
          {
            key: 'hotel_margin',
            serialNo: '',
            title: `${gstLabel} SALES @ ${Number(hotels[0]?.hotel_margin_gst_percentage || 0)}% ACCOMMODATION SERVICES`,
            hsnSac: '',
            amount: hotelMarginAmount,
            notes: [],
          },
          {
            key: 'hotel_tax',
            serialNo: '',
            title: isSameState
              ? `OUTPUT CGST + SGST @ ${Number(hotels[0]?.hotel_margin_gst_percentage || 0) / 2}%`
              : `OUTPUT IGST @ ${Number(hotels[0]?.hotel_margin_gst_percentage || 0)}%`,
            hsnSac: '',
            amount: hotelMarginTaxAmount,
            notes: [],
          },
          ...(vehicles.length > 0
            ? [
                {
                  key: 'vehicle_margin',
                  serialNo: 2,
                  title: `${gstLabel} SALES @ ${Number(vehicles[0]?.vendor_margin_gst_percentage || 0)}% TRANSPORTATION SERVICES`,
                  hsnSac: String(settings?.vehicle_hsn || ''),
                  amount: vehicleMarginAmount,
                  notes: vehicles.map((row: any) => ({
                    label: `${vendorNameById.get(Number(row.vendor_id || 0)) || 'Vendor'} - ${vehicleTypeById.get(Number(row.vehicle_type_id || 0)) || 'Vehicle'}${row.vehicle_orign ? ` - ${String(row.vehicle_orign).trim()}` : ''}`,
                  })),
                },
                {
                  key: 'vehicle_tax',
                  serialNo: '',
                  title: isSameState
                    ? `OUTPUT CGST + SGST @ ${Number(vehicles[0]?.vendor_margin_gst_percentage || 0) / 2}%`
                    : `OUTPUT IGST @ ${Number(vehicles[0]?.vendor_margin_gst_percentage || 0)}%`,
                  hsnSac: '',
                  amount: vehicleTaxAmount,
                  notes: [],
                },
              ]
            : []),
          ...(serviceBaseAmount > 0
            ? [
                {
                  key: 'service_base',
                  serialNo: vehicles.length > 0 ? 3 : 2,
                  title: 'TOTAL GUIDE / HOTSPOT / ACTIVITY / SERVICE COMPONENTS',
                  hsnSac: String(settings?.service_component_hsn || ''),
                  amount: serviceBaseAmount,
                  notes: [],
                },
                {
                  key: 'service_tax',
                  serialNo: '',
                  title: isSameState
                    ? `OUTPUT CGST + SGST @ ${Number(plan.itinerary_agent_margin_gst_percentage || 0) / 2}%`
                    : `OUTPUT IGST @ ${Number(plan.itinerary_agent_margin_gst_percentage || 0)}%`,
                  hsnSac: '',
                  amount: serviceTaxAmount,
                  notes: [],
                },
              ]
            : []),
        ].filter((item: any) => Number(item.amount || 0) > 0),
        totals: {
          couponDiscount,
          totalAmount,
        },
        declaration:
          'The hotel bill charges are collected on behalf of the hotel hence the GST is payable by the hotel directly to the government.',
      };
    }

}
