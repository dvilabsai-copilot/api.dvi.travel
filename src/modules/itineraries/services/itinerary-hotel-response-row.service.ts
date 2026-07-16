import { Injectable } from '@nestjs/common';
import type { ItineraryHotelRowDto } from '../itinerary-hotel-details.service';
import { haversineKm } from '../utils/distance-utils';

export interface HotelResponseRowCallbacks {
  enrichHotelWithMasterMargin: (hotel: any) => any;
  applyInvisibleHotelMargin: (amount: number, hotel: any) => number;
  getHotelMarginPercentage: (hotel: any) => number;
  parseStaahSearchReference: (reference: any) => { propertyId: string; roomId: string; rateId: string } | null;
  getGroupTypeFromPrice: (price: number, allPrices: number[]) => number;
  debug?: (message: string) => void;
}

/** Projects supplier and restricted hotel search records into the API row contract. */
@Injectable()
export class ItineraryHotelResponseRowService {
  buildSupplierRow(input: {
    route: any;
    routeIndex: number;
    groupType: number;
    hotel: any;
    detailsMap: Map<string, number>;
    voucherStatusMap: Map<number, boolean>;
    routeDestinationCoordsByLocationId: Map<number, { lat: number; lon: number }>;
    hotelCoordsByProviderCode: Map<string, { lat: number; lon: number }>;
    callbacks: HotelResponseRowCallbacks;
  }): ItineraryHotelRowDto {
    const { route, routeIndex, groupType, hotel, detailsMap, voucherStatusMap } = input;
    const callbacks = input.callbacks;
    const routeId = Number(route.itinerary_route_ID);
    const destination = route.next_visiting_location || route.location_name || '';
    const hotelId = Number.parseInt(String(hotel.hotelCode || ''), 10) || 0;
    const dateLabel = new Date(route.itinerary_route_date).toISOString().split('T')[0];
    const lookupKey = hotelId > 0 ? `${routeId}-${hotelId}-${groupType}` : '';
    const hotelDetailsId = lookupKey ? detailsMap.get(lookupKey) : undefined;
    const voucherCancelled = hotelDetailsId ? voucherStatusMap.get(hotelDetailsId) || false : false;
    const hotelDistance = this.distanceFor(
      Number(route.location_id || 0),
      String(hotel.provider || 'tbo').trim().toLowerCase(),
      String(hotel.hotelCode || '').trim(),
      input.routeDestinationCoordsByLocationId,
      input.hotelCoordsByProviderCode,
    );
    const pricedHotel = callbacks.enrichHotelWithMasterMargin(hotel);
    const baseHotelCost = Number(pricedHotel.price || 0);
    const totalHotelCost = callbacks.applyInvisibleHotelMargin(baseHotelCost, pricedHotel);
    const normalizedProvider = String(hotel.provider || 'tbo').trim().toLowerCase();
    const rawSearchReference = String(hotel.searchReference || '').trim();
    const parsedStaahReference = callbacks.parseStaahSearchReference(
      rawSearchReference || hotel.bookingCode || '',
    );
    const rawBookingCode =
      normalizedProvider === 'tbo'
        ? String(hotel.searchReference || hotel.roomTypes?.[0]?.roomCode || hotel.bookingCode || '').trim()
        : normalizedProvider === 'staah'
          ? String(rawSearchReference || hotel.bookingCode || '').trim()
          : String(hotel.bookingCode || hotel.searchReference || hotel.hotelCode || '').trim();
    const rawHotelCode = String(hotel.hotelCode || '').trim();
    const isNoHotelsAvailable = String(hotel.hotelName || '').trim().toLowerCase() === 'no hotels available' || rawHotelCode === '0';
    const hasSupplierHotel =
      !isNoHotelsAvailable && Boolean(rawHotelCode) && rawHotelCode !== '0' && Number.isFinite(baseHotelCost) && baseHotelCost > 0;
    const isPrebookReady = hasSupplierHotel && (normalizedProvider !== 'tbo' || rawBookingCode.includes('!TB!'));

    if (hotel.provider === 'HOBSE') callbacks.debug?.(`HOBSE Hotel Response: hotelCode="${hotel.hotelCode}", provider="${hotel.provider}"`);

    return {
      groupType,
      itineraryRouteId: routeId,
      day: `Day ${routeIndex + 1} | ${dateLabel}`,
      destination,
      hotelId,
      hotelName: hotel.hotelName,
      category: hotel.rating ? parseInt(String(hotel.rating)) : 0,
      roomType: hotel.roomType || '',
      mealPlan: hotel.mealPlan || '',
      baseHotelCost,
      hotelMarginPercentage: callbacks.getHotelMarginPercentage(pricedHotel),
      totalHotelCost,
      totalHotelTaxAmount: 0,
      searchReference: rawSearchReference || undefined,
      bookingCode: isPrebookReady ? rawBookingCode : undefined,
      roomId: normalizedProvider === 'staah' ? parsedStaahReference?.roomId || undefined : undefined,
      rateId: normalizedProvider === 'staah' ? parsedStaahReference?.rateId || undefined : undefined,
      provider: hasSupplierHotel ? normalizedProvider : 'external',
      isBookable: hasSupplierHotel,
      externalStay: !hasSupplierHotel,
      availabilityStatus: hasSupplierHotel ? 'AVAILABLE' : 'NO_SUPPLIER_AVAILABILITY',
      availabilityMessage: hasSupplierHotel ? null : 'No supplier hotel rooms are available for this city/date. Customer must arrange stay manually.',
      voucherCancelled,
      itineraryPlanHotelDetailsId: hotelDetailsId || 0,
      date: dateLabel,
      hotelDistance,
      inclusions: hotel.inclusions?.length ? hotel.inclusions : hotel.facilities?.length ? hotel.facilities : undefined,
      amenities: hotel.amenities?.length ? hotel.amenities : undefined,
      facilities: hotel.facilities?.length ? hotel.facilities : undefined,
      rateConditions: hotel.rateConditions?.length ? hotel.rateConditions : undefined,
      cancellationPolicy: Array.isArray(hotel.cancellationPolicy)
        ? hotel.cancellationPolicy
        : typeof hotel.cancellationPolicy === 'string' && hotel.cancellationPolicy.trim()
          ? [hotel.cancellationPolicy.trim()]
          : undefined,
      supplementSummary: hotel.supplementSummary,
    } as ItineraryHotelRowDto;
  }

