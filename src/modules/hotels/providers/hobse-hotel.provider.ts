import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { PrismaService } from '../../../prisma.service';
import {
  IHotelProvider,
  HotelSearchResult,
  RoomType,
  HotelSearchCriteria,
  HotelPreferences,
  HotelConfirmationDTO,
  HotelConfirmationResult,
  HotelConfirmationDetails,
  CancellationResult,
} from '../interfaces/hotel-provider.interface';

interface HobseEnvelope<T = any> {
  hobse: {
    version: string;
    datetime: string;
    clientToken?: string;
    accessToken?: string;
    productToken?: string;
    response?: {
      status: {
        success: 'true' | 'false';
        code: string;
        message: string;
      };
      totalRecords?: number;
      data?: T;
      errors?: Array<{
        code?: string;
        message?: string;
        param?: any;
      }>;
    };
    request?: any;
  };
}

@Injectable()
export class HobseHotelProvider implements IHotelProvider {
  private readonly logger = new Logger(HobseHotelProvider.name);
  private http: AxiosInstance = axios;

  private readonly BASE_URL =
    (process.env.HOBSE_BASE_URL || 'https://api.hobse.com/v1')
      .replace(/\/htl\/?$/, '')
      .replace(/\/+$/, '');

  private readonly CLIENT_TOKEN = process.env.HOBSE_CLIENT_TOKEN || '';
  private readonly ACCESS_TOKEN = process.env.HOBSE_ACCESS_TOKEN || '';
  private readonly PRODUCT_TOKEN = process.env.HOBSE_PRODUCT_TOKEN || '';

  private readonly PARTNER_TYPE = process.env.HOBSE_PARTNER_TYPE || 'TA';
  private readonly PARTNER_ID = process.env.HOBSE_PARTNER_ID || '';
  private readonly PARTNER_TYPE_ID = process.env.HOBSE_PARTNER_TYPE_ID || '';
  private readonly PRICE_OWNER_TYPE = process.env.HOBSE_PRICE_OWNER_TYPE || '2';
  private readonly TARIFF_MODE = process.env.HOBSE_TARIFF_MODE || 'B2B';
  private readonly CHANNEL_NAME = process.env.HOBSE_CHANNEL_NAME || 'DVI';

  constructor(private readonly prisma: PrismaService) {}

  getName(): string {
    return 'HOBSE';
  }

  private buildParams(method: string, data: any): HobseEnvelope {
    const methodWithPrefix = method.startsWith('htl/') ? method : `htl/${method}`;

    return {
      hobse: {
        version: '1.0',
        datetime: new Date().toISOString().replace('Z', '+05:30'),
        clientToken: this.CLIENT_TOKEN,
        accessToken: this.ACCESS_TOKEN,
        productToken: this.PRODUCT_TOKEN,
        request: {
          method: methodWithPrefix,
          data: {
            ...data,
            resultType: 'json',
          },
        },
      },
    };
  }

