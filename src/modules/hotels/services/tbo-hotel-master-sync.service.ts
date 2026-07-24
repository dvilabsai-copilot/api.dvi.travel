import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { PrismaService } from '../../../prisma.service';

/**
 * TBO Hotel Master Data Sync Service
 *
 * Fetches hotel master data from TBO's GetHotels API and syncs to tbo_hotel_master table
 * This ensures we always have real hotel names instead of generic "Hotel {code}" fallbacks
 *
 * Data flow:
 * 1. Call TBO's GetHotels API for a city
 * 2. Extract hotel details (name, address, rating, etc.)
 * 3. Upsert into tbo_hotel_master table
 * 4. Schedule periodic sync (daily/weekly) to keep data fresh
 */
@Injectable()
export class TboHotelMasterSyncService implements OnModuleInit, OnModuleDestroy {
  private logger = new Logger(TboHotelMasterSyncService.name);
 private readonly SHARED_API_URL = process.env.TBO_SHARED_API_URL || 'https://api.travelboutiqueonline.com/SharedAPI';
 private readonly TBO_MASTER_API_BASE = process.env.TBO_STATIC_API_URL || 'http://affiliate.travelboutiqueonline.com/TBOHolidays_HotelAPI';
 private readonly CITY_LIST_API_URL = process.env.TBO_CITY_LIST_URL || 'http://affiliate.travelboutiqueonline.com/TBOHolidays_HotelAPI/CityList';
  private readonly TBO_STATIC_USERNAME = process.env.TBO_STATIC_USERNAME || 'IXMD112';
  private readonly TBO_STATIC_PASSWORD = process.env.TBO_STATIC_PASSWORD || 'api-11#M$new';
  private readonly USERNAME = process.env.TBO_USERNAME || 'IXMD112';
  private readonly PASSWORD = process.env.TBO_PASSWORD || 'api-11#M$new';
  private http: AxiosInstance = axios;
  private tokenId: string | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private isSyncRunning = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    const enabled = String(process.env.TBO_STATIC_SYNC_ENABLED || 'true').toLowerCase() === 'true';
    if (!enabled) {
 this.logger.log(' TBO static sync scheduler is disabled by TBO_STATIC_SYNC_ENABLED=false');
      return;
    }

    const intervalDays = Number(process.env.TBO_STATIC_SYNC_INTERVAL_DAYS || 15);
    const intervalMs = Math.max(intervalDays, 1) * 24 * 60 * 60 * 1000;

    this.syncTimer = setInterval(() => {
      this.runScheduledSync().catch((error) => {
 this.logger.error(` Scheduled TBO static sync failed: ${error.message}`);
      });
    }, intervalMs);

 this.logger.log(` TBO static sync scheduler started (every ${Math.max(intervalDays, 1)} day(s))`);

    if (this.syncTimer.unref) {
      this.syncTimer.unref();
    }

