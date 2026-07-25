import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { PrismaService } from '../../../prisma.service';

/**
 * TBO API Sync Service
 *
 * Syncs city and hotel master data directly from TBO APIs using BasicAuth.
 * Follows the pattern from PHP codebase (config/config.php)
 *
 * Authentication:
 * - Username: IXMD112
 * - Password: api-11#M$new
 *
 * Endpoints:
 * - TBOHotelCodeList: http://api.tbotechnology.in/TBOHolidays_HotelAPI/TBOHotelCodeList
 */
@Injectable()
export class TboApiSyncService {
  private logger = new Logger(TboApiSyncService.name);

 // TBO API credentials (from config/config.php)
  private readonly TBO_API_AUTH_USERNAME = process.env.TBO_STATIC_USERNAME || 'IXMD112';
  private readonly TBO_API_AUTH_PASSWORD = process.env.TBO_STATIC_PASSWORD || 'api-11#M$new';
 private readonly TBO_MASTER_API_BASE = process.env.TBO_STATIC_API_URL || 'http://affiliate.travelboutiqueonline.com/TBOHolidays_HotelAPI';

  private http: AxiosInstance;

  constructor(private readonly prisma: PrismaService) {
 // Create axios instance with BasicAuth configured
    this.http = axios.create({
      baseURL: this.TBO_MASTER_API_BASE,
      auth: {
        username: this.TBO_API_AUTH_USERNAME,
        password: this.TBO_API_AUTH_PASSWORD,
      },
      timeout: 8000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

 /**
   * Get TBO hotel codes for a specific city
   * Corresponds to PHP: callApi(TBO_MASTER_API . '/TBOHotelCodeList', 'POST', $postData, TBO_API_AUTH_UN, TBO_API_AUTH_PWD)
   *
   * @param cityCode TBO city code (e.g., '418069' for Delhi, '127343' for Chennai)
   * @returns List of hotels for the city
 */
  async getTboHotelCodeList(cityCode: string): Promise<any[]> {
    try {
 this.logger.debug(` Fetching TBO hotel codes for city code: ${cityCode}`);

      const response = await this.http.post('/TBOHotelCodeList', {
        CityCode: cityCode,
        IsDetailedResponse: 'true',
      });

      if (!response.data?.HotelCodeList) {
 this.logger.warn(` No hotels found for city code ${cityCode}`);
        return [];
      }

      const hotels = Array.isArray(response.data.HotelCodeList)
        ? response.data.HotelCodeList
        : [response.data.HotelCodeList];

 this.logger.log(` Found ${hotels.length} hotels for city code ${cityCode}`);
      return hotels;
    } catch (error) {
 this.logger.error(` Failed to fetch TBO hotel codes for city ${cityCode}: ${error.message}`);
      return [];
    }
  }

 /**
   * Sync hotels for a specific TBO city code to database
 */
  async syncHotelsForCity(tboCity: {code: string, name: string}): Promise<number> {
    try {
 this.logger.log(` Syncing hotels for TBO city: ${tboCity.name} (code: ${tboCity.code})`);

 // Fetch hotels from TBO API
      const hotels = await this.getTboHotelCodeList(tboCity.code);

      if (hotels.length === 0) {
 this.logger.warn(` No hotels to sync for city ${tboCity.name}`);
        return 0;
      }

      let upsertedCount = 0;

      for (const hotel of hotels) {
        try {
 // Extract hotel details from TBO response
          const hotelCode = hotel.HotelCode || hotel.hotelCode;
          const hotelName = hotel.HotelName || hotel.hotelName || `Hotel ${hotelCode}`;
          const starRating = this.parseStarRating(hotel.StarRating || hotel.starRating);
          const cityCode = tboCity.code;

          if (!hotelCode) {
 this.logger.warn(` Hotel missing code, skipping`);
            continue;
          }

 // Upsert to database
          await this.prisma.tbo_hotel_master.upsert({
            where: { tbo_hotel_code: String(hotelCode) },
            create: {
              tbo_hotel_code: String(hotelCode),
              tbo_city_code: String(cityCode),
              hotel_name: hotelName,
              hotel_address: tboCity.name,
              city_name: tboCity.name,
              star_rating: starRating,
              hotel_image_url: hotel.Image || hotel.image || '',
              description: hotel.Description || hotel.description || `Hotel in ${tboCity.name}`,
              check_in_time: '14:00',
              check_out_time: '11:00',
              facilities: JSON.stringify(this.extractFacilities(hotel)),
              status: 1,
              created_at: new Date(),
              updated_at: new Date(),
            },
            update: {
              hotel_name: hotelName,
              city_name: tboCity.name,
              star_rating: starRating,
              hotel_image_url: hotel.Image || hotel.image || '',
              description: hotel.Description || hotel.description || `Hotel in ${tboCity.name}`,
              updated_at: new Date(),
            },
          });

          upsertedCount++;
        } catch (upsertError) {
 this.logger.warn(` Failed to upsert hotel ${hotel.HotelCode || hotel.hotelCode}: ${upsertError.message}`);
        }
      }

 this.logger.log(` Synced ${upsertedCount}/${hotels.length} hotels for city ${tboCity.name}`);
      return upsertedCount;
    } catch (error) {
 this.logger.error(` Failed to sync hotels for city ${tboCity.name}: ${error.message}`);
      return 0;
    }
  }

 /**
   * Parse star rating from various TBO formats
 */
  private parseStarRating(rating: any): number {
    if (!rating) return 4;

    const ratingStr = String(rating).toLowerCase().trim();

    const ratingMap: {[key: string]: number} = {
      'onestar': 1,
      'twostar': 2,
      'threestar': 3,
      'fourstar': 4,
      'fivestar': 5,
      '1': 1,
      '2': 2,
      '3': 3,
      '4': 4,
      '5': 5,
    };

    return ratingMap[ratingStr] || 4;
  }

 /**
   * Extract facilities from TBO hotel response
 */
  private extractFacilities(hotel: any): string[] {
    const facilities: string[] = [];

 // Common facility fields in TBO response
    const facilityFields = [
      'facilities',
      'facility',
      'amenities',
      'amenity',
      'features',
      'feature',
    ];

    for (const field of facilityFields) {
      const value = hotel[field];
      if (value) {
        if (Array.isArray(value)) {
          facilities.push(...value.map(f => String(f)));
        } else if (typeof value === 'string') {
          if (value.includes(',')) {
            facilities.push(...value.split(',').map(f => f.trim()));
          } else {
            facilities.push(value);
          }
        }
      }
    }

 // Default facilities if none found
    if (facilities.length === 0) {
      facilities.push('WiFi', 'Restaurant', 'Room Service');
    }

 // Remove duplicates
    return Array.from(new Set(facilities));
  }

 /**
   * Sync all cities and their hotels
   * Uses predefined list of Indian cities with known TBO codes
 */
  async syncAllCities(): Promise<{cities: number, hotels: number}> {
    const tboCities = [
      { code: '1', name: 'Delhi' },
      { code: '2', name: 'Mumbai' },
      { code: '3', name: 'Bangalore' },
      { code: '4', name: 'Agra' },
      { code: '5', name: 'Hyderabad' },
      { code: '6', name: 'Jaipur' },
      { code: '7', name: 'Kolkata' },
      { code: '8', name: 'Chennai' },
    ];

    let totalCitiesUpdated = 0;
    let totalHotelsSynced = 0;

 this.logger.log(` Starting TBO sync for ${tboCities.length} cities...`);

 // First update city codes in database
    for (const city of tboCities) {
      try {
        const result = await this.prisma.dvi_cities.updateMany({
          where: {
            name: city.name,
            deleted: 0,
          },
          data: {
            tbo_city_code: city.code,
            updatedon: new Date(),
          },
        });

        if (result.count > 0) {
 this.logger.log(` Updated ${city.name} with TBO code ${city.code}`);
          totalCitiesUpdated += result.count;
        }
      } catch (error) {
 this.logger.warn(` Failed to update city ${city.name}: ${error.message}`);
      }
    }

 // Then sync hotels for each city
    for (const city of tboCities) {
      const hotelCount = await this.syncHotelsForCity(city);
      totalHotelsSynced += hotelCount;
    }

 this.logger.log(` TBO Sync Complete: ${totalCitiesUpdated} cities, ${totalHotelsSynced} hotels`);
    return {
      cities: totalCitiesUpdated,
      hotels: totalHotelsSynced,
    };
  }
}
