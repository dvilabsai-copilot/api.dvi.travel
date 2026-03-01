import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { PrismaService } from '../../../prisma.service';
import * as fs from 'fs';
import * as path from 'path';
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

interface ResAvenueInventory {
  InvCode: number;
  Inventory: Array<{
    Date: string;
    InvCount: number;
    StopSell: boolean;
    CloseOnArrival: boolean;
    CloseOnDeparture: boolean;
  }>;
}

interface ResAvenueRate {
  RateCode: number;
  Rate: Array<{
    Date: string;
    Single: number;
    Double: number;
    Triple?: number;
    ExtraPax: number;
    ExtraChild: number;
    MinStay: number;
    MaxStay: number;
    StopSell: boolean;
  }>;
}

interface ResAvenueRoomType {
  InvTypeCode: number;
  InvTypeName: string;
  Occupancy: number;
}

interface ResAvenueRatePlan {
  RatePlanCode: number;
  RatePlanName: string;
  MealPlan: string;
}

interface RoomRateBreakup {
  Amount: number;
  EffectiveDate: string;
}

interface RoomRatesPayload {
  RoomRate: {
    Rates: RoomRateBreakup[];
  };
}

@Injectable()
export class ResAvenueHotelProvider implements IHotelProvider {
  private readonly BASE_URL = process.env.RESAVENUE_BASE_URL || 'http://203.109.97.241:8080/ChannelController';
  private readonly USERNAME = process.env.RESAVENUE_USERNAME || 'testpmsk4@resavenue.com';
  private readonly PASSWORD = process.env.RESAVENUE_PASSWORD || 'testpms@123';
  private readonly ID_CONTEXT = process.env.RESAVENUE_ID_CONTEXT || 'REV';

  private logger = new Logger(ResAvenueHotelProvider.name);
  private http: AxiosInstance = axios;
  private logFile = path.join(process.cwd(), 'resavenue-hotel-provider.log');

  constructor(private readonly prisma: PrismaService) {
    this.logger.log('🏨 ResAvenue Hotel Provider initialized');
    this.logger.log(`Using endpoint: ${this.BASE_URL}`);
    this.logger.log(`🔐 Credentials - Username: ${this.USERNAME}`);
    this.logger.log(`🔐 Credentials - Password: ${this.PASSWORD}`);
    this.logger.log(`🔐 Credentials - ID_Context: ${this.ID_CONTEXT}`);
  }