  /**
   * Send application/x-www-form-urlencoded with key "params"
   */
  private async postForm<T = any>(method: string, data: any): Promise<HobseEnvelope<T>> {
    try {
      const endpointMethod = method.startsWith('htl/') ? method.slice(4) : method;
      const url = `${this.BASE_URL}/htl/${endpointMethod}`;
      const paramsEnvelope = this.buildParams(method, data);

      const form = new URLSearchParams();
      form.append('params', JSON.stringify(paramsEnvelope));

      this.logger.debug(`📤 HOBSE POST ${url}`);
      this.logger.log(`🔍 HOBSE ${method} - Full Params JSON:`);
      this.logger.log(JSON.stringify(paramsEnvelope, null, 2));

      const resp = await this.http.post<HobseEnvelope<T>>(url, form.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 45000,
        validateStatus: () => true, // Accept any status code, handle manually
      });

      // Log the status code
      if (resp.status !== 200) {
        this.logger.warn(`⚠️  HOBSE ${method} HTTP Status: ${resp.status}`);
      }

      // Try to extract error info from response body
      const responseData = resp.data;
      const ok = responseData?.hobse?.response?.status?.success === 'true';
      
      if (!ok) {
        const errorMessage = responseData?.hobse?.response?.status?.message ||
          responseData?.hobse?.response?.errors?.[0]?.message ||
          `HOBSE API error (HTTP ${resp.status})`;
        
        this.logger.warn(`⚠️  HOBSE ${method} Response: ${errorMessage}`);
        this.logger.warn(`   Status: ${JSON.stringify(responseData?.hobse?.response?.status)}`);
        this.logger.warn(`   Errors: ${JSON.stringify(responseData?.hobse?.response?.errors)}`);
        
        // Write full response to file for debugging
        const fs = require('fs');
        const path = require('path');
        const debugDir = path.join(process.cwd(), 'tmp');
        if (!fs.existsSync(debugDir)) {
          fs.mkdirSync(debugDir, { recursive: true });
        }
        const debugPath = path.join(debugDir, `hobse_${method}_response_${Date.now()}.json`);
        fs.writeFileSync(debugPath, JSON.stringify(responseData, null, 2));
        this.logger.warn(`   Full Response saved to ${debugPath}`);
        
        throw new Error(errorMessage);
      }

      return responseData;
    } catch (e: any) {
      this.logger.error(`❌ HOBSE API failed: ${e?.message}`);
      throw new InternalServerErrorException(`HOBSE API failed: ${e?.message}`);
    }
  }

  /**
   * Pick cheapest room option from GetAvailableRoomTariff response
   */
  private pickCheapestRoomOption(roomOptions: any[] = []) {
    if (!roomOptions || roomOptions.length === 0) {
      this.logger.warn(`⚠️  HOBSE: roomOptions array is empty`);
      return null;
    }

    let best: any = null;
    let bestPrice = Number.POSITIVE_INFINITY;

    for (const opt of roomOptions) {
      // Handle ratesData array
      const rates = Array.isArray(opt?.ratesData) ? opt.ratesData : [];
      
      if (rates.length === 0) {
        // Try to use direct price fields if ratesData is not available
        const directPrice = Number(opt?.roomCost || opt?.price || opt?.totalCost || 0);
        if (directPrice > 0 && directPrice < bestPrice) {
          bestPrice = directPrice;
          best = {
            roomCode: opt.roomCode,
            roomName: opt.roomName,
            occupancyTypeCode: opt.occupancyTypeCode,
            occupancyTypeName: opt.occupancyTypeName,
            ratePlanCode: opt.ratePlanCode,
            ratePlanName: opt.ratePlanName,
            tariff: String(opt?.roomCost || opt?.price || 0),
            tax: String(opt?.taxes || 0),
          };
        }
        continue;
      }

      for (const r of rates) {
        // Use roomCost as primary price source (totalCostWithTax may be 0 in booking response)
        const price = Number(r?.roomCost || r?.totalCostWithTax || r?.totalCost || r?.cost || 0);
        
        if (price > 0 && price < bestPrice) {
          bestPrice = price;
          best = {
            roomCode: opt.roomCode,
            roomName: opt.roomName,
            occupancyTypeCode: opt.occupancyTypeCode,
            occupancyTypeName: opt.occupancyTypeName,
            ratePlanCode: opt.ratePlanCode,
            ratePlanName: opt.ratePlanName,
            tariff: String(r?.roomCost || r?.basePrice || 0),
            tax: String(r?.taxes || r?.tax || 0),
          };
        }
      }
    }

    if (best) {
      this.logger.log(`✅ HOBSE: Selected room ${best.roomCode} at ₹${bestPrice}`);
    } else {
      this.logger.warn(`⚠️  HOBSE: No suitable room found in ${roomOptions.length} options after checking ${roomOptions.reduce((sum, opt) => sum + (opt.ratesData?.length || 0), 0)} rates`);
    }

    return best;
  }

  /**
   * SEARCH
   * criteria.cityCode here is your itinerary flow code (usually TBO city code).
   * We map it to dvi_cities.hobse_city_code + city name (for filtering GetHotelList by cityName).
   */
  async search(criteria: HotelSearchCriteria, _preferences?: HotelPreferences): Promise<HotelSearchResult[]> {
    try {
      this.logger.log(`\n   📡 HOBSE SEARCH: cityCode=${criteria.cityCode}, ${criteria.checkInDate}→${criteria.checkOutDate}`);

      // Convert cityCode to string for database lookup (Prisma expects string)
      const cityCodeAsString = String(criteria.cityCode);

      // Build where conditions with proper string values
      const orConditions: any[] = [
        { tbo_city_code: cityCodeAsString },
        { hobse_city_code: cityCodeAsString },
        { name: cityCodeAsString }, // Also support lookup by city name directly
      ];

      const cityRow = await this.prisma.dvi_cities.findFirst({
        where: {
          OR: orConditions,
        },
        select: { name: true, hobse_city_code: true },
      });

      if (!cityRow?.hobse_city_code || !cityRow?.name) {
        this.logger.warn(`   ⚠️  No HOBSE mapping for cityCode: ${criteria.cityCode}`);
        return [];
      }

      // Get full hotel list (empty parameters - API returns all hotels)
      const listResp = await this.postForm('GetHotelList', {});
      const allHotels: any[] = Array.isArray(listResp?.hobse?.response?.data) ? listResp.hobse.response.data : [];

      // Filter by city name
      const cityNameLower = cityRow.name.toLowerCase();
      const cityHotels = allHotels.filter((h) => (h?.cityName || '').toLowerCase() === cityNameLower);

      if (cityHotels.length === 0) {
        this.logger.warn(`   📭 No HOBSE hotels found for city: ${cityRow.name}`);
        return [];
      }

      const results: HotelSearchResult[] = [];

      // limited concurrency
      const concurrency = 5;
      for (let i = 0; i < cityHotels.length; i += concurrency) {
        const slice = cityHotels.slice(i, i + concurrency);

        const chunk = await Promise.all(
          slice.map((h) =>
            this.getHotelTariffAsSearchResult({
              hobseCityId: cityRow.hobse_city_code!,
              hotelId: h.hotelId,
              hotelName: h.hotelName,
              starCategory: h.starCategory,
              address: h.address,
              criteria,
            }).catch((e) => {
              this.logger.error(`   ❌ Tariff failed for hotel ${h?.hotelId}: ${e?.message || e}`);
              return null;
            }),
          ),
        );

        chunk.filter(Boolean).forEach((x) => results.push(x as HotelSearchResult));
      }

      this.logger.log(`   ✅ HOBSE: returning ${results.length}/${cityHotels.length} hotels with tariffs`);
      return results;
    } catch (error: any) {
      this.logger.error(`   ❌ HOBSE search error: ${error?.message || error}`);
      return [];
    }
  }

  private async getHotelTariffAsSearchResult(args: {
    hobseCityId: string;
    hotelId: string;
    hotelName: string;
    starCategory?: string;
    address?: string;
    criteria: HotelSearchCriteria;
  }): Promise<HotelSearchResult | null> {
    const { hobseCityId, hotelId, hotelName, starCategory, address, criteria } = args;

    const sessionId = `DVI-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const adultCount = String(Math.max(1, criteria.guestCount || 2));
    const roomData = [{ adultCount, childCount: '0', infantCount: '0' }];

    const req = {
      sessionId,
      fromDate: criteria.checkInDate,
      toDate: criteria.checkOutDate,
      cityId: String(hobseCityId),
      priceOwnerType: String(this.PRICE_OWNER_TYPE),
      partnerId: String(this.PARTNER_ID),
      partnerTypeId: String(this.PARTNER_TYPE_ID),
      tariffMode: String(this.TARIFF_MODE),
      roomData,
      hotelFilter: [{ hotelId }],
    };

    const tariffResp = await this.postForm('GetAvailableRoomTariff', req);
    const payload = tariffResp?.hobse?.response?.data;

    const list = Array.isArray(payload) ? payload : [];
    if (!Array.isArray(payload) || list.length === 0) return null;

    const hotelTariff = list[0];
    const roomOptions: any[] = Array.isArray(hotelTariff?.roomOptions) ? hotelTariff.roomOptions : [];
    if (roomOptions.length === 0) return null;

    let minPrice = Number.POSITIVE_INFINITY;
    let bestOption: any = null;

    const roomTypes: RoomType[] = [];

    for (const opt of roomOptions) {
      const ratesData = Array.isArray(opt?.ratesData) ? opt.ratesData : [];
      const firstRate = ratesData[0] || {};

      const priceStr = firstRate?.roomCost ?? firstRate?.totalCostWithTax ?? firstRate?.totalCost ?? '0';
      const price = parseFloat(String(priceStr)) || 0;

      if (price > 0 && price < minPrice) {
        minPrice = price;
        bestOption = opt;
      }

      roomTypes.push({
        roomCode: opt.roomCode || '',
        roomName: opt.roomName || opt.roomDesc || 'Room',
        bedType: opt.occupancyTypeName || 'Standard',
        capacity: Number(firstRate?.totalPax || criteria.guestCount || 2),
        price,
        cancellationPolicy: '',
      });
    }

    if (!bestOption || !isFinite(minPrice) || minPrice <= 0) return null;

    const roomTypeName = bestOption?.roomName || bestOption?.roomDesc || '';
    const mealPlan = bestOption?.ratePlanName || bestOption?.ratePlanDesc || '-';

    return {
      provider: 'HOBSE',
      hotelCode: hotelId,
      hotelName: hotelName || 'HOBSE Hotel',
      cityCode: criteria.cityCode,
      address: address || '',
      rating: parseInt(String(starCategory || hotelTariff?.starCategory || '0'), 10) || 0,
      category: starCategory ? `${starCategory}-Star` : '',
      facilities: [],
      images: [],
      price: minPrice,
      currency: hotelTariff?.currencyCode || 'INR',
      roomTypes,
      roomType: roomTypeName,
      mealPlan,
      searchReference: JSON.stringify({
        provider: 'HOBSE',
        hotelId,
        cityId: hobseCityId,
        checkInDate: criteria.checkInDate,
        checkOutDate: criteria.checkOutDate,
        priceOwnerType: this.PRICE_OWNER_TYPE,
        partnerId: this.PARTNER_ID,
        partnerTypeId: this.PARTNER_TYPE_ID,
        tariffMode: this.TARIFF_MODE,
        roomCode: bestOption?.roomCode,
        occupancyTypeCode: bestOption?.occupancyTypeCode,
        ratePlanCode: bestOption?.ratePlanCode,
      }),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    };
  }

  // Not needed for hotel listing endpoint right now
  async getConfirmation(_confirmationRef: string): Promise<HotelConfirmationDetails> {
    throw new InternalServerErrorException('HOBSE confirmation not implemented');
  }

  async confirmBooking(_bookingDetails: HotelConfirmationDTO): Promise<HotelConfirmationResult> {
    throw new InternalServerErrorException(
      'HOBSE booking must be called via HobseHotelBookingService.confirmItineraryHotels()',
    );
  }

  async cancelBooking(
    confirmationRef: string,
    reason: string,
    hotelId?: string,
  ): Promise<CancellationResult> {
    try {
      this.logger.log(
        `❌ Cancelling HOBSE booking: ${confirmationRef}, Hotel: ${hotelId}, Reason: ${reason}`
      );

      // HOBSE API format as per documentation:
      // - hobseBookingId (not bookingId)
      // - hotelId (required)
      // - bookingStatus: "1" = cancelled (numeric string, not 'cancelled')
      const cancellationRequest = {
        hobseBookingId: confirmationRef,
        hotelId: hotelId || '',
        bookingStatus: '1', // 1 = cancelled
      };

      this.logger.debug(`📤 HOBSE Cancellation Request Payload: ${JSON.stringify(cancellationRequest)}`);
      this.logger.log(`📡 HOBSE SetBookingStatus API Call - Booking: ${confirmationRef}`);

      // Call HOBSE SetBookingStatus API
      const response = await this.postForm<any>('SetBookingStatus', cancellationRequest);

      this.logger.debug(`📥 HOBSE Cancel API Response: ${JSON.stringify(response)}`);

      // Check response status
      const responseStatus = response?.hobse?.response?.status;
      if (
        !responseStatus ||
        responseStatus.success !== 'true' ||
        responseStatus.code !== '200'
      ) {
        const errorMsg =
          responseStatus?.message ||
          response?.hobse?.response?.errors?.[0]?.message ||
          'Unknown error';

        this.logger.error(
          `❌ HOBSE Cancel Error: ${errorMsg} (Code: ${responseStatus?.code})`
        );
        this.logger.error(`❌ HOBSE Cancel Failed Response: ${JSON.stringify(response)}`);

        // Log full response for debugging
        const timestamp = Date.now();
        const dumpPath = `tmp/hobse_SetBookingStatus_response_${timestamp}.json`;
        try {
          const fs = require('fs');
          const path = require('path');
          const fullPath = path.join(process.cwd(), dumpPath);
          const dir = path.dirname(fullPath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(fullPath, JSON.stringify(response, null, 2));
          this.logger.debug(`📄 Response dumped to: ${dumpPath}`);
        } catch (e) {
          this.logger.debug(`⚠️  Could not dump response: ${(e as Error).message}`);
        }

        throw new Error(`Cancellation failed: ${errorMsg}`);
      }

      this.logger.log(
        `✅ HOBSE Booking cancelled successfully: ${confirmationRef}`
      );
      this.logger.log(`✅ HOBSE Cancel API Response Status: ${responseStatus.code} - ${responseStatus.message}`);

      return {
        cancellationRef: confirmationRef,
        refundAmount: 0, // HOBSE doesn't return refund details in cancellation
        charges: 0,
        refundDays: 0,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `❌ HOBSE Cancel Error: ${errorMsg}`,
        error instanceof Error ? error.stack : ''
      );
      throw new InternalServerErrorException(
        `HOBSE cancellation failed: ${errorMsg}`
      );
    }
  }

  /**
   * MAIN BOOKING METHOD - Used by HobseHotelBookingService
   * Flow:
   * 1) GetAvailableRoomTariff
   * 2) CalculateReservationCost
   * 3) CreateBooking
   */
  async createBookingFromItinerary(input: {
    hotelId: string;
    cityId: string; // hobse city id
    checkInDate: string; // YYYY-MM-DD
    checkOutDate: string; // YYYY-MM-DD
    adultCount: number;
    childCount: number;
    infantCount: number;

    guest: {
      title: string;
      firstName: string;
      lastName: string;
      mobileNumber: string;
      email: string;
      address?: string;
      state?: string;
      city?: string;
      country?: string;
      billToTaxNumber?: string;
      billToCompanyName?: string;
      billToAddress?: string;
    };

    channelBookingId: string;
    bookingDesc?: string;
  }) {
    // 1) GetAvailableRoomTariff
    const sessionId = `DVI-${Date.now()}`;

    this.logger.log(`\n🔄 HOBSE BOOKING REQUEST STARTING:`);
    this.logger.log(`   Hotel ID: ${input.hotelId}`);
    this.logger.log(`   City ID: ${input.cityId}`);
    this.logger.log(`   Check-in: ${input.checkInDate}`);
    this.logger.log(`   Check-out: ${input.checkOutDate}`);
    this.logger.log(`   Adults: ${input.adultCount}, Children: ${input.childCount}, Infants: ${input.infantCount}`);

    const tariffResp = await this.postForm<any>('GetAvailableRoomTariff', {
      sessionId,
      fromDate: input.checkInDate,
      toDate: input.checkOutDate,
      cityId: input.cityId,
      priceOwnerType: this.PRICE_OWNER_TYPE,
      partnerId: this.PARTNER_ID,
      partnerTypeId: this.PARTNER_TYPE_ID,
      tariffMode: this.TARIFF_MODE,
      roomData: [
        {
          adultCount: String(input.adultCount),
          childCount: String(input.childCount),
          infantCount: String(input.infantCount),
        },
      ],
      hotelFilter: [{ hotelId: input.hotelId }],
    });

    this.logger.log(`\n✅ HOBSE GetAvailableRoomTariff RESPONSE RECEIVED:`);
    this.logger.log(`📥 Full tariff response: ${JSON.stringify(tariffResp, null, 2)}`);

    // Save response to file for debugging
    const debugFile = require('path').join(process.cwd(), 'tmp', `hobse_tariff_response_${Date.now()}.json`);
    try {
      require('fs').writeFileSync(debugFile, JSON.stringify(tariffResp, null, 2));
      this.logger.log(`✅ Tariff response saved to ${debugFile}`);
    } catch (e) {
      this.logger.log(`⚠️  Could not save tariff response: ${(e as Error).message}`);
    }

    const data = tariffResp?.hobse?.response?.data;
    
    this.logger.log(`\n📦 HOBSE TARIFF RESPONSE:`);
    this.logger.log(`   Response has data field: ${data !== undefined}`);
    this.logger.log(`   Data is array: ${Array.isArray(data)}`);
    this.logger.log(`   Response keys: ${Object.keys(tariffResp?.hobse?.response || {}).join(', ')}`);
    this.logger.log(`   Full Response: ${JSON.stringify(tariffResp).substring(0, 500)}`);
    
    if (Array.isArray(data)) {
      this.logger.log(`   Array length: ${data.length}`);
      if (data.length > 0) {
        const hotel = data[0];
        this.logger.log(`   Hotel object keys: ${Object.keys(hotel).join(', ')}`);
        this.logger.log(`   Hotel has roomOptions: ${!!hotel?.roomOptions}`);
        if (hotel?.roomOptions) {
          this.logger.log(`   Room options count: ${hotel.roomOptions.length}`);
        }
      }
    } else {
      this.logger.log(`   Data type: ${typeof data}`);
      if (data !== undefined && !Array.isArray(data)) {
        this.logger.log(`   Data object: ${JSON.stringify(data).substring(0, 300)}`);
      }
    }

    const hotelRow = Array.isArray(data) ? data[0] : null;
    
    if (!hotelRow) {
      this.logger.error(`❌ No hotel row in HOBSE response`);
      throw new Error('No hotel data returned from HOBSE GetAvailableRoomTariff');
    }
    
    if (!hotelRow?.roomOptions?.length) {
      this.logger.error(`❌ No roomOptions in hotel row`);
      throw new Error('No roomOptions returned from HOBSE GetAvailableRoomTariff');
    }

    this.logger.log(`📋 Found ${hotelRow.roomOptions.length} room options, selecting cheapest...`);
    const best = this.pickCheapestRoomOption(hotelRow.roomOptions);
    if (!best) {
      this.logger.error(`❌ Unable to pick best room`);
      throw new Error('Unable to select cheapest room option from HOBSE response');
    }

    // 2) CalculateReservationCost - REQUIRED by HOBSE API
    this.logger.log(`\n💰 CALLING HOBSE CALCULATE RESERVATION COST:`);
    this.logger.log(`   Room Code: ${best.roomCode}`);
    this.logger.log(`   Occupancy: ${best.occupancyTypeCode}`);
    this.logger.log(`   Rate Plan: ${best.ratePlanCode}`);
    this.logger.log(`   Selected Tariff: ₹${best.tariff}, Tax: ₹${best.tax}`);

    try {
      const costResp = await this.postForm<any>('CalculateReservationCost', {
        hotelId: input.hotelId,
        priceOwnerType: this.PRICE_OWNER_TYPE,
        partnerType: this.PARTNER_TYPE,
        partnerId: this.PARTNER_ID,
        partnerTypeId: this.PARTNER_TYPE_ID,
        checkInDate: input.checkInDate,
        checkOutDate: input.checkOutDate,
        tariffMode: this.TARIFF_MODE,
        roomData: [
          {
            roomCode: best.roomCode,
            occupancyTypeCode: best.occupancyTypeCode,
            ratePlanCode: best.ratePlanCode,
            adultCount: String(input.adultCount),
            childCount: String(input.childCount),
            infantCount: String(input.infantCount),
          },
        ],
      });

      this.logger.log(`✅ HOBSE CALCULATE RESERVATION COST SUCCESSFUL`);
      
      const costData = Array.isArray(costResp?.hobse?.response?.data)
        ? costResp.hobse.response.data[0]
        : null;

      if (!costData) {
        this.logger.warn(`⚠️  No cost data from CalculateReservationCost, using GetAvailableRoomTariff rates`);
        // Fallback to tariff rates from GetAvailableRoomTariff
        const totalTariff = best.tariff;
        const totalTax = best.tax;
        const totalReservationCost = String(Number(totalTariff) + Number(totalTax));
        
        this.logger.log(`💰 USING FALLBACK RATES FROM GETAVAILABLEROOMTARIFF:`);
        this.logger.log(`   Total: ₹${totalReservationCost}`);

        return this.executeCreateBooking(input, best, totalTariff, totalTax, totalReservationCost, hotelRow, '');
      }

      this.logger.log(`💰 COST DATA RETURNED FROM HOBSE:`);
      this.logger.log(JSON.stringify(costData, null, 2));

      // Check if CalculateReservationCost returned 0.00 (meaning the room is not available for this partner)
      const calcTotalReservationCost = Number(costData.totalReservationCost || 0);
      
      if (calcTotalReservationCost === 0) {
        this.logger.warn(`⚠️  CalculateReservationCost returned 0.00 - room not available for this partner, using GetAvailableRoomTariff rates`);
        const totalTariff = best.tariff;
        const totalTax = best.tax;
        const totalReservationCost = String(Number(totalTariff) + Number(totalTax));
        
        this.logger.log(`💰 USING FALLBACK RATES FROM GETAVAILABLEROOMTARIFF:`);
        this.logger.log(`   Tariff: ₹${totalTariff}, Tax: ₹${totalTax}, Total: ₹${totalReservationCost}`);

        return this.executeCreateBooking(input, best, totalTariff, totalTax, totalReservationCost, hotelRow, '');
      }

      const totalTariff = String(costData.totalTariff || best.tariff || '0.00');
      const totalTax = String(costData.totalTax || best.tax || '0.00');
      const totalReservationCost = String(costData.totalReservationCost || Number(totalTariff) + Number(totalTax));
      const tariffReferenceCode = String(costData.tariffReferenceCode || '');

      this.logger.log(`   totalTariff: ${totalTariff}, totalTax: ${totalTax}, totalReservationCost: ${totalReservationCost}`);
      this.logger.log(`   tariffReferenceCode: ${tariffReferenceCode}`);

      return this.executeCreateBooking(input, best, totalTariff, totalTax, totalReservationCost, hotelRow, tariffReferenceCode);
    } catch (error) {
      this.logger.warn(`⚠️  CalculateReservationCost failed: ${error instanceof Error ? error.message : String(error)}`);
      this.logger.log(`📋 Falling back to GetAvailableRoomTariff rates...`);
      
      const totalTariff = best.tariff;
      const totalTax = best.tax;
      const totalReservationCost = String(Number(totalTariff) + Number(totalTax));
      
      return this.executeCreateBooking(input, best, totalTariff, totalTax, totalReservationCost, hotelRow, '');
    }
  }

  private async executeCreateBooking(
    input: any,
    best: any,
    totalTariff: string,
    totalTax: string,
    totalReservationCost: string,
    hotelRow: any,
    tariffReferenceCode: string,
  ) {

    // 3) CreateBooking
    // Use calculated costs from HOBSE instead of room tariff/tax
    const finalAddress = (input.guest.address && input.guest.address.trim()) ? input.guest.address : `${input.guest.city || 'India'}, India`;
    const finalState = (input.guest.state && input.guest.state.trim()) ? input.guest.state : 'India';
    const finalCompanyName = (input.guest.billToCompanyName && input.guest.billToCompanyName.trim()) ? input.guest.billToCompanyName : `${input.guest.firstName} ${input.guest.lastName}`;
    const finalBillAddress = (input.guest.billToAddress && input.guest.billToAddress.trim()) ? input.guest.billToAddress : `${input.guest.city || 'India'}, India`;

    const createPayload = {
      bookingData: {
        hotelId: input.hotelId,
        channelBookingId: input.channelBookingId,
        pmsBookingId: '',
        priceOwnerType: this.PRICE_OWNER_TYPE,
        bookingStatus: '0',
        tariffMode: this.TARIFF_MODE,
        tariffReferenceCode: tariffReferenceCode || '',
        checkInDate: input.checkInDate,
        checkOutDate: input.checkOutDate,
        bookingAmount: totalReservationCost,
        netRate: totalTariff,
        taxAmount: totalTax,
        paidAmount: totalTariff,
        isPayAtHotel: 'Yes',
        amountToBeCollected: totalTariff,
        paymentInstruction: 'Pay at Checkout',
        bookingDesc: input.bookingDesc || '',
      },
      roomData: [
        {
          roomCode: best.roomCode,
          occupancyTypeCode: best.occupancyTypeCode,
          ratePlanCode: best.ratePlanCode,
          adultCount: String(input.adultCount),
          childCount: String(input.childCount),
          infantCount: String(input.infantCount),
          tariff: best.tariff,
          tax: best.tax,
        },
      ],
      guestData: {
        title: input.guest.title,
        firstName: input.guest.firstName,
        lastName: input.guest.lastName,
        mobileNumber: input.guest.mobileNumber,
        email: (input.guest.email && input.guest.email.trim()) ? input.guest.email : `${input.guest.firstName.toLowerCase()}.${input.guest.lastName.toLowerCase()}@dvi-travels.in`,
        address: finalAddress,
        state: finalState,
        city: input.guest.city || 'India',
        country: input.guest.country || 'India',
        billToTaxNumber: (input.guest.billToTaxNumber && input.guest.billToTaxNumber.trim()) ? input.guest.billToTaxNumber : '000000000000001',
        billToCompanyName: finalCompanyName,
        billToAddress: finalBillAddress,
      },
      bookingSourceData: {
        partnerType: this.PARTNER_TYPE,
        partnerId: this.PARTNER_ID,
        partnerTypeId: this.PARTNER_TYPE_ID,
        partnerCode: '',
        partnerName: '',
        partnerEmail: '',
        partnerPhoneNumber: '',
        partnerAddress: '',
        partnerState: '',
        partnerCity: '',
        partnerCountry: '',
        channelName: this.CHANNEL_NAME,
      },
    };

    this.logger.log(`\n📋 CALLING HOBSE CREATE BOOKING:`);
    this.logger.log(`   Booking Amount: ${totalReservationCost} (from CalculateReservationCost)`);
    this.logger.log(`   netRate: ${totalTariff}, taxAmount: ${totalTax}`);
    this.logger.log(`   paidAmount: ${totalTariff}, amountToBeCollected: ${totalTariff}`);
    this.logger.log(`   Guest: ${input.guest.firstName} ${input.guest.lastName}`);
    this.logger.log(`   Email: ${(input.guest.email && input.guest.email.trim()) ? input.guest.email : `${input.guest.firstName.toLowerCase()}.${input.guest.lastName.toLowerCase()}@dvi-travels.in`}`);
    this.logger.log(`   Mobile: ${input.guest.mobileNumber}`);
    this.logger.log(`   Address: ${finalAddress}`);
    this.logger.log(`   Company: ${finalCompanyName}`);
    
    // Write payload to file for debugging
    const fs = require('fs');
    const path = require('path');
    const payloadDir = path.join(process.cwd(), 'tmp');
    if (!fs.existsSync(payloadDir)) {
      fs.mkdirSync(payloadDir, { recursive: true });
    }
    const payloadPath = path.join(payloadDir, 'hobse_create_booking_payload.json');
    const payloadJson = JSON.stringify(createPayload, null, 2);
    fs.writeFileSync(payloadPath, payloadJson);
    this.logger.log(`✅ Payload written to ${payloadPath}`);

    const createResp = await this.postForm<any>('CreateBooking', createPayload);

    this.logger.log('\n🎉 HOBSE CreateBooking RESPONSE RECEIVED:');
    this.logger.log(`📥 Full response: ${JSON.stringify(createResp, null, 2)}`);
    
    // Check response structure
    const responseStatus = createResp?.hobse?.response?.status;
    const responseData = createResp?.hobse?.response?.data;
    
    this.logger.log(`\n📊 HOBSE CreateBooking Response Analysis:`);
    this.logger.log(`   Status Success: ${responseStatus?.success}`);
    this.logger.log(`   Status Code: ${responseStatus?.code}`);
    this.logger.log(`   Status Message: ${responseStatus?.message}`);
    this.logger.log(`   Has Response Data: ${!!responseData}`);
    
    if (responseData) {
      this.logger.log(`   Response Data: ${JSON.stringify(responseData, null, 2)}`);
    }
    
    if (responseStatus?.success === 'false' || responseStatus?.code !== '200') {
      const errors = createResp?.hobse?.response?.errors;
      this.logger.error(`❌ HOBSE CreateBooking FAILED!`);
      this.logger.error(`   Errors: ${JSON.stringify(errors, null, 2)}`);
    } else {
      this.logger.log(`✅ HOBSE CreateBooking SUCCESS!`);
    }

    return {
      provider: 'HOBSE',
      hotelId: input.hotelId,
      checkInDate: input.checkInDate,
      checkOutDate: input.checkOutDate,
      selectedRoom: best,
      cost: {
        totalTariff,
        totalTax,
        totalReservationCost,
        cancelTerm: hotelRow.cancelTerm || [],
        bookingPolicy: hotelRow.bookingPolicy || '',
      },
      apiResponse: createResp,
    };
  }
}
