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
  private readonly SHARED_API_URL = 'https://sharedapi.tektravels.com';
  private readonly USERNAME = process.env.TBO_USERNAME || 'Doview';
  private readonly PASSWORD = process.env.TBO_PASSWORD || 'Doview@12345';
  private http: AxiosInstance = axios;
  private tokenId: string | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private isSyncRunning = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    const enabled = String(process.env.TBO_STATIC_SYNC_ENABLED || 'true').toLowerCase() === 'true';
    if (!enabled) {
      this.logger.log('ℹ️ TBO static sync scheduler is disabled by TBO_STATIC_SYNC_ENABLED=false');
      return;
    }

    const intervalDays = Number(process.env.TBO_STATIC_SYNC_INTERVAL_DAYS || 15);
    const intervalMs = Math.max(intervalDays, 1) * 24 * 60 * 60 * 1000;

    this.syncTimer = setInterval(() => {
      this.runScheduledSync().catch((error) => {
        this.logger.error(`❌ Scheduled TBO static sync failed: ${error.message}`);
      });
    }, intervalMs);

    this.logger.log(`🕒 TBO static sync scheduler started (every ${Math.max(intervalDays, 1)} day(s))`);

    if (this.syncTimer.unref) {
      this.syncTimer.unref();
    }

    const runOnStart = String(process.env.TBO_STATIC_SYNC_RUN_ON_START || 'false').toLowerCase() === 'true';
    if (runOnStart) {
      this.runScheduledSync().catch((error) => {
        this.logger.error(`❌ Startup TBO static sync failed: ${error.message}`);
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
      this.logger.warn('⚠️ Skipping scheduled TBO static sync because previous run is still in progress');
      return;
    }

    this.isSyncRunning = true;
    const startedAt = Date.now();

    try {
      this.logger.log('🔄 Starting scheduled TBO static sync');
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
        ClientId: process.env.TBO_CLIENT_ID || 'ApiIntegrationNew',
        UserName: this.USERNAME,
        Password: this.PASSWORD,
        EndUserIp: process.env.TBO_END_USER_IP || '192.168.1.1',
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
      this.logger.log('✅ TBO Authentication successful for hotel sync');
      return this.tokenId;
    } catch (error) {
      this.logger.error(`❌ TBO Auth failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Fetch hotel master data from TBO GetHotels API
   * @param tboCityCode - TBO city code (e.g., "127343" for Chennai)
   */
  async syncHotelsForCity(tboCityCode: string): Promise<number> {
    try {
      this.logger.log(`📋 Starting hotel master sync for TBO city code: ${tboCityCode}`);

      const tokenId = await this.authenticate();

      // Step 1: Call GetHotels API
      const request = {
        CityCode: tboCityCode,
        TokenId: tokenId,
        StarRating: 0, // 0 = All ratings
      };

      this.logger.debug(`📤 GetHotels request: ${JSON.stringify(request)}`);

      const response = await this.http.post(
        `${this.SHARED_API_URL}/SharedData.svc/rest/GetHotels`,
        request,
        {
          timeout: 30000,
          headers: { 'Content-Type': 'application/json' },
        }
      );

      const status = response.data?.Status;
      if (status !== 1) {
        this.logger.warn(`⚠️  GetHotels returned status: ${status}`);
        return 0;
      }

      const hotels = response.data?.Hotels || [];
      this.logger.log(`📦 Fetched ${hotels.length} hotels from TBO for city ${tboCityCode}`);

      if (hotels.length === 0) {
        this.logger.warn(`⚠️  No hotels returned for city ${tboCityCode}`);
        return 0;
      }

      // Step 2: Upsert hotels into database
      let upsertedCount = 0;
      for (const hotel of hotels) {
        try {
          await this.prisma.tbo_hotel_master.upsert({
            where: { tbo_hotel_code: hotel.HotelCode },
            create: {
              tbo_hotel_code: hotel.HotelCode,
              tbo_city_code: tboCityCode,
              hotel_name: hotel.HotelName || `Hotel ${hotel.HotelCode}`,
              hotel_address: hotel.Address || '',
              city_name: hotel.CityName || '',
              star_rating: this.parseStarRating(hotel.HotelCategory),
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
              star_rating: this.parseStarRating(hotel.HotelCategory),
              hotel_image_url: hotel.Image || undefined,
              description: hotel.Description || undefined,
              facilities: hotel.Facilities ? JSON.stringify(hotel.Facilities) : undefined,
            },
          });
          upsertedCount++;
        } catch (upsertError) {
          this.logger.warn(
            `⚠️  Failed to upsert hotel ${hotel.HotelCode}: ${upsertError.message}`
          );
        }
      }

      this.logger.log(
        `✅ Successfully synced ${upsertedCount}/${hotels.length} hotels for city ${tboCityCode}`
      );
      return upsertedCount;
    } catch (error) {
      this.logger.error(`❌ Hotel sync failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Sync all major cities
   * Call this periodically (e.g., daily) via a cron job
   */
  async syncAllCities(): Promise<Map<string, number>> {
    const majorCities = [
      { code: '1', name: 'Delhi' },
      { code: '2', name: 'Mumbai' },
      { code: '3', name: 'Bangalore' },
      { code: '4', name: 'Agra' },
      { code: '5', name: 'Hyderabad' },
      { code: '6', name: 'Jaipur' },
      { code: '7', name: 'Kolkata' },
      { code: '8', name: 'Chennai' },
    ];

    const results = new Map<string, number>();

    for (const city of majorCities) {
      try {
        const count = await this.syncHotelsForCity(city.code);
        results.set(city.name, count);
        // Add delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        this.logger.error(`❌ Failed to sync ${city.name}: ${error.message}`);
        results.set(city.name, 0);
      }
    }

    return results;
  }

  /**
   * Get hotel count in master database
   */
  async getHotelCount(): Promise<number> {
    return await this.prisma.tbo_hotel_master.count();
  }

  /**
   * Parse star rating from TBO's hotel category string
   * Examples: "FiveStar", "FourStar", "5-Star", "4", etc.
   */
  private parseStarRating(category: string): number {
    if (!category) return 0;
    const categoryStr = category.toString().toLowerCase();

    if (categoryStr.includes('five') || categoryStr.includes('5')) return 5;
    if (categoryStr.includes('four') || categoryStr.includes('4')) return 4;
    if (categoryStr.includes('three') || categoryStr.includes('3')) return 3;
    if (categoryStr.includes('two') || categoryStr.includes('2')) return 2;
    if (categoryStr.includes('one') || categoryStr.includes('1')) return 1;

    return 0;
  }
}
