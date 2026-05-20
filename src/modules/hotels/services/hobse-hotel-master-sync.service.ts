import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import FormData from 'form-data';
import { PrismaService } from '../../../prisma.service';

type HobseHotelRow = {
  hotelId: string;
  hotelName: string;
  address?: string;
  starCategory?: string | number;
  cityName?: string;
  stateName?: string;
  countryName?: string;
};

@Injectable()
export class HobseHotelMasterSyncService {
  private logger = new Logger(HobseHotelMasterSyncService.name);
  private http: AxiosInstance;

  private readonly HOBSE_BASE_URL =
    (process.env.HOBSE_BASE_URL || 'https://api.hobse.com/v1')
      .replace(/\/htl\/?$/, '')
      .replace(/\/+$/, '');

  private readonly HOBSE_CLIENT_TOKEN = process.env.HOBSE_CLIENT_TOKEN || '';
  private readonly HOBSE_ACCESS_TOKEN = process.env.HOBSE_ACCESS_TOKEN || '';
  private readonly HOBSE_PRODUCT_TOKEN = process.env.HOBSE_PRODUCT_TOKEN || '';

  constructor(private readonly prisma: PrismaService) {
    this.http = axios.create({
      baseURL: this.HOBSE_BASE_URL,
      timeout: 60000,
    });
  }

  private buildParams(method: string, data: Record<string, any>) {
    // Matches Postman wrapper pattern: form-data key "params" with JSON string
    return {
      hobse: {
        version: '1.0',
        datetime: new Date().toISOString(),
        clientToken: this.HOBSE_CLIENT_TOKEN,
        accessToken: this.HOBSE_ACCESS_TOKEN,
        productToken: this.HOBSE_PRODUCT_TOKEN,
        request: {
          method,
          data: {
            ...data,
            resultType: 'json',
          },
        },
      },
    };
  }

  private parseStarCategory(starCategory: any): number {
    const n = Number(String(starCategory ?? '').trim());
    return Number.isFinite(n) ? n : 0;
  }

  private async fetchHotelList(): Promise<HobseHotelRow[]> {
    const payload = this.buildParams('htl/GetHotelList', {});

    const form = new FormData();
    form.append('params', JSON.stringify(payload));

    this.logger.log(`📡 HOBSE: POST ${this.HOBSE_BASE_URL}/htl/GetHotelList`);

    const res = await this.http.post('/htl/GetHotelList', form, {
      headers: {
        ...form.getHeaders(),
      },
      maxBodyLength: Infinity,
    });

    const success = res?.data?.hobse?.response?.status?.success;
    if (success !== 'true') {
      const message = res?.data?.hobse?.response?.status?.message || 'Unknown error';
      throw new Error(`HOBSE GetHotelList failed: ${message}`);
    }

    const data = (res?.data?.hobse?.response?.data ?? []) as HobseHotelRow[];
    this.logger.log(`✅ HOBSE: received ${data.length} hotels`);
    return data;
  }

  /**
   * Sync Hobse hotel master list into dvi_hotel
   * Rule:
   * - Find existing by hotel_name + hotel_city AND (deleted=false OR deleted is null)
   * - Update: hotel_code = hobse.hotelId (also update address/state/country/category if present)
   * - Insert if not found
   */
  async syncAllHotelsToDviHotel(): Promise<{
    totalFromHobse: number;
    inserted: number;
    updated: number;
    skipped: number;
  }> {
    const hotels = await this.fetchHotelList();

    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (const h of hotels) {
      const hotelId = (h.hotelId || '').trim();
      const hotelName = (h.hotelName || '').trim();
      const cityName = (h.cityName || '').trim();

      if (!hotelId || !hotelName || !cityName) {
        skipped++;
        continue;
      }

      const existing = await this.prisma.dvi_hotel.findFirst({
        where: {
          hotel_name: hotelName,
          hotel_city: cityName,
          OR: [{ deleted: false }, { deleted: null }],
        },
        select: {
          hotel_id: true,
        },
      });

      const category = this.parseStarCategory(h.starCategory);

      if (existing?.hotel_id) {
        await this.prisma.dvi_hotel.update({
          where: { hotel_id: existing.hotel_id },
          data: {
            hotel_code: hotelId, // ✅ store Hobse code here
            hotel_address: h.address?.trim() || null,
            hotel_state: h.stateName?.trim() || null,
            hotel_country: h.countryName?.trim() || null,
            hotel_category: category,
            status: 1,
          },
        });
        updated++;
      } else {
        await this.prisma.dvi_hotel.create({
          data: {
            hotel_name: hotelName,
            hotel_city: cityName,
            hotel_state: h.stateName?.trim() || null,
            hotel_country: h.countryName?.trim() || null,
            hotel_address: h.address?.trim() || null,
            hotel_category: category,

            // ✅ Hobse code stored here
            hotel_code: hotelId,

            status: 1,
            deleted: false,
            createdon: new Date(),
            createdby: 0,
          },
        });
        inserted++;
      }
    }

    this.logger.log(
      `✅ HOBSE Sync done. total=${hotels.length}, inserted=${inserted}, updated=${updated}, skipped=${skipped}`,
    );

    return {
      totalFromHobse: hotels.length,
      inserted,
      updated,
      skipped,
    };
  }
}
