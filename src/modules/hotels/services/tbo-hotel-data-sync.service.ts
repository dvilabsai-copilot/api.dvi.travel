import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { PrismaService } from '../../../prisma.service';

/**
 * Sync TBO hotel data using the same endpoint and credentials as the PHP cron
 * TBO /TBOHotelCodeList endpoint returns complete hotel details:
 * - HotelCode
 * - HotelName
 * - Address
 * - HotelRating
 * - HotelFacilities
 * - Attractions
 * - Map (latitude|longitude)
 * - And more...
 */
@Injectable()
export class TboHotelDataSyncService {
  private readonly logger = new Logger(TboHotelDataSyncService.name);
  private http: AxiosInstance = axios;

 // From PHP config: dvi_project_api/config/config.php
 private readonly TBO_MASTER_API = process.env.TBO_SEARCH_API_URL || 'https://affiliate.travelboutiqueonline.com/HotelAPI';
  private readonly TBO_API_AUTH_UN = process.env.TBO_STATIC_USERNAME || 'IXMD112';
  private readonly TBO_API_AUTH_PWD = process.env.TBO_STATIC_PASSWORD || 'api-11#M$new';

  private readonly CITIES_TO_SYNC = [
    { code: '8', name: 'Chennai' },
    { code: '9', name: 'Mahabalipuram' },
    { code: '10', name: 'Thanjavur' },
    { code: '11', name: 'Madurai' },
    { code: '12', name: 'Rameswaram' },
  ];

  constructor(private readonly prisma: PrismaService) {}

 /**
   * Main sync method - calls TBO API and populates hotel database
 */
  async syncAllCities(): Promise<void> {
 this.logger.log(' Starting TBO Hotel Data Sync for all cities...\n');

    for (const city of this.CITIES_TO_SYNC) {
      try {
        await this.syncCityHotels(city.code, city.name);
      } catch (error) {
 this.logger.error(` Failed to sync ${city.name}: ${error.message}`);
      }
    }

 this.logger.log('\n Hotel sync complete!');
  }

 /**
   * Sync hotels for a specific city
 */
  private async syncCityHotels(cityCode: string, cityName: string): Promise<void> {
 this.logger.log(`\n Syncing ${cityName} (TBO Code: ${cityCode})...`);

    try {
 // Call TBO /TBOHotelCodeList endpoint
      const hotels = await this.fetchHotelsFromTBO(cityCode);

      if (!hotels || hotels.length === 0) {
 this.logger.warn(` No hotels returned for ${cityName}`);
        return;
      }

 this.logger.log(` TBO returned ${hotels.length} hotels for ${cityName}`);

 // Get city ID from database
      const city = await this.prisma.dvi_cities.findFirst({
        where: { tbo_city_code: cityCode, deleted: 0 },
      });

      if (!city) {
 this.logger.error(` City ${cityName} (${cityCode}) not found in database`);
        return;
      }

 // Insert/update hotels in database
      let inserted = 0;
      let merged = 0;

      for (const hotel of hotels) {
        try {
          const result = await this.upsertHotel(hotel, city);
          if (result === 'inserted') {
            inserted++;
          } else if (result === 'merged') {
            merged++;
          }
        } catch (error) {
 this.logger.warn(
            `⚠️  Failed to save hotel ${hotel.HotelCode}: ${error.message}`
          );
        }
      }

 this.logger.log(
        `✅ ${cityName}: ${inserted} inserted, ${merged} merged, Total: ${inserted + merged}`
      );
    } catch (error) {
 this.logger.error(` Error syncing ${cityName}: ${error.message}`);
      throw error;
    }
  }

 /**
   * Call TBO /TBOHotelCodeList endpoint to fetch hotel data
   * Same endpoint and credentials as PHP cron
 */
  private async fetchHotelsFromTBO(cityCode: string): Promise<any[]> {
    try {
      const postData = {
        CityCode: cityCode,
        IsDetailedResponse: 'true',
      };

 this.logger.debug(` Calling TBO /TBOHotelCodeList for city ${cityCode}`);

      const response = await this.http.post(
        `${this.TBO_MASTER_API}/TBOHotelCodeList`,
        postData,
        {
          auth: {
            username: this.TBO_API_AUTH_UN,
            password: this.TBO_API_AUTH_PWD,
          },
          timeout: 60000,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );

      const hotels = response.data?.Hotels || [];
 this.logger.log(` TBO /TBOHotelCodeList returned ${hotels.length} hotels`);

      if (hotels.length > 0) {
 this.logger.debug(` Sample hotel: ${JSON.stringify(hotels[0]).substring(0, 150)}...`);
      }

      return hotels;
    } catch (error) {
 this.logger.error(` TBO API call failed: ${error.message}`);
      throw error;
    }
  }

 /**
   * Insert or merge hotel into database
 */
  private async upsertHotel(
    hotelData: any,
    city: any
  ): Promise<'inserted' | 'merged' | 'skipped'> {
    const hotelCode = hotelData.HotelCode;
    const hotelName = hotelData.HotelName || `Hotel ${hotelCode}`;
    const address = hotelData.Address || city.name;

 // Parse star rating
    const ratingMap: Record<string, number> = {
      'OneStar': 1,
      'TwoStar': 2,
      'ThreeStar': 3,
      'FourStar': 4,
      'FiveStar': 5,
    };
    const starRating = ratingMap[hotelData.HotelRating] || 0;

 // Parse coordinates
    let latitude = 0;
    let longitude = 0;
    if (hotelData.Map) {
      const parts = hotelData.Map.split('|');
      latitude = parseFloat(parts[0]) || 0;
      longitude = parseFloat(parts[1]) || 0;
    }

 // Check if hotel exists by code + city
    const existing = await this.prisma.tbo_hotel_master.findFirst({
      where: {
        tbo_hotel_code: hotelCode,
        tbo_city_code: city.tbo_city_code,
      },
    });

    if (existing) {
 // Update existing record
      await this.prisma.tbo_hotel_master.update({
        where: { id: existing.id },
        data: {
          hotel_name: hotelName,
          hotel_address: address,
          star_rating: starRating,
          updated_at: new Date(),
        },
      });
      return 'skipped';
    }

 // Insert new record
    await this.prisma.tbo_hotel_master.create({
      data: {
        tbo_hotel_code: hotelCode,
        tbo_city_code: city.tbo_city_code,
        hotel_name: hotelName,
        hotel_address: address,
        star_rating: starRating,
        status: 1,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });

    return 'inserted';
  }
}