  buildRestrictedRow(input: {
    route: any;
    routeIndex: number;
    hotel: any;
    allPrices: number[];
    routeDestinationCoordsByLocationId: Map<number, { lat: number; lon: number }>;
    hotelCoordsByProviderCode: Map<string, { lat: number; lon: number }>;
    callbacks: HotelResponseRowCallbacks;
  }): ItineraryHotelRowDto {
    const { route, routeIndex, hotel, allPrices, callbacks } = input;
    const routeId = Number(route.itinerary_route_ID);
    const dateLabel = new Date(route.itinerary_route_date).toISOString().split('T')[0];
    const provider = String(hotel.provider || 'staah').trim().toLowerCase();
    const hotelCode = String(hotel.hotelCode || '').trim();
    const hotelDistance = this.distanceFor(
      Number(route.location_id || 0), provider, hotelCode,
      input.routeDestinationCoordsByLocationId, input.hotelCoordsByProviderCode,
    );
    const price = Number(hotel.price || 0);

    return {
      groupType: callbacks.getGroupTypeFromPrice(price, allPrices),
      itineraryRouteId: routeId,
      day: `Day ${routeIndex + 1} | ${dateLabel}`,
      destination: route.next_visiting_location || route.location_name || '',
      hotelId: Number.parseInt(hotelCode || '0', 10) || 0,
      hotelName: String(hotel.hotelName || 'Hotel'),
      category: hotel.rating ? parseInt(String(hotel.rating), 10) : 0,
      roomType: String(hotel.roomType || ''),
      mealPlan: String(hotel.mealPlan || ''),
      baseHotelCost: price,
      hotelMarginPercentage: callbacks.getHotelMarginPercentage(hotel),
      totalHotelCost: callbacks.applyInvisibleHotelMargin(price, hotel),
      totalHotelTaxAmount: 0,
      searchReference: String(hotel.searchReference || '').trim() || undefined,
      bookingCode: undefined,
      provider,
      isBookable: false,
      externalStay: false,
      availabilityStatus: 'NOT_BOOKABLE',
      availabilityMessage: String(hotel.availabilityMessage || '').trim() || 'Restricted for the selected stay.',
      availableAgainFrom: String(hotel.availableAgainFrom || '').trim() || null,
      voucherCancelled: false,
      itineraryPlanHotelDetailsId: 0,
      date: dateLabel,
      hotelDistance,
      inclusions: hotel.inclusions?.length ? hotel.inclusions : undefined,
      amenities: hotel.amenities?.length ? hotel.amenities : undefined,
      facilities: hotel.facilities?.length ? hotel.facilities : undefined,
      rateConditions: hotel.rateConditions?.length ? hotel.rateConditions : undefined,
      cancellationPolicy: Array.isArray(hotel.cancellationPolicy) ? hotel.cancellationPolicy : undefined,
      supplementSummary: hotel.supplementSummary,
    } as ItineraryHotelRowDto;
  }

  private distanceFor(
    routeLocationId: number,
    provider: string,
    hotelCode: string,
    routeCoordsByLocationId: Map<number, { lat: number; lon: number }>,
    hotelCoordsByProviderCode: Map<string, { lat: number; lon: number }>,
  ): string | null {
    const routeCoords = routeCoordsByLocationId.get(routeLocationId);
    const hotelCoords = hotelCoordsByProviderCode.get(`${provider}|${hotelCode}`);
    if (!routeCoords || !hotelCoords) return null;
    try {
      const distanceKm = haversineKm(routeCoords.lat, routeCoords.lon, hotelCoords.lat, hotelCoords.lon);
      return Number.isFinite(distanceKm) && distanceKm > 0 ? `${distanceKm.toFixed(2)} KM` : null;
    } catch {
      return null;
    }
  }
}