    const runOnStart = String(process.env.TBO_STATIC_SYNC_RUN_ON_START || 'false').toLowerCase() === 'true';
    if (runOnStart) {
      this.runScheduledSync().catch((error) => {
 this.logger.error(` Startup TBO static sync failed: ${error.message}`);
      });
    }
  }

  onModuleDestroy() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  private async runScheduledSync(): Promise<void> {
    if (this.isSyncRunning) {
 this.logger.warn(' Skipping scheduled TBO static sync because previous run is still in progress');
      return;
    }

    this.isSyncRunning = true;
    const startedAt = Date.now();

    try {
 this.logger.log(' Starting scheduled TBO static sync');
      const results = await this.syncAllCities();
      const totalSynced = Array.from(results.values()).reduce((sum, value) => sum + Number(value || 0), 0);
 this.logger.log(
        `✅ Scheduled TBO static sync completed. Cities=${results.size}, HotelsSynced=${totalSynced}, DurationMs=${Date.now() - startedAt}`,
      );
    } finally {
      this.isSyncRunning = false;
    }
  }

 /**
   * Authenticate with TBO to get TokenId for GetHotels API
 */
  private async authenticate(): Promise<string> {
    if (this.tokenId) {
      return this.tokenId;
    }

    try {
      const authRequest = {
        ClientId: process.env.TBO_CLIENT_ID || 'tboprod',
        UserName: this.USERNAME,
        Password: this.PASSWORD,
        EndUserIp: process.env.TBO_END_USER_IP || '134.209.145.185',
      };

      const response = await this.http.post(
        `${this.SHARED_API_URL}/SharedData.svc/rest/Authenticate`,
        authRequest,
        {
          timeout: 30000,
          headers: { 'Content-Type': 'application/json' },
        }
      );

      if (response.data?.Status !== 1 || !response.data?.TokenId) {
        throw new Error(`Auth failed: ${response.data?.Error?.ErrorMessage || 'Unknown'}`);
      }

      this.tokenId = response.data.TokenId;
 this.logger.log(' TBO Authentication successful for hotel sync');
      return this.tokenId;
    } catch (error) {
 this.logger.error(` TBO Auth failed: ${error.message}`);
      throw error;
    }
  }

 /**
   * Fetch hotel master data from TBO GetHotels API
   * @param tboCityCode - TBO city code (e.g., "127343" for Chennai)
 */
  async syncHotelsForCity(tboCityCode: string): Promise<number> {
    try {
 this.logger.log(` Starting hotel master sync for TBO city code: ${tboCityCode}`);

 // Step 1: Call TBOHotelCodeList API (same source used in proven manual Ooty sync)
      const hotels = await this.fetchHotelsFromTboHotelCodeList(tboCityCode);
 this.logger.log(` Fetched ${hotels.length} hotels from TBO for city ${tboCityCode}`);

      if (hotels.length === 0) {
 this.logger.warn(` No hotels returned for city ${tboCityCode}`);
        return 0;
      }

 // Step 2: Upsert hotels into database
      let upsertedCount = 0;
      for (const hotel of hotels) {
        try {
          const hotelCode = String(hotel.HotelCode || hotel.hotelCode || '').trim();
          if (!hotelCode) {
            continue;
          }

          const coords = this.extractCoordinates(hotel);
          const latitude = coords.latitude;
          const longitude = coords.longitude;

          await this.prisma.tbo_hotel_master.upsert({
            where: { tbo_hotel_code: hotelCode },
            create: {
              tbo_hotel_code: hotelCode,
              tbo_city_code: tboCityCode,
              hotel_name: hotel.HotelName || hotel.hotelName || `Hotel ${hotelCode}`,
              hotel_address: hotel.Address || '',
              city_name: hotel.CityName || '',
              star_rating: this.parseStarRating(
                hotel.HotelCategory || hotel.HotelRating || hotel.hotelRating || hotel.StarRating || hotel.starRating,
              ),
              hotel_latitude: latitude,
              hotel_longitude: longitude,
              hotel_image_url: hotel.Image || '',
              description: hotel.Description || '',
              check_in_time: hotel.CheckInTime || '',
              check_out_time: hotel.CheckOutTime || '',
              facilities: hotel.Facilities ? JSON.stringify(hotel.Facilities) : null,
            },
            update: {
              hotel_name: hotel.HotelName || undefined,
              hotel_address: hotel.Address || undefined,
              city_name: hotel.CityName || undefined,
              star_rating: this.parseStarRating(
                hotel.HotelCategory || hotel.HotelRating || hotel.hotelRating || hotel.StarRating || hotel.starRating,
              ),
              hotel_latitude: latitude,
              hotel_longitude: longitude,
              hotel_image_url: hotel.Image || undefined,
              description: hotel.Description || undefined,
              facilities: hotel.Facilities ? JSON.stringify(hotel.Facilities) : undefined,
            },
          });
          upsertedCount++;
        } catch (upsertError) {
 this.logger.warn(
            `⚠️  Failed to upsert hotel ${hotel.HotelCode || hotel.hotelCode}: ${upsertError.message}`
          );
        }
      }

 this.logger.log(
        `✅ Successfully synced ${upsertedCount}/${hotels.length} hotels for city ${tboCityCode}`
      );
      return upsertedCount;
    } catch (error) {
 this.logger.error(` Hotel sync failed: ${error.message}`);
      throw error;
    }
  }

  private async fetchHotelsFromTboHotelCodeList(tboCityCode: string): Promise<any[]> {
    try {
      const basicAuth = Buffer.from(`${this.TBO_STATIC_USERNAME}:${this.TBO_STATIC_PASSWORD}`).toString('base64');
      const response = await this.http.post(
        `${this.TBO_MASTER_API_BASE}/TBOHotelCodeList`,
        {
          CityCode: tboCityCode,
          IsDetailedResponse: 'true',
        },
        {
          timeout: 45000,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${basicAuth}`,
          },
        },
      );

      const hotelList = response.data?.HotelCodeList;
      if (Array.isArray(hotelList)) {
        return hotelList;
      }

      const hotels = response.data?.Hotels;
      if (Array.isArray(hotels)) {
        return hotels;
      }

      return [];
    } catch (error: any) {
 this.logger.error(` TBOHotelCodeList failed for city ${tboCityCode}: ${error?.message || error}`);
      return [];
    }
  }

 /**
   * Sync all major cities
   * Call this periodically (e.g., daily) via a cron job
 */
  async syncAllCities(): Promise<Map<string, number>> {
    const allIndiaCities = await this.fetchIndiaCitiesFromCityListApi();
    if (allIndiaCities.length === 0) {
 this.logger.warn(' No cities returned from CityList API for country IN');
      return new Map<string, number>();
    }

 this.logger.log(` Starting full India hotel master sync for ${allIndiaCities.length} city codes`);

    const results = new Map<string, number>();
    const delayMs = Number(process.env.TBO_STATIC_SYNC_CITY_DELAY_MS || 400);

    for (const city of allIndiaCities) {
      try {
        const count = await this.syncHotelsForCity(city.code);
        results.set(`${city.code}|${city.name}`, count);
 // Add delay to avoid rate limiting
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      } catch (error) {
 this.logger.error(` Failed to sync ${city.name} (${city.code}): ${error.message}`);
        results.set(`${city.code}|${city.name}`, 0);
      }
    }

    return results;
  }

 /**
   * Fetch India city list from external TBO CityList API.
   * Endpoint provided by certification flow.
 */
  async fetchIndiaCitiesFromCityListApi(): Promise<Array<{ code: string; name: string }>> {
    try {
      const staticBasicAuth = Buffer.from(`${this.TBO_STATIC_USERNAME}:${this.TBO_STATIC_PASSWORD}`).toString('base64');
      const response = await this.http.post(
        this.CITY_LIST_API_URL,
        { CountryCode: 'IN' },
        {
          timeout: 60000,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${staticBasicAuth}`,
          },
        },
      );

      const statusCode = response.data?.Status?.Code;
      if (statusCode !== 200) {
 this.logger.warn(
          `⚠️ CityList API returned non-success status: ${statusCode} (${response.data?.Status?.Description || 'Unknown'})`,
        );
        return [];
      }

      const cityListRaw = response.data?.CityList;
      const cityList = Array.isArray(cityListRaw) ? cityListRaw : cityListRaw ? [cityListRaw] : [];

      const normalized = cityList
        .map((city: any) => ({
          code: String(city?.Code || city?.CityCode || '').trim(),
          name: String(city?.Name || city?.CityName || '').trim(),
        }))
        .filter((city) => !!city.code);

 this.logger.log(` CityList API returned ${normalized.length} India cities`);
      return normalized;
    } catch (error: any) {
 this.logger.error(` Failed to fetch India cities from CityList API: ${error?.message || error}`);
      return [];
    }
  }

 /**
   * Get hotel count in master database
 */
  async getHotelCount(): Promise<number> {
    return await this.prisma.tbo_hotel_master.count();
  }

  async getHotelCoordinateSampleByCity(
    tboCityCode: string,
    take = 5,
  ): Promise<Array<{ hotelCode: string; hotelName: string | null; latitude: string; longitude: string }>> {
    const rows = await this.prisma.tbo_hotel_master.findMany({
      where: { tbo_city_code: tboCityCode },
      select: {
        tbo_hotel_code: true,
        hotel_name: true,
        hotel_latitude: true,
        hotel_longitude: true,
      },
      orderBy: { updated_at: 'desc' },
      take,
    });

    return rows.map((row) => ({
      hotelCode: row.tbo_hotel_code,
      hotelName: row.hotel_name,
      latitude: row.hotel_latitude || '',
      longitude: row.hotel_longitude || '',
    }));
  }

 /**
   * Parse star rating from TBO's hotel category string
   * Examples: "FiveStar", "FourStar", "5-Star", "4", etc.
 */
  private parseStarRating(category: unknown): number {
    if (category === null || category === undefined) return 0;
    const categoryStr = String(category).toLowerCase().trim();
    if (!categoryStr || categoryStr === 'all') return 0;

    if (categoryStr.includes('five') || categoryStr.includes('5')) return 5;
    if (categoryStr.includes('four') || categoryStr.includes('4')) return 4;
    if (categoryStr.includes('three') || categoryStr.includes('3')) return 3;
    if (categoryStr.includes('two') || categoryStr.includes('2')) return 2;
    if (categoryStr.includes('one') || categoryStr.includes('1')) return 1;

    return 0;
  }

  private extractCoordinates(hotel: any): { latitude: string; longitude: string } {
    const directLatitude = String(hotel?.Latitude || hotel?.latitude || '').trim();
    const directLongitude = String(hotel?.Longitude || hotel?.longitude || '').trim();

    if (directLatitude || directLongitude) {
      return {
        latitude: directLatitude,
        longitude: directLongitude,
      };
    }

 // Static TBO payload often returns coordinates as "lat|lng" in Map.
    const mapValue = String(hotel?.Map || hotel?.map || '').trim();
    if (!mapValue) {
      return { latitude: '', longitude: '' };
    }

    const [latRaw, lngRaw] = mapValue.split('|');
    return {
      latitude: String(latRaw || '').trim(),
      longitude: String(lngRaw || '').trim(),
    };
  }
}
