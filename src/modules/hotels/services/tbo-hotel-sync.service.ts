import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { PrismaService } from '../../../prisma.service';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class TboHotelSyncService {
  private readonly logger = new Logger(TboHotelSyncService.name);
  private http: AxiosInstance = axios;
  private tokenId: string | null = null;
  private tokenExpiry: Date | null = null;

 // TBO API Endpoints
 private readonly SHARED_API_URL = process.env.TBO_SHARED_API_URL || 'https://api.travelboutiqueonline.com/SharedAPI';
  private readonly USERNAME = process.env.TBO_USERNAME || 'IXMD112';
  private readonly PASSWORD = process.env.TBO_PASSWORD || 'api-11#M$new';
  private readonly CLIENT_ID = process.env.TBO_CLIENT_ID || 'tboprod';

 // TBO Cities we want to sync
  private readonly TBO_CITIES = [
    { code: '8', name: 'Chennai' },
    { code: '9', name: 'Mahabalipuram' },
    { code: '10', name: 'Thanjavur' },
    { code: '11', name: 'Madurai' },
    { code: '12', name: 'Rameswaram' },
  ];

  constructor(private readonly prisma: PrismaService) {}

 /**
   * Main sync method - fetches hotel codes from TBO and populates database
   * Should be called by a cron job daily
 */
  async syncHotelsForAllCities(): Promise<{ city: string; hotelsAdded: number }[]> {
 this.logger.log(' Starting TBO Hotel Sync for all cities...');
    const results: { city: string; hotelsAdded: number }[] = [];

    for (const city of this.TBO_CITIES) {
      try {
 this.logger.log(`\n Syncing hotels for ${city.name} (Code: ${city.code})...`);
        const hotelsAdded = await this.syncHotelsForCity(city.code, city.name);
        results.push({ city: city.name, hotelsAdded });
 this.logger.log(` ${city.name}: ${hotelsAdded} hotels synced`);
      } catch (error) {
 this.logger.error(` Failed to sync ${city.name}: ${error.message}`);
      }
    }

 this.logger.log(`\n Sync Complete - Total results: ${JSON.stringify(results)}`);
    return results;
  }

 /**
   * Sync hotels for a specific city
 */
  private async syncHotelsForCity(tboCityCode: string, cityName: string): Promise<number> {
    try {
 // Step 1: Authenticate
      const tokenId = await this.authenticate();

 // Step 2: Call GetHotels API
      const hotels = await this.fetchHotelsFromTBOGetHotelsAPI(tboCityCode, tokenId);

      if (hotels.length === 0) {
 this.logger.warn(` No hotels returned from TBO GetHotels API for ${cityName}`);
        return 0;
      }

 this.logger.log(` TBO GetHotels returned ${hotels.length} hotels for ${cityName}`);

 // Step 3: Store in database
      let addedCount = 0;
      for (const hotel of hotels) {
        try {
 const hotelCode = `${tboCityCode}_${hotel.HotelCode}`; // Unique format: 8_1035259

 // Upsert hotel record
          await this.prisma.tbo_hotel_master.upsert({
            where: { tbo_hotel_code: hotelCode },
            create: {
              tbo_hotel_code: hotelCode,
              tbo_city_code: tboCityCode,
              hotel_name: hotel.HotelName || `Hotel ${hotel.HotelCode}`,
              hotel_address: hotel.Address || cityName,
              star_rating: this.parseStarRating(hotel.StarRating),
              status: 1,
              created_at: new Date(),
              updated_at: new Date(),
            },
            update: {
              hotel_name: hotel.HotelName || `Hotel ${hotel.HotelCode}`,
              hotel_address: hotel.Address || cityName,
              star_rating: this.parseStarRating(hotel.StarRating),
              updated_at: new Date(),
            },
          });
          addedCount++;
        } catch (error) {
 this.logger.warn(` Failed to save hotel ${hotel.HotelCode}: ${error.message}`);
        }
      }

      return addedCount;
    } catch (error) {
 this.logger.error(` Error syncing hotels for city ${tboCityCode}: ${error.message}`);
      throw error;
    }
  }

 /**
   * Authenticate with TBO API and get TokenId
 */
  private async authenticate(): Promise<string> {
    try {
 // Return cached token if still valid
      if (this.tokenId && this.tokenExpiry && new Date() < this.tokenExpiry) {
        return this.tokenId;
      }

 this.logger.debug(` Authenticating with TBO API...`);

      const authRequest = {
        ClientId: this.CLIENT_ID,
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

      const status = response.data?.Status;
      if (status !== 1) {
        throw new Error(`Authentication failed with status: ${status}`);
      }

      this.tokenId = response.data.TokenId;
 this.tokenExpiry = new Date(Date.now() + 12 * 60 * 60 * 1000); // 12 hours

 this.logger.log(` TBO Authentication successful`);
      return this.tokenId;
    } catch (error) {
 this.logger.error(` TBO Authentication failed: ${error.message}`);
      throw error;
    }
  }

 /**
   * Call TBO GetHotels API to fetch all hotels for a city
   * This returns hotel codes, names, addresses, ratings, etc.
 */
  private async fetchHotelsFromTBOGetHotelsAPI(
    tboCityCode: string,
    tokenId: string
  ): Promise<any[]> {
    try {
 this.logger.debug(` Calling TBO GetHotels API for city ${tboCityCode}...`);

      const request = {
        CityCode: tboCityCode,
        TokenId: tokenId,
 StarRating: 0, // 0 = all ratings
      };

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
 this.logger.warn(` GetHotels API returned status: ${status}`);
        return [];
      }

      const hotels = response.data?.Hotels || [];
 this.logger.log(` GetHotels returned ${hotels.length} hotels`);

 // Log first hotel as sample
      if (hotels.length > 0) {
        const sample = hotels[0];
 this.logger.debug(` Sample hotel: ${JSON.stringify(sample).substring(0, 200)}...`);
      }

      return hotels;
    } catch (error) {
 this.logger.error(` GetHotels API call failed: ${error.message}`);
      throw error;
    }
  }

 /**
   * Parse star rating from TBO's rating format
 */
  private parseStarRating(ratingStr: string): number {
    const ratingMap: Record<string, number> = {
      'OneStar': 1,
      'TwoStar': 2,
      'ThreeStar': 3,
      'FourStar': 4,
      'FiveStar': 5,
      '1': 1,
      '2': 2,
      '3': 3,
      '4': 4,
      '5': 5,
    };
    return ratingMap[ratingStr] || 0;
  }

 /**
   * Get current sync status - shows how many hotels per city
 */
  async getSyncStatus(): Promise<{ city: string; hotelCount: number }[]> {
    const results: { city: string; hotelCount: number }[] = [];

    for (const city of this.TBO_CITIES) {
      const count = await this.prisma.tbo_hotel_master.count({
        where: { tbo_city_code: city.code },
      });
      results.push({ city: city.name, hotelCount: count });
    }

    return results;
  }
}