  private fileLog(message: string) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    try {
      fs.appendFileSync(this.logFile, logMessage);
    } catch (e) {
      // Ignore file write errors
    }
  }

  getName(): string {
    return 'ResAvenue';
  }

  /**
   * Get property details (master data: room types, rate plans)
   */
  private async getPropertyDetails(hotelCode: string): Promise<any> {
    try {
      const response = await this.http.post(
        `${this.BASE_URL}/PropertyDetails`,
        {
          OTA_HotelDetailsRQ: {
            POS: {
              Username: this.USERNAME,
              Password: this.PASSWORD,
              ID_Context: this.ID_CONTEXT,
            },
            TimeStamp: '20261015T15:22:50',
            EchoToken: `details-${Date.now()}`,
            HotelCode: hotelCode,
          },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          timeout: 30000,
        }
      );

      return response.data?.OTA_HotelDetailsRS?.[0] || null;
    } catch (error) {
      this.logger.error(`Failed to fetch property details for hotel ${hotelCode}: ${error.message}`);
      return null;
    }
  }

  /**
   * Get inventory (room availability) for specific dates
   */
  private async getInventory(
    hotelCode: string,
    startDate: string,
    endDate: string,
    invCodes: number[]
  ): Promise<ResAvenueInventory[]> {
    try {
      const response = await this.http.post(
        `${this.BASE_URL}/PropertyDetails`,
        {
          OTA_HotelInventoryRQ: {
            POS: {
              Username: this.USERNAME,
              Password: this.PASSWORD,
              ID_Context: this.ID_CONTEXT,
            },
            TimeStamp: '20261015T15:22:50',
            EchoToken: `inv-${Date.now()}`,
            HotelCode: hotelCode,
            Start: startDate,
            End: endDate,
            InvCodes: invCodes,
          },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          timeout: 30000,
        }
      );

      return response.data?.OTA_HotelInventoryRS?.Inventories || [];
    } catch (error) {
      this.logger.error(`Failed to fetch inventory for hotel ${hotelCode}: ${error.message}`);
      return [];
    }
  }

  /**
   * Get rates (pricing) for specific dates
   */
  private async getRates(
    hotelCode: string,
    startDate: string,
    endDate: string,
    rateCodes: number[]
  ): Promise<ResAvenueRate[]> {
    try {
      const response = await this.http.post(
        `${this.BASE_URL}/PropertyDetails`,
        {
          OTA_HotelRateRQ: {
            POS: {
              Username: this.USERNAME,
              Password: this.PASSWORD,
              ID_Context: this.ID_CONTEXT,
            },
            HotelCode: hotelCode,
            Start: startDate,
            End: endDate,
            RateCodes: rateCodes,
          },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          timeout: 30000,
        }
      );

      return response.data?.OTA_HotelRateRS?.Rates || [];
    } catch (error) {
      this.logger.error(`Failed to fetch rates for hotel ${hotelCode}: ${error.message}`);
      return [];
    }
  }

  /**
   * Main search method - searches for hotels by city
   */
  async search(
    criteria: HotelSearchCriteria,
    preferences?: HotelPreferences,
  ): Promise<HotelSearchResult[]> {
    const startTime = Date.now();
    this.logger.log(`\n   🏨 RESAVENUE PROVIDER: Starting hotel search for city: ${criteria.cityCode}`);

    try {
      // Step 1: Resolve city name from city code (supports both TBO codes and city names)
      let cityName = criteria.cityCode;
      
      // Check if cityCode is numeric (TBO format) - if so, look up the city name
      if (/^\d+$/.test(criteria.cityCode)) {
        const city = await this.prisma.dvi_cities.findFirst({
          where: { tbo_city_code: criteria.cityCode },
        });
        
        if (city) {
          cityName = city.name;
          this.logger.log(`   🗺️  Resolved TBO code ${criteria.cityCode} → ${cityName}`);
        } else {
          this.logger.warn(`   ⚠️  Could not resolve TBO city code: ${criteria.cityCode}`);
          return [];
        }
      }

      // Step 2: Query database for ResAvenue hotels in this city
      const hotels = await this.prisma.dvi_hotel.findMany({
        where: {
          hotel_city: cityName,
          resavenue_hotel_code: { not: null },
          deleted: false,
          status: 1,
        },
      });

      if (hotels.length === 0) {
        this.logger.log(`   📭 No ResAvenue hotels found in city: ${cityName}`);
        return [];
      }

      this.logger.log(`   📋 Found ${hotels.length} ResAvenue hotel(s) in ${cityName}`);

      // Step 3: For each hotel, fetch live data from ResAvenue
      const hotelSearchPromises = hotels.map((hotel) =>
        this.searchHotel(hotel, criteria)
      );

      const results = await Promise.all(hotelSearchPromises);
      const validResults = results.filter((r) => r !== null) as HotelSearchResult[];

      const totalTime = Date.now() - startTime;
      this.logger.log(`   ✅ ResAvenue search completed: ${validResults.length}/${hotels.length} hotels available (${totalTime}ms)`);

      return validResults;
    } catch (error) {
      this.logger.error(`   ❌ ResAvenue search error: ${error.message}`);
      throw new InternalServerErrorException(`ResAvenue search failed: ${error.message}`);
    }
  }

  /**
   * Search individual hotel - fetch property details, inventory and rates dynamically
   */
  private async searchHotel(
    hotel: any,
    criteria: HotelSearchCriteria
  ): Promise<HotelSearchResult | null> {
    const hotelCode = hotel.resavenue_hotel_code;
    
    try {
      // Step 1: Fetch PropertyDetails to get room and rate codes dynamically
      const propertyDetails = await this.getPropertyDetails(hotelCode);
      if (!propertyDetails || !propertyDetails.RoomTypes) {
        this.logger.warn(`   ⚠️  Hotel ${hotelCode}: No property details available`);
        return null;
      }

      // Step 2: Extract active room and rate codes from PropertyDetails
      const roomTypes = propertyDetails.RoomTypes.filter((room: any) => room.room_status === 'active');
      
      if (roomTypes.length === 0) {
        this.logger.debug(`   📭 Hotel ${hotel.hotel_name} (${hotelCode}): No active rooms`);
        return null;
      }

      const invCodes: number[] = [];
      const rateCodes: number[] = [];
      const roomTypeMap: Map<number, any> = new Map();
      const ratePlanMap: Map<number, any> = new Map();

      // Build maps for room types and rate plans
      roomTypes.forEach((room: any) => {
        invCodes.push(room.room_id);
        roomTypeMap.set(room.room_id, room);

        if (room.RatePlans) {
          room.RatePlans.filter((rate: any) => rate.rate_status === 'active').forEach((rate: any) => {
            rateCodes.push(rate.rate_id);
            ratePlanMap.set(rate.rate_id, rate);
          });
        }
      });

      if (invCodes.length === 0 || rateCodes.length === 0) {
        this.logger.debug(`   📭 Hotel ${hotel.hotel_name} (${hotelCode}): No active rooms/rates`);
        return null;
      }

      // Step 3: Fetch live inventory and rates for the date range
      const [inventories, rates] = await Promise.all([
        this.getInventory(hotelCode, criteria.checkInDate, criteria.checkOutDate, invCodes),
        this.getRates(hotelCode, criteria.checkInDate, criteria.checkOutDate, rateCodes),
      ]);

      if (inventories.length === 0 || rates.length === 0) {
        this.logger.debug(`   📭 Hotel ${hotel.hotel_name} (${hotelCode}): No inventory/rates returned`);
        return null;
      }

      // Step 4: Check if rooms are available
      const availableRooms = this.findAvailableRooms(
        inventories,
        rates,
        roomTypeMap,
        ratePlanMap,
        criteria
      );

      if (availableRooms.length === 0) {
        this.logger.debug(`   📭 Hotel ${hotel.hotel_name} (${hotelCode}): No availability`);
        return null;
      }

      // Calculate minimum price
      const minPrice = Math.min(...availableRooms.map((r) => r.price));

      // Build search result
      const result: HotelSearchResult = {
        provider: 'ResAvenue',
        hotelCode: hotelCode,
        hotelName: hotel.hotel_name,
        cityCode: hotel.hotel_city,
        address: hotel.hotel_address || '',
        rating: hotel.hotel_category || 0,
        category: `${hotel.hotel_category || 0}-star`,
        facilities: [],
        images: [],
        price: minPrice,
        currency: 'INR',
        roomTypes: availableRooms,
        searchReference: `RESAVENUE-${hotelCode}-${Date.now()}`,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 minutes
      };

      this.logger.log(`   ✅ ${hotel.hotel_name}: ${availableRooms.length} room(s), from ₹${minPrice}`);
      return result;
    } catch (error) {
      this.logger.error(`   ❌ Error searching hotel ${hotelCode}: ${error.message}`);
      return null;
    }
  }

  /**
   * Find available rooms by matching inventory and rates with PropertyDetails metadata
   */
  private findAvailableRooms(
    inventories: ResAvenueInventory[],
    rates: ResAvenueRate[],
    roomTypeMap: Map<number, any>,
    ratePlanMap: Map<number, any>,
    criteria: HotelSearchCriteria
  ): RoomType[] {
    const availableRooms: RoomType[] = [];

    // For each room type with inventory
    for (const inv of inventories) {
      // Check if all dates have availability
      const allDatesAvailable = inv.Inventory.every(
        (day) => day.InvCount >= criteria.roomCount && !day.StopSell
      );

      if (!allDatesAvailable) continue;

      // Get room metadata from PropertyDetails
      const roomType = roomTypeMap.get(inv.InvCode);
      if (!roomType) continue;

      // Find rates for this room type
      for (const rate of rates) {
        // Check if all dates have valid rates
        const allDatesHaveRates = rate.Rate.every((day) => !day.StopSell);
        if (!allDatesHaveRates) continue;

        // Get rate plan metadata from PropertyDetails
        const ratePlan = ratePlanMap.get(rate.RateCode);
        if (!ratePlan) continue;

        // Calculate total price for the stay
        const totalPrice = rate.Rate.reduce((sum, day) => {
          const pricePerRoom = criteria.guestCount === 1 ? day.Single : day.Double;
          return sum + pricePerRoom * criteria.roomCount;
        }, 0);

        availableRooms.push({
          roomCode: `${inv.InvCode}-${rate.RateCode}`,
          roomName: `${roomType.room_name} - ${ratePlan.rate_name}`,
          bedType: 'Standard',
          capacity: roomType.max_occupancy || 2,
          price: totalPrice,
          cancellationPolicy: 'As per hotel policy',
        });
      }
    }

    return availableRooms;
  }

  /**
   * Confirm hotel booking using OTA_HotelResNotifRQ (Booking Push)
   * Now includes per-night rate breakup from Rate Fetch API
   */
  async confirmBooking(bookingDetails: HotelConfirmationDTO): Promise<HotelConfirmationResult> {
    try {
      this.logger.log(`\n   📝 RESAVENUE: Confirming booking for hotel ${bookingDetails.hotelCode}`);

      // Extract room and rate codes from roomCode (format: "InvCode-RateCode")
      const [invCode, rateCodeStr] = bookingDetails.rooms[0].roomCode.split('-');
      const rateCode = parseInt(rateCodeStr, 10);
      const guestCount = bookingDetails.rooms[0].guestCount;
      const uniqueBookingRef = `DVI-${Date.now()}`;
      const now = new Date();
      const timestamp = now.toISOString().replace(/\.\d{3}Z$/, '');

      // Step 1: Fetch rates for this booking to populate RoomRates breakup
      this.logger.log(
        `\n   Step 1️⃣ : Fetching rate details for RatePlan ${rateCode}...`
      );
      let rateFetchResponse: ResAvenueRate[];
      try {
        rateFetchResponse = await this.fetchResavenueRatesForBooking(
          bookingDetails.hotelCode,
          bookingDetails.checkInDate,
          bookingDetails.checkOutDate,
          [rateCode]
        );
      } catch (rateFetchError) {
        this.logger.warn(
          `   ⚠️  Rate Fetch failed: ${rateFetchError.message}. Using fallback rates.`
        );
        // Fallback: Create synthetic rate with default per-night rate
        const nights = this.getStayNights(bookingDetails.checkInDate, bookingDetails.checkOutDate);
        const perNightRate = 1000; // Default fallback rate
        
        rateFetchResponse = [
          {
            RateCode: rateCode,
            Rate: nights.map((night) => ({
              Date: night,
              Single: perNightRate,
              Double: perNightRate,
              Triple: perNightRate,
              ExtraPax: 0,
              ExtraChild: 0,
              MinStay: 1,
              MaxStay: 30,
              StopSell: false,
            })),
          },
        ];
        
        this.logger.log(
          `   ✅ Using fallback rates: ₹${perNightRate} per night for ${nights.length} night(s)`
        );
      }

      // Step 2: Build per-night rate breakup
      this.logger.log(
        `\n   Step 2️⃣ : Building per-night rate breakup for ${guestCount} guest(s)...`
      );
      const { roomRatesPayload, totalAmount } = this.buildRoomRatesBreakup(
        bookingDetails.checkInDate,
        bookingDetails.checkOutDate,
        rateFetchResponse,
        rateCode,
        guestCount
      );

      // Build OTA_HotelResNotifRQ according to ResAvenue API documentation
      const bookingRequest = {
        OTA_HotelResNotifRQ: {
          Target: 'Production',
          Version: '1.0',
          EchoToken: `booking-${Date.now()}`,
          TimeStamp: timestamp,
          POS: {
            Username: this.USERNAME,
            Password: this.PASSWORD,
            ID_Context: this.ID_CONTEXT,
          },
          HotelReservations: {
            HotelReservation: [
              {
                UniqueID: {
                  ID: uniqueBookingRef,
                  OTA: 'DVI',
                  BookingSource: 'DVI Journey Manager',
                },
                ResStatus: 'Confirm',
                RoomStays: {
                  RoomStay: bookingDetails.rooms.map((room) => ({
                    TimeSpan: {
                      Start: bookingDetails.checkInDate,
                      End: bookingDetails.checkOutDate,
                    },
                    BasicPropertyInfo: {
                      HotelCode: bookingDetails.hotelCode,
                      HotelName: '',
                    },
                    GuestCounts: {
                      GuestCount: [
                        {
                          Count: room.guestCount,
                          AgeQualifyingCode: '10', // 10 = Adult
                        },
                      ],
                    },
                    RoomTypes: {
                      RoomType: {
                        NumberOfUnits: room.quantity,
                        RoomDescription: {
                          Name: '',
                        },
                        RoomTypeCode: invCode,
                      },
                    },
                    Total: {
                      CurrencyCode: 'INR',
                      Amount: totalAmount, // Set from Rate Fetch API
                    },
                    RatePlans: {
                      RatePlan: {
                        RatePlanName: '',
                        RatePlanCode: rateCode.toString(),
                      },
                    },
                    RoomRates: roomRatesPayload, // ✅ Populated from buildRoomRatesBreakup
                    ResGuestRPHs: {
                      ResGuestRPH: {
                        RPH: 0,
                      },
                    },
                  })),
                },
                ResGlobalInfo: {
                  SpecialRequest: '',
                  Total: {
                    CurrencyCode: 'INR',
                    TotalTax: 0,
                    TaxType: 'Inclusive',
                    TotalBookingAmount: totalAmount, // Sum of per-night amounts
                    Commission: 0,
                    CommissionType: 'Inclusive',
                  },
                },
                CreateDateTime: timestamp,
                PayAtHotel: 'Y',
                ResGuests: {
                  ResGuest: bookingDetails.guests.map((guest, index) => ({
                    Profiles: {
                      ProfileInfo: {
                        UniqueID: {
                          Type: '1',
                          ID_Context: `Guest-${index + 1}`,
                        },
                        Profile: {
                          ProfileType: '1', // 1 = Guest
                          Customer: {
                            PersonName: {
                              GivenName: guest.firstName,
                              Surname: guest.lastName,
                            },
                            Email: guest.email,
                            Contact: guest.phone,
                          },
                        },
                      },
                    },
                    ResGuestRPH: index,
                  })),
                },
              },
            ],
          },
        },
      };

      // Add authentication credentials (as per ResAvenue OTA API documentation)
      bookingRequest.OTA_HotelResNotifRQ.POS = {
        Username: this.USERNAME,
        Password: this.PASSWORD,
        ID_Context: this.ID_CONTEXT,
      };

      this.logger.log(`\n   Step 3️⃣ : Sending Booking Push to ResAvenue...`);
      this.logger.log(`🔐 Authentication being sent:`);
      this.logger.log(`   - Username: ${this.USERNAME}`);
      this.logger.log(`   - Password: ${this.PASSWORD}`);
      this.logger.log(`   - ID_Context: ${this.ID_CONTEXT}`);
      
      this.logger.debug(`📤 Booking request: ${JSON.stringify(bookingRequest, null, 2)}`);

      // Send booking push to ResAvenue with authentication via RequestorID in body
      const response = await this.http.post(
        `${this.BASE_URL}/bookingNotification.auto?ota=AGENTSBOOKING`,
        bookingRequest,
        {
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          timeout: 30000,
        }
      );

      this.logger.debug(`📥 Booking response: ${JSON.stringify(response.data, null, 2)}`);

      // Check response status
      const status = response.data?.OTA_HotelResNotifRS?.Status;
      if (status === 'Failure') {
        const remark = response.data?.OTA_HotelResNotifRS?.Remark || 'Unknown error';
        throw new Error(`Booking failed: ${remark}`);
      }

      this.logger.log(`\n   ✅ Booking confirmed: ${uniqueBookingRef}`);
      this.logger.log(`   💰 Total Amount: ₹${totalAmount}`);
      this.logger.log(`   📊 Room Rates: ${roomRatesPayload.RoomRate.Rates.length} night(s)`);

      return {
        provider: 'ResAvenue',
        confirmationReference: uniqueBookingRef,
        hotelCode: bookingDetails.hotelCode,
        hotelName: '',
        checkIn: bookingDetails.checkInDate,
        checkOut: bookingDetails.checkOutDate,
        roomCount: bookingDetails.roomCount,
        totalPrice: totalAmount,
        priceBreadown: {
          roomCharges: totalAmount,
          taxes: 0,
          discounts: 0,
        },
        cancellationPolicy: 'As per hotel policy',
        status: 'confirmed',
        bookingDeadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      };
    } catch (error) {
      this.logger.error(`   ❌ Booking confirmation failed: ${error.message}`);
      throw new InternalServerErrorException(`ResAvenue booking failed: ${error.message}`);
    }
  }

  /**
   * Cancel hotel booking using OTA_HotelResNotifRQ with ResStatus='Cancel'
   */
  async cancelBooking(confirmationRef: string, reason: string): Promise<CancellationResult> {
    try {
      this.logger.log(`\n   ❌ RESAVENUE: Cancelling booking ${confirmationRef}`);

      const now = new Date();
      const timestamp = now.toISOString().replace(/\.\d{3}Z$/, '');

      // Build cancellation request using OTA_HotelResNotifRQ format
      const cancellationRequest = {
        OTA_HotelResNotifRQ: {
          Target: 'Production',
          Version: '1.0',
          EchoToken: `cancel-${Date.now()}`,
          TimeStamp: timestamp,
          POS: {
            RequestorID: {
              User: this.USERNAME,
              Password: this.PASSWORD,
              ID_Context: this.ID_CONTEXT,
            },
          },
          HotelReservations: {
            HotelReservation: [
              {
                UniqueID: {
                  ID: confirmationRef,
                  OTA: 'DVI',
                  BookingSource: 'DVI Journey Manager',
                },
                ResStatus: 'Cancel',
                ResGlobalInfo: {
                  SpecialRequest: reason,
                },
              },
            ],
          },
        },
      };

      this.logger.debug(`📤 Cancellation request: ${JSON.stringify(cancellationRequest, null, 2)}`);

      const response = await this.http.post(
        `${this.BASE_URL}/bookingNotification.auto?ota=AGENTSBOOKING`,
        cancellationRequest,
        {
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          timeout: 30000,
        }
      );

      this.logger.debug(`📥 Cancellation response: ${JSON.stringify(response.data, null, 2)}`);

      // Check response status
      const status = response.data?.OTA_HotelResNotifRS?.Status;
      if (status === 'Failure') {
        const remark = response.data?.OTA_HotelResNotifRS?.Remark || 'Unknown error';
        throw new Error(`Cancellation failed: ${remark}`);
      }

      this.logger.log(`   ✅ Booking cancelled: ${confirmationRef}`);

      return {
        cancellationRef: confirmationRef,
        refundAmount: 0, // Would come from API response
        charges: 0, // Would come from API response
        refundDays: 5, // Default refund period
      };
    } catch (error) {
      this.logger.error(`   ❌ Cancellation failed: ${error.message}`);
      throw new InternalServerErrorException(`ResAvenue cancellation failed: ${error.message}`);
    }
  }

  /**
   * Fetch rates for booking (OTA_HotelRateRQ) - Used to populate RoomRates breakup
   * Returns per-date pricing for specified rate codes
   */
  private async fetchResavenueRatesForBooking(
    hotelCode: string,
    startDate: string,
    endDate: string,
    rateCodes: number[]
  ): Promise<ResAvenueRate[]> {
    try {
      const echoToken = `rate-book-${Date.now()}`;
      
      // Validate and normalize dates to ensure YYYY-MM-DD format
      let normalizedStartDate = startDate;
      let normalizedEndDate = endDate;
      
      // If date is a Date object, convert to ISO string
      if (startDate && typeof startDate === 'object' && 'toISOString' in (startDate as object)) {
        normalizedStartDate = (startDate as Date).toISOString().split('T')[0];
      } else if (typeof startDate === 'string' && startDate.includes('T')) {
        // If it's ISO datetime string, extract just the date part
        normalizedStartDate = startDate.split('T')[0];
      }
      
      if (endDate && typeof endDate === 'object' && 'toISOString' in (endDate as object)) {
        normalizedEndDate = (endDate as Date).toISOString().split('T')[0];
      } else if (typeof endDate === 'string' && endDate.includes('T')) {
        normalizedEndDate = endDate.split('T')[0];
      }

      // DEBUG: Log exact parameters being sent
      this.logger.log(`\n   🔍 [RATE FETCH DEBUG - REQUEST PARAMS]`);
      this.logger.log(`      Hotel Code: ${hotelCode} (type: ${typeof hotelCode})`);
      this.logger.log(`      Start Date: ${normalizedStartDate} (original: ${startDate}, type: ${typeof startDate})`);
      this.logger.log(`      End Date: ${normalizedEndDate} (original: ${endDate}, type: ${typeof endDate})`);
      this.logger.log(`      Rate Codes: ${JSON.stringify(rateCodes)} (types: ${rateCodes.map(r => typeof r).join(',')})`);
      this.logger.log(`      Echo Token: ${echoToken}`);
      this.logger.log(`      Endpoint: ${this.BASE_URL}/PropertyDetails`);
      this.logger.log(`      Username: ${this.USERNAME}`);
      this.logger.log(`      ID_Context: ${this.ID_CONTEXT}\n`);

      // Validate date range
      if (normalizedStartDate >= normalizedEndDate) {
        throw new Error(`Invalid date range: Start (${normalizedStartDate}) must be before End (${normalizedEndDate})`);
      }

      const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, '');
      const requestBody = {
        OTA_HotelRateRQ: {
          POS: {
            RequestorID: {
              User: this.USERNAME,
              Password: this.PASSWORD,
              ID_Context: this.ID_CONTEXT,
            },
          },
          EchoToken: echoToken,
          TimeStamp: timestamp,
          HotelCode: hotelCode,
          Start: normalizedStartDate,
          End: normalizedEndDate,
          RateCodes: rateCodes,
        },
      };

      // DEBUG: Log exact request body being sent with AUTH
      this.logger.log(`   🔍 [RATE FETCH DEBUG - FULL REQUEST BODY WITH AUTH]`);
      this.logger.log(JSON.stringify(requestBody, null, 2));
      
      // Log auth credentials separately for debugging
      this.logger.log(`\n   🔑 [RATE FETCH DEBUG - AUTHENTICATION DETAILS]`);
      this.logger.log(`      Username: ${this.USERNAME}`);
      this.logger.log(`      Password: ${this.PASSWORD ? '***REDACTED***' : 'NOT SET'}`);
      this.logger.log(`      ID_Context: ${this.ID_CONTEXT}`);
      this.logger.log(`      Base URL: ${this.BASE_URL}`);
      this.logger.log(`      Full Endpoint: ${this.BASE_URL}/PropertyDetails\n`);

      // Build auth without Basic header - use RequestorID in body instead
      const axiosConfig = {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        timeout: 30000,
      };

      // Log the actual request being sent
      this.logger.log(`   🌐 [RATE FETCH DEBUG - AXIOS REQUEST]`);
      this.logger.log(`      Method: POST`);
      this.logger.log(`      URL: ${this.BASE_URL}/PropertyDetails`);
      this.logger.log(`      Headers: ${JSON.stringify(axiosConfig.headers, null, 2)}`);
      this.logger.log(`      Data: ${JSON.stringify(requestBody, null, 2)}\n`);

      const response = await this.http.post(
        `${this.BASE_URL}/PropertyDetails`,
        requestBody,
        axiosConfig
      );

      // DEBUG: Log success response
      this.logger.log(`\n   🔍 [RATE FETCH DEBUG - RESPONSE]`);
      this.logger.log(`      Status: ${response.status}`);
      this.logger.log(`      Rates Returned: ${response.data?.OTA_HotelRateRS?.Rates?.length || 0}`);

      const rates = response.data?.OTA_HotelRateRS?.Rates || [];
      this.logger.log(
        `   ✅ Rate Fetch successful: ${rates.length} rate plan(s) with daily breakup`
      );
      return rates;
    } catch (error: any) {
      // DEBUG: Log exact error details with AUTH info
      this.logger.error(`\n   ❌ [RATE FETCH DEBUG - ERROR RESPONSE]`);
      this.logger.error(`      Status Code: ${error.response?.status || 'NO RESPONSE'}`);
      this.logger.error(`      Status Text: ${error.response?.statusText || 'N/A'}`);
      this.logger.error(`      Message: ${error.message}`);
      
      // Log auth that was attempted
      this.logger.error(`\n   🔑 [RATE FETCH DEBUG - AUTH THAT WAS SENT]`);
      this.logger.error(`      Username: ${this.USERNAME}`);
      this.logger.error(`      Password: ${this.PASSWORD ? '***' : 'NOT SET'}`);
      this.logger.error(`      ID_Context: ${this.ID_CONTEXT}`);
      
      if (error.response?.data) {
        this.logger.error(`\n   📋 [RATE FETCH DEBUG - ERROR RESPONSE DATA]`);
        this.logger.error(JSON.stringify(error.response.data, null, 2));
      }
      
      if (error.config) {
        this.logger.error(`\n   🌐 [RATE FETCH DEBUG - REQUEST CONFIG THAT FAILED]`);
        this.logger.error(`      URL: ${error.config.url}`);
        this.logger.error(`      Method: ${error.config.method}`);
        this.logger.error(`      Headers: ${JSON.stringify(error.config.headers, null, 2)}`);
        
        // Try to parse and log the body if it exists
        if (error.config.data) {
          try {
            const bodyData = typeof error.config.data === 'string' 
              ? JSON.parse(error.config.data) 
              : error.config.data;
            this.logger.error(`      Request Body (with credentials):`);
            this.logger.error(JSON.stringify(bodyData, null, 2));
          } catch (e) {
            this.logger.error(`      Request Body: ${error.config.data}`);
          }
        }
      }

      this.logger.error(`   ❌ Rate Fetch failed for hotel ${hotelCode}: ${error.message}\n`);
      throw new InternalServerErrorException(
        `Failed to fetch rates for booking: ${error.message}`
      );
    }
  }

  /**
   * Calculate stay nights (check-in to check-out, excluding check-out day)
   */
  private getStayNights(checkInDate: string, checkOutDate: string): string[] {
    const nights: string[] = [];
    const current = new Date(checkInDate);
    const checkout = new Date(checkOutDate);

    while (current < checkout) {
      const year = current.getFullYear();
      const month = String(current.getMonth() + 1).padStart(2, '0');
      const day = String(current.getDate()).padStart(2, '0');
      nights.push(`${year}-${month}-${day}`);
      current.setDate(current.getDate() + 1);
    }

    return nights;
  }

  /**
   * Build per-night rate breakup for RoomRates section of booking push
   * Constructs the Rates array with Amount and EffectiveDate for each night
   */
  private buildRoomRatesBreakup(
    checkInDate: string,
    checkOutDate: string,
    rateFetchResponse: ResAvenueRate[],
    selectedRateCode: number,
    guestCount: number
  ): { roomRatesPayload: RoomRatesPayload; totalAmount: number } {
    const nights = this.getStayNights(checkInDate, checkOutDate);
    const rates: RoomRateBreakup[] = [];
    let totalAmount = 0;

    // Find the rate plan matching selectedRateCode in the API response
    const selectedRatePlan = rateFetchResponse.find(
      (r) => r.RateCode === selectedRateCode
    );

    if (!selectedRatePlan) {
      throw new Error(
        `Rate code ${selectedRateCode} not found in Rate Fetch response. ` +
        `Available codes: ${rateFetchResponse.map((r) => r.RateCode).join(', ')}`
      );
    }

    // For each night in the stay, find the matching rate
    for (const night of nights) {
      const dailyRate = selectedRatePlan.Rate.find((r) => r.Date === night);

      if (!dailyRate) {
        this.logger.error(
          `   ⚠️  Missing rate for date ${night} in rate code ${selectedRateCode}`
        );
        throw new Error(
          `No rate found for date ${night}. Available dates: ` +
          `${selectedRatePlan.Rate.map((r) => r.Date).join(', ')}`
        );
      }

      // Select price based on guest count
      let nightlyAmount: number;
      switch (guestCount) {
        case 1:
          nightlyAmount = dailyRate.Single;
          break;
        case 2:
          nightlyAmount = dailyRate.Double;
          break;
        case 3:
          nightlyAmount = dailyRate.Triple || dailyRate.Double;
          break;
        case 4:
          // Quad: typically Triple + ExtraPax
          nightlyAmount = (dailyRate.Triple || dailyRate.Double) + dailyRate.ExtraPax;
          break;
        default:
          throw new Error(
            `Unsupported guest count: ${guestCount}. Expected 1-4 guests.`
          );
      }

      rates.push({
        Amount: nightlyAmount,
        EffectiveDate: night,
      });

      totalAmount += nightlyAmount;
    }

    this.logger.log(
      `   📊 Room Rate Breakup: ${nights.length} night(s), ` +
      `Total: ₹${totalAmount}, GuestCount: ${guestCount}`
    );

    return {
      roomRatesPayload: {
        RoomRate: {
          Rates: rates,
        },
      },
      totalAmount,
    };
  }

  /**
   * Get booking confirmation details using OTA_HotelResNotifRQ (Booking Pull)
   */
  async getConfirmation(confirmationRef: string): Promise<HotelConfirmationDetails> {
    try {
      this.logger.log(`\n   📋 RESAVENUE: Getting confirmation for ${confirmationRef}`);

      const now = new Date();
      const timestamp = now.toISOString().replace(/\.\d{3}Z$/, '');

      // Build booking pull request
      const pullRequest = {
        OTA_HotelResNotifRQ: {
          EchoToken: `pull-${Date.now()}`,
          TimeStamp: timestamp,
          Target: 'Production',
          Version: '1.0',
          POS: {
            RequestorID: {
              User: this.USERNAME,
              Password: this.PASSWORD,
              ID_Context: this.ID_CONTEXT,
            },
          },
          PropertyId: confirmationRef, // Booking reference
          FromDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // Last 30 days
          ToDate: new Date().toISOString().split('T')[0], // Today
        },
      };

      this.logger.debug(`📤 Pull request: ${JSON.stringify(pullRequest, null, 2)}`);

      const response = await this.http.post(
        `${this.BASE_URL}/PropertyDetails`,
        pullRequest,
        {
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          timeout: 30000,
        }
      );

      this.logger.debug(`📥 Pull response: ${JSON.stringify(response.data, null, 2)}`);

      const reservations = response.data?.OTA_HotelResNotifRQ?.HotelReservations;
      if (!reservations || reservations.length === 0) {
        throw new Error('Booking not found');
      }

      // Find the booking with matching ID
      const booking = reservations.find(
        (res: any) => res.HotelReservation?.[0]?.UniqueID?.ID === confirmationRef
      );

      if (!booking) {
        throw new Error('Booking not found');
      }

      const hotelRes = booking.HotelReservation[0];
      const roomStay = hotelRes.RoomStays?.RoomStay?.[0];
      const resGlobalInfo = hotelRes.ResGlobalInfo;

      this.logger.log(`   ✅ Booking details retrieved`);

      return {
        confirmationRef: confirmationRef,
        hotelName: roomStay?.BasicPropertyInfo?.HotelName || '',
        checkIn: roomStay?.TimeSpan?.Start || '',
        checkOut: roomStay?.TimeSpan?.End || '',
        roomCount: roomStay?.RoomTypes?.RoomType?.NumberOfUnits || 1,
        totalPrice: parseFloat(resGlobalInfo?.Total?.TotalBookingAmount) || 0,
        status: hotelRes.ResStatus || 'Confirmed',
        cancellationPolicy: 'As per hotel policy',
      };
    } catch (error) {
      this.logger.error(`   ❌ Get confirmation failed: ${error.message}`);
      throw new InternalServerErrorException(
        `Failed to get confirmation details: ${error.message}`
      );
    }
  }
}
