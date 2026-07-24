// FILE: src/modules/export-pricebook/export-pricebook.service.ts

import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { Response } from 'express';
import ExcelJS from 'exceljs';
import {
  VehiclePricebookQueryDto,
  HotelRoomExportQueryDto,
  HotelAmenityExportQueryDto,
  GuideExportQueryDto,
  HotspotExportQueryDto,
  ActivityQueryDto,
  TollQueryDto,
  ParkingQueryDto,
} from './dto/export-pricebook.dto';

type AnyRow = Record<string, any>;

@Injectable()
export class ExportPricebookService {
  constructor(private readonly prisma: PrismaService) {}

 // --------------------- shared helpers ---------------------

  private nowStamp() {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}_${pad(d.getMonth() + 1)}_${pad(d.getDate())}_${pad(
      d.getHours(),
    )}_${pad(d.getMinutes())}_${pad(d.getSeconds())}`;
  }

  private async writeExcel(res: Response, workbook: ExcelJS.Workbook, filename: string) {
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  }

  private dayKeys31() {
    return Array.from({ length: 31 }, (_, i) => `day_${i + 1}`);
  }

  private async getActiveTimeLimitIds(timeLimitIds: number[]): Promise<Set<number>> {
    if (!timeLimitIds.length) return new Set<number>();

    const rows = await this.prisma.dvi_time_limit.findMany({
      where: {
        time_limit_id: { in: timeLimitIds },
        deleted: 0,
        status: 1,
      },
      select: { time_limit_id: true },
    });

    return new Set(rows.map((row) => row.time_limit_id));
  }

  private async getActiveKmsLimitIds(kmsLimitIds: number[]): Promise<Set<number>> {
    if (!kmsLimitIds.length) return new Set<number>();

    const rows = await this.prisma.dvi_kms_limit.findMany({
      where: {
        kms_limit_id: { in: kmsLimitIds },
        deleted: 0,
        status: 1,
      },
      select: { kms_limit_id: true },
    });

    return new Set(rows.map((row) => row.kms_limit_id));
  }

  private monthLong(date: Date) {
 return date.toLocaleString('en-US', { month: 'long' }); // must match legacy DB month strings
  }

  private dateHeaderLabel(date: Date) {
 const weekday = date.toLocaleString('en-US', { weekday: 'short' }); // Mon
 const month = date.toLocaleString('en-US', { month: 'short' }); // Dec
    const day = String(date.getDate()).padStart(2, '0');
    const year = date.getFullYear();
    return `${weekday} - ${day} ${month}, ${year}`;
  }

  private listDatesInclusive(start: Date, end: Date): Date[] {
    const s = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const e = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    if (s.getTime() > e.getTime()) return [];
    const out: Date[] = [];
    for (let d = new Date(s); d.getTime() <= e.getTime(); d.setDate(d.getDate() + 1)) {
      out.push(new Date(d));
    }
    return out;
  }

 // NOTE:
 // legacy helpers like getNATIONALITY / getSLOTTYPE / getPAXCOUNTDETAILS were in jackus.php.
 // We do safe fallbacks here (you can adjust mapping later).
  private nationalityLabel(n: number) {
 // [Unverified] common mapping
    if (n === 1) return 'Indian';
    if (n === 2) return 'Foreign';
    return String(n ?? '');
  }

  private mealPlanTypeLabel(mealType: number) {
 // matches your PHP: getMealPlanTypeLabel()
    if (mealType === 1) return 'Breakfast';
    if (mealType === 2) return 'Lunch';
    if (mealType === 3) return 'Dinner';
    return '';
  }

  private hotelRoomPriceTypeLabel(priceType: number) {
 // matches your PHP: getPriceTypeLabel()
    switch (priceType) {
      case 0:
        return 'Room Rate';
      case 1:
        return 'Extra Bed Rate';
      case 2:
        return 'Child with Bed Rate';
      case 3:
        return 'Child without Bed Rate';
      default:
        return 'Room Rate';
    }
  }

  private toBigIntSafe(v: number | string | bigint | null | undefined): bigint {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number') return BigInt(v);
    if (typeof v === 'string' && v.trim() !== '') return BigInt(v);
    return BigInt(0);
  }

 /** BigInt -> number (safe) */
  private toNumberSafeBigInt(v: bigint, fieldName: string): number {
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new BadRequestException(`${fieldName} ${v.toString()} exceeds JS safe integer range`);
    }
    return Number(v);
  }

 // --------------------- VEHICLE (Local + Outstation) ---------------------

  async getVehiclePricebook(q: VehiclePricebookQueryDto) {
    const whereLocal: AnyRow = {};
    const whereOut: AnyRow = {};

    if (q.vendorId) {
      whereLocal.vendor_id = q.vendorId;
      whereOut.vendor_id = q.vendorId;
    }
    if (q.vendorBranchId) {
      whereLocal.vendor_branch_id = q.vendorBranchId;
      whereOut.vendor_branch_id = q.vendorBranchId;
    }
    if (q.month) {
      whereLocal.month = q.month;
      whereOut.month = q.month;
    }
    if (q.year) {
      whereLocal.year = q.year;
      whereOut.year = q.year;
    }

 // Legacy PHP export does NOT filter by status/deleted for vehicle
    const [local, outstation] = await Promise.all([
      this.prisma.dvi_vehicle_local_pricebook.findMany({
        where: { ...whereLocal },
        orderBy: [{ vehicle_price_book_id: 'desc' }],
      }),
      this.prisma.dvi_vehicle_outstation_price_book.findMany({
        where: { ...whereOut },
        orderBy: [{ vehicle_outstation_price_book_id: 'desc' }],
      }),
    ]);

    const activeLocalTimeLimitIds = await this.getActiveTimeLimitIds([...new Set(local.map((row) => row.time_limit_id))]);
    const activeOutstationKmsLimitIds = await this.getActiveKmsLimitIds([...new Set(outstation.map((row) => row.kms_limit_id))]);

    const filteredLocal = local.filter((row) => activeLocalTimeLimitIds.has(row.time_limit_id));
    const filteredOutstation = outstation.filter((row) => activeOutstationKmsLimitIds.has(row.kms_limit_id));

 // Lookup maps
    const vendorIds = new Set<number>();
    const branchIds = new Set<number>();
    const vendorVehicleTypeIds = new Set<number>();
    const timeLimitIds = new Set<number>();
    const kmsLimitIds = new Set<number>();

    for (const r of filteredLocal) {
      vendorIds.add(r.vendor_id);
      branchIds.add(r.vendor_branch_id);
      vendorVehicleTypeIds.add(r.vehicle_type_id);
      timeLimitIds.add(r.time_limit_id);
    }
    for (const r of filteredOutstation) {
      vendorIds.add(r.vendor_id);
      branchIds.add(r.vendor_branch_id);
      vendorVehicleTypeIds.add(r.vehicle_type_id);
      kmsLimitIds.add(r.kms_limit_id);
    }

    const [vendors, branches, vendorVehicleTypes, vehicleTypes, timeLimits, kmsLimits] =
      await Promise.all([
        this.prisma.dvi_vendor_details.findMany({
          where: { vendor_id: { in: [...vendorIds] } },
          select: { vendor_id: true, vendor_name: true },
        }),
        this.prisma.dvi_vendor_branches.findMany({
          where: { vendor_branch_id: { in: [...branchIds] } },
          select: { vendor_branch_id: true, vendor_branch_name: true },
        }),
        this.prisma.dvi_vendor_vehicle_types.findMany({
          where: { vendor_vehicle_type_ID: { in: [...vendorVehicleTypeIds] } },
          select: { vendor_vehicle_type_ID: true, vehicle_type_id: true },
        }),
        this.prisma.dvi_vehicle_type.findMany({
          select: { vehicle_type_id: true, vehicle_type_title: true },
        }),
        this.prisma.dvi_time_limit.findMany({
          where: { time_limit_id: { in: [...timeLimitIds] }, deleted: 0, status: 1 },
          select: { time_limit_id: true, time_limit_title: true },
        }),
        this.prisma.dvi_kms_limit.findMany({
          where: { kms_limit_id: { in: [...kmsLimitIds] }, deleted: 0, status: 1 },
          select: { kms_limit_id: true, kms_limit_title: true },
        }),
      ]);

    const vendorMap = new Map(vendors.map((v) => [v.vendor_id, v.vendor_name ?? '']));
    const branchMap = new Map(
      branches.map((b) => [b.vendor_branch_id, b.vendor_branch_name ?? '']),
    );
    const vvtToVehicleTypeId = new Map(
      vendorVehicleTypes.map((v) => [v.vendor_vehicle_type_ID, v.vehicle_type_id]),
    );
    const vehicleTypeMap = new Map(
      vehicleTypes.map((v) => [v.vehicle_type_id, v.vehicle_type_title ?? '']),
    );
    const timeLimitMap = new Map(
      timeLimits.map((t) => [t.time_limit_id, t.time_limit_title ?? '']),
    );
    const kmsLimitMap = new Map(
      kmsLimits.map((k) => [k.kms_limit_id, k.kms_limit_title ?? '']),
    );

    const dayKeys = this.dayKeys31();

    const rows = [
      ...filteredLocal.map((r) => {
        const vehicleTypeId = vvtToVehicleTypeId.get(r.vehicle_type_id) ?? 0;
        return {
          vendorName: vendorMap.get(r.vendor_id) ?? '',
          vendorBranch: branchMap.get(r.vendor_branch_id) ?? '',
          vehicleType: vehicleTypeMap.get(vehicleTypeId) ?? '',
          month: r.month ?? '',
          year: r.year ?? '',
          costType: 'Local',
          localTimeLimit: timeLimitMap.get(r.time_limit_id) ?? '',
          outstationKmLimit: '',
          days: dayKeys.map((k) => (r as AnyRow)[k] ?? 0),
        };
      }),
      ...filteredOutstation.map((r) => {
        const vehicleTypeId = vvtToVehicleTypeId.get(r.vehicle_type_id) ?? 0;
        return {
          vendorName: vendorMap.get(r.vendor_id) ?? '',
          vendorBranch: branchMap.get(r.vendor_branch_id) ?? '',
          vehicleType: vehicleTypeMap.get(vehicleTypeId) ?? '',
          month: r.month ?? '',
          year: r.year ?? '',
          costType: 'Outstation',
          localTimeLimit: '',
          outstationKmLimit: kmsLimitMap.get(r.kms_limit_id) ?? '',
          days: dayKeys.map((k) => (r as AnyRow)[k] ?? 0),
        };
      }),
    ];

    return { count: rows.length, rows };
  }

  async exportVehiclePricebookExcel(q: VehiclePricebookQueryDto, res: Response) {
    const data = await this.getVehiclePricebook(q);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Vehicle Pricebook');

    const headers = [
      'Vendor Name',
      'Vendor Branch',
      'Vehicle Type',
      'Month',
      'Year',
      'Cost Type',
      'Local Time limit',
      'Outsation KM limit',
      ...Array.from({ length: 31 }, (_, i) => `Day ${i + 1}`),
    ];

    ws.addRow(headers);
    ws.getRow(1).font = { bold: true };

    for (const r of data.rows) {
      ws.addRow([
        r.vendorName,
        r.vendorBranch,
        r.vehicleType,
        r.month,
        r.year,
        r.costType,
        r.localTimeLimit,
        r.outstationKmLimit,
        ...r.days,
      ]);
    }

    const filename = `vehicle_price_book_${this.nowStamp()}.xlsx`;
    return this.writeExcel(res, wb, filename);
  }

 // --------------------- HOTEL ROOM (DATE RANGE, with MEAL rows appended) ---------------------

  async exportHotelRoomPricebookExcel(q: HotelRoomExportQueryDto, res: Response) {
    const start = new Date(q.startDate);
    const end = new Date(q.endDate);
    const dates = this.listDatesInclusive(start, end);
    if (!dates.length) {
      throw new BadRequestException('Invalid date range. startDate must be <= endDate.');
    }

 // Hotels in state/city
    const hotels = await this.prisma.dvi_hotel.findMany({
      where: {
 // hotel_state/hotel_city in your schema are STRING (VarChar) in many legacy tables.
 // If yours are numeric, keep as-is. Otherwise, cast q.stateId/q.cityId to string before calling this API.
        hotel_state: (q as any).stateId,
        hotel_city: (q as any).cityId,
 // legacy PHP didnt filter status/deleted here; keeping minimal constraints:
      },
      select: { hotel_id: true, hotel_name: true, hotel_city: true },
    });

    const hotelIds = hotels.map((h) => h.hotel_id);
    if (!hotelIds.length) {
 // still generate an empty sheet (like legacy exports)
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Hotel Room Pricebook');
      ws.addRow([
        'S.No',
        'Hotel Name',
        'City Name',
        'Room Title',
        'Room Type Title',
        'Price Type',
        ...dates.map((d) => this.dateHeaderLabel(d)),
      ]);
      ws.getRow(1).font = { bold: true };
      return this.writeExcel(res, wb, `hotel_room_price_book_${this.nowStamp()}.xlsx`);
    }

 // City name (single city)
    const city = await this.prisma.dvi_cities.findFirst({
      where: { id: (q as any).cityId },
      select: { name: true },
    });
    const cityName = city?.name ?? '';

 // Distinct room combos from room pricebook (state/city is via hotel filter above)
    const roomCombos = await this.prisma.dvi_hotel_room_price_book.groupBy({
      by: ['hotel_id', 'room_id', 'room_type_id', 'price_type'],
      where: { hotel_id: { in: hotelIds } },
      orderBy: [
        { hotel_id: 'asc' },
        { room_id: 'asc' },
        { room_type_id: 'asc' },
        { price_type: 'asc' },
      ],
    });

    const roomIdsInt = [...new Set(roomCombos.map((r) => r.room_id))];
    const roomIdsBig = roomIdsInt.map((v) => this.toBigIntSafe(v));
    const roomTypeIds = [...new Set(roomCombos.map((r) => r.room_type_id))];

    const [rooms, roomTypes] = await Promise.all([
      this.prisma.dvi_hotel_rooms.findMany({
        where: { room_ID: { in: roomIdsBig } as any },
        select: { room_ID: true, room_title: true },
      }),
      this.prisma.dvi_hotel_roomtype.findMany({
        where: { room_type_id: { in: roomTypeIds } },
        select: { room_type_id: true, room_type_title: true },
      }),
    ]);

    const roomTitleMap = new Map<string, string>();
    for (const r of rooms) roomTitleMap.set(String(r.room_ID), r.room_title ?? '');

    const roomTypeMap = new Map(roomTypes.map((rt) => [rt.room_type_id, rt.room_type_title ?? '']));

 // Preload all pricebook rows for months involved in date range (OPTIMIZED vs legacy per-cell queries)
    const monthYearPairs = new Map<string, { month: string; year: string }>();
    for (const d of dates) {
      const month = this.monthLong(d);
      const year = String(d.getFullYear());
      monthYearPairs.set(`${year}::${month}`, { year, month });
    }
    const pairs = [...monthYearPairs.values()];

    const roomPriceRows = await this.prisma.dvi_hotel_room_price_book.findMany({
      where: {
        hotel_id: { in: hotelIds },
        OR: pairs.map((p) => ({ year: p.year, month: p.month })),
      },
    });

    const roomPriceMap = new Map<string, AnyRow>();
    for (const r of roomPriceRows) {
      roomPriceMap.set(
        `${r.hotel_id}::${r.room_id}::${r.room_type_id}::${r.price_type}::${r.year ?? ''}::${r.month ?? ''}`,
        r as AnyRow,
      );
    }

 // Meal combos (distinct hotel_id + meal_type)
    const mealCombos = await this.prisma.dvi_hotel_meal_price_book.groupBy({
      by: ['hotel_id', 'meal_type'],
      where: { hotel_id: { in: hotelIds } },
      orderBy: [{ hotel_id: 'asc' }, { meal_type: 'asc' }],
    });

    const mealPriceRows = await this.prisma.dvi_hotel_meal_price_book.findMany({
      where: {
        hotel_id: { in: hotelIds },
        OR: pairs.map((p) => ({ year: p.year, month: p.month })),
      },
    });

    const mealPriceMap = new Map<string, AnyRow>();
    for (const r of mealPriceRows) {
      mealPriceMap.set(`${r.hotel_id}::${r.meal_type}::${r.year ?? ''}::${r.month ?? ''}`, r as AnyRow);
    }

 // Excel build
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Hotel Room Pricebook');

    const header = [
      'S.No',
      'Hotel Name',
      'City Name',
      'Room Title',
      'Room Type Title',
      'Price Type',
      ...dates.map((d) => this.dateHeaderLabel(d)),
    ];
    ws.addRow(header);
    ws.getRow(1).font = { bold: true };

    let counter = 0;

 // Rooms first (like PHP)
    for (const combo of roomCombos) {
      counter++;
      const hotelName = hotels.find((h) => h.hotel_id === combo.hotel_id)?.hotel_name ?? '';
      const roomTitle = roomTitleMap.get(String(this.toBigIntSafe(combo.room_id))) ?? '';
      const roomTypeTitle = roomTypeMap.get(combo.room_type_id) ?? '';
      const priceTypeLabel = this.hotelRoomPriceTypeLabel(combo.price_type);

      const row: any[] = [counter, hotelName, cityName, roomTitle, roomTypeTitle, priceTypeLabel];

      for (const d of dates) {
        const month = this.monthLong(d);
        const year = String(d.getFullYear());
        const dayKey = `day_${d.getDate()}`;

        const key = `${combo.hotel_id}::${combo.room_id}::${combo.room_type_id}::${combo.price_type}::${year}::${month}`;
        const priceRow = roomPriceMap.get(key);
        row.push(priceRow ? (priceRow[dayKey] ?? 0) : 0);
      }

      ws.addRow(row);
    }

 // Meal rows appended (same sheet, D/E blank, F is meal label) like your PHP
    for (const m of mealCombos) {
      counter++;
      const hotelName = hotels.find((h) => h.hotel_id === m.hotel_id)?.hotel_name ?? '';
      const mealLabel = this.mealPlanTypeLabel(m.meal_type);

      const row: any[] = [counter, hotelName, cityName, '', '', mealLabel];

      for (const d of dates) {
        const month = this.monthLong(d);
        const year = String(d.getFullYear());
        const dayKey = `day_${d.getDate()}`;

        const key = `${m.hotel_id}::${m.meal_type}::${year}::${month}`;
        const mealRow = mealPriceMap.get(key);
        row.push(mealRow ? (mealRow[dayKey] ?? 0) : 0);
      }

      ws.addRow(row);
    }

    const filename = `hotel_room_price_book_${this.nowStamp()}.xlsx`;
    return this.writeExcel(res, wb, filename);
  }

 // --------------------- HOTEL AMENITIES ---------------------

  async exportHotelAmenitiesPricebookExcel(q: HotelAmenityExportQueryDto, res: Response) {
    const hotels = await this.prisma.dvi_hotel.findMany({
      where: {
        hotel_state: (q as any).stateId,
        hotel_city: (q as any).cityId,
        status: 1,
        deleted: false,
      },
      select: { hotel_id: true, hotel_name: true, hotel_city: true },
    });

    const hotelIds = hotels.map((h) => h.hotel_id);
    const city = await this.prisma.dvi_cities.findFirst({
      where: { id: (q as any).cityId },
      select: { name: true },
    });
    const cityName = city?.name ?? '';

    const rows = hotelIds.length
      ? await this.prisma.dvi_hotel_amenities_price_book.findMany({
          where: {
            hotel_id: { in: hotelIds },
            month: q.month,
            year: q.year,
            status: 1,
            deleted: 0,
          },
          orderBy: [{ hotel_id: 'asc' }, { hotel_amenities_id: 'asc' }],
        })
      : [];

    const amenityIds = [...new Set(rows.map((r) => r.hotel_amenities_id))];
    const amenities = await this.prisma.dvi_hotel_amenities.findMany({
      where: { hotel_amenities_id: { in: amenityIds } },
      select: { hotel_amenities_id: true, amenities_title: true },
    });
    const amenityMap = new Map(amenities.map((a) => [a.hotel_amenities_id, a.amenities_title ?? '']));

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Hotel Amenities Pricebook');

    const headers = [
      'S.NO',
      'Hotel Name',
      'Hotel City',
      'Amenity Name',
      'Price Type',
      'Year',
      'Month',
      ...Array.from({ length: 31 }, (_, i) => `Day ${i + 1}`),
    ];
    ws.addRow(headers);
    ws.getRow(1).font = { bold: true };

    const dayKeys = this.dayKeys31();
    let i = 0;

    for (const r of rows) {
      i++;
      const hotelName = hotels.find((h) => h.hotel_id === r.hotel_id)?.hotel_name ?? '';
      const amenityName = amenityMap.get(r.hotel_amenities_id) ?? '';

      ws.addRow([
        i,
        hotelName,
        cityName,
        amenityName,
        String(r.pricetype ?? ''),
        r.year ?? '',
        r.month ?? '',
        ...dayKeys.map((k) => (r as AnyRow)[k] ?? ''),
      ]);
    }

    const filename = `hotel_amenities_price_book_${this.nowStamp()}.xlsx`;
    return this.writeExcel(res, wb, filename);
  }

 // --------------------- GUIDE ---------------------

  async exportGuidePricebookExcel(q: GuideExportQueryDto, res: Response) {
    const rows = await this.prisma.dvi_guide_pricebook.findMany({
      where: { month: q.month, year: q.year, status: 1, deleted: 0 },
      orderBy: [{ guide_price_book_ID: 'desc' }],
    });

    const guideIds = [...new Set(rows.map((r) => r.guide_id))];
    const guides = await this.prisma.dvi_guide_details.findMany({
      where: { guide_id: { in: guideIds } },
      select: { guide_id: true, guide_name: true },
    });
    const guideMap = new Map(guides.map((g) => [g.guide_id, g.guide_name ?? '']));

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Guide Pricebook');

    const headers = [
      'S.NO',
      'Guide Name',
      'Year',
      'Month',
      'Pax Count',
      'Slot Type',
      ...Array.from({ length: 31 }, (_, i) => `Day ${i + 1}`),
    ];
    ws.addRow(headers);
    ws.getRow(1).font = { bold: true };

    const dayKeys = this.dayKeys31();
    let i = 0;

    for (const r of rows) {
      i++;
      ws.addRow([
        i,
        guideMap.get(r.guide_id) ?? '',
        r.year ?? '',
        r.month ?? '',
 r.pax_count 0, // legacy label in jackus.php; kept as numeric
 r.slot_type 0, // legacy label in jackus.php; kept as numeric
        ...dayKeys.map((k) => (r as AnyRow)[k] ?? 0),
      ]);
    }

    const filename = `guide_price_book_${this.nowStamp()}.xlsx`;
    return this.writeExcel(res, wb, filename);
  }

 // --------------------- HOTSPOT ---------------------

  async exportHotspotPricebookExcel(q: HotspotExportQueryDto, res: Response) {
    const rows = await this.prisma.dvi_hotspot_place.findMany({
      where: { hotspot_location: q.hotspotLocation, status: 1, deleted: 0 },
      orderBy: [{ hotspot_ID: 'asc' }],
    });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Hotspot Pricebook');

    const headers = [
      'S.NO',
      'Hotspot Name',
      'Hotspot Location',
      'Indian Adult Cost',
      'Indian Child Cost',
      'Indian Infant Cost',
      'Foreign Adult Cost',
      'Foreign Child Cost',
      'Foreign Infant Cost',
    ];
    ws.addRow(headers);
    ws.getRow(1).font = { bold: true };

    let i = 0;
    for (const r of rows) {
      i++;
      ws.addRow([
        i,
        r.hotspot_name ?? '',
        r.hotspot_location ?? '',
        r.hotspot_adult_entry_cost ?? 0,
        r.hotspot_child_entry_cost ?? 0,
        r.hotspot_infant_entry_cost ?? 0,
        r.hotspot_foreign_adult_entry_cost ?? 0,
        r.hotspot_foreign_child_entry_cost ?? 0,
        r.hotspot_foreign_infant_entry_cost ?? 0,
      ]);
    }

    const filename = `hotspot_price_book_${this.nowStamp()}.xlsx`;
    return this.writeExcel(res, wb, filename);
  }

 // --------------------- ACTIVITY (JSON + Excel) ---------------------

  async getActivityPricebook(q: ActivityQueryDto) {
    const rows = await this.prisma.dvi_activity_pricebook.findMany({
      where: { month: q.month, year: q.year, status: 1, deleted: 0 },
      orderBy: [{ activity_price_book_id: 'desc' }],
    });

    const activityIds = [...new Set(rows.map((r) => r.activity_id))];

 // hotspot_id is BigInt in dvi_activity_pricebook, but hotspot_ID is Int in dvi_hotspot_place
    const hotspotIdsNum = [
      ...new Set(
        rows
          .map((r) => r.hotspot_id)
          .filter((v): v is bigint => typeof v === 'bigint')
          .map((v) => this.toNumberSafeBigInt(v, 'hotspot_id')),
      ),
    ];

    const [activities, hotspots] = await Promise.all([
      this.prisma.dvi_activity.findMany({
        where: { activity_id: { in: activityIds } },
        select: { activity_id: true, activity_title: true },
      }),
      this.prisma.dvi_hotspot_place.findMany({
        where: { hotspot_ID: { in: hotspotIdsNum } },
        select: { hotspot_ID: true, hotspot_name: true },
      }),
    ]);

    const activityMap = new Map(activities.map((a) => [a.activity_id, a.activity_title ?? '']));
    const hotspotMap = new Map(hotspots.map((h) => [h.hotspot_ID, h.hotspot_name ?? '']));

    const dayKeys = this.dayKeys31();

    const out = rows.map((r) => {
      const hotspotIdNum = this.toNumberSafeBigInt(r.hotspot_id, 'hotspot_id');

      return {
 // keep stable JSON: BigInt must NOT be returned as BigInt
        activityPriceBookId: String(r.activity_price_book_id),
        activityId: r.activity_id,
        activityName: activityMap.get(r.activity_id) ?? '',
        hotspotId: r.hotspot_id.toString(),
        hotspotName: hotspotMap.get(hotspotIdNum) ?? '',
        nationality: r.nationality ?? 0,
        nationalityLabel: this.nationalityLabel(r.nationality ?? 0),
        month: r.month ?? '',
        year: r.year ?? '',
        days: dayKeys.map((k) => (r as AnyRow)[k] ?? 0),
      };
    });

    return { count: out.length, rows: out };
  }

  async exportActivityPricebookExcel(q: ActivityQueryDto, res: Response) {
    const data = await this.getActivityPricebook(q);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Activity Pricebook');

    const headers = [
      'S.No',
      'Activity Name',
      'Hotspot',
      'Nationality',
      'Month',
      'Year',
      ...Array.from({ length: 31 }, (_, i) => `Day ${i + 1}`),
    ];
    ws.addRow(headers);
    ws.getRow(1).font = { bold: true };

    for (let i = 0; i < data.rows.length; i++) {
      const r = data.rows[i];
      ws.addRow([
        i + 1,
        r.activityName,
        r.hotspotName,
 r.nationalityLabel, // legacy displayed label
        r.month,
        r.year,
        ...r.days,
      ]);
    }

    const filename = `activity_price_book_${this.nowStamp()}.xlsx`;
    return this.writeExcel(res, wb, filename);
  }

 // --------------------- TOLL (JSON + Excel) ---------------------

  async getTollPricebook(q: TollQueryDto) {
    const tollRows = await this.prisma.dvi_vehicle_toll_charges.findMany({
      where: {
        vehicle_type_id: q.vehicleTypeId,
        status: 1,
        deleted: 0,
      },
      orderBy: [{ vehicle_toll_charge_ID: 'asc' }],
    });

    const locationIds = [...new Set(tollRows.map((r) => r.location_id))];
    const [locations, vehicleType] = await Promise.all([
      this.prisma.dvi_stored_locations.findMany({
        where: { location_ID: { in: locationIds as any } },
        select: { location_ID: true, source_location: true, destination_location: true },
      }),
      this.prisma.dvi_vehicle_type.findFirst({
        where: { vehicle_type_id: q.vehicleTypeId },
        select: { vehicle_type_title: true },
      }),
    ]);

    const locMap = new Map(locations.map((l) => [String(l.location_ID), l]));
    const vehicleTypeTitle = vehicleType?.vehicle_type_title ?? '';

    const rows = tollRows.map((r) => {
      const loc = locMap.get(String(r.location_id));
      return {
        id: r.vehicle_toll_charge_ID,
        sourceLocation: loc?.source_location ?? '',
        destinationLocation: loc?.destination_location ?? '',
        vehicleTypeId: r.vehicle_type_id,
        vehicleTypeTitle,
        tollCharge: r.toll_charge ?? 0,
      };
    });

    return { count: rows.length, rows };
  }

  async exportTollPricebookExcel(q: TollQueryDto, res: Response) {
    const data = await this.getTollPricebook(q);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Toll Pricebook');

    const headers = ['S.NO', 'Source Location', 'Destination Location', 'Vehicle Type', 'Toll Charge'];
    ws.addRow(headers);
    ws.getRow(1).font = { bold: true };

    data.rows.forEach((r, idx) => {
      ws.addRow([idx + 1, r.sourceLocation, r.destinationLocation, r.vehicleTypeTitle, r.tollCharge]);
    });

    const filename = `toll_price_book_${this.nowStamp()}.xlsx`;
    return this.writeExcel(res, wb, filename);
  }

 // --------------------- PARKING (JSON + Excel) ---------------------

  async getParkingPricebook(q: ParkingQueryDto) {
    const where: AnyRow = { status: 1, deleted: 0 };
    if (q.vehicleTypeId) where.vehicle_type_id = q.vehicleTypeId;

    const rows = await this.prisma.dvi_hotspot_vehicle_parking_charges.findMany({
      where,
      orderBy: [{ vehicle_parking_charge_ID: 'asc' }],
    });

 // dvi_hotspot_vehicle_parking_charges.hotspot_id is likely BigInt (legacy)
 // but dvi_hotspot_place.hotspot_ID is Int
    const hotspotIdsNum = [
      ...new Set(
        rows
          .map((r) => r.hotspot_id)
          .map((v) => this.toBigIntSafe(v))
          .map((v) => this.toNumberSafeBigInt(v, 'hotspot_id')),
      ),
    ];
    const vehicleTypeIds = [...new Set(rows.map((r) => r.vehicle_type_id))];

    const [hotspots, vehicleTypes] = await Promise.all([
      this.prisma.dvi_hotspot_place.findMany({
        where: { hotspot_ID: { in: hotspotIdsNum }, status: 1, deleted: 0 },
        select: { hotspot_ID: true, hotspot_name: true, hotspot_location: true },
      }),
      this.prisma.dvi_vehicle_type.findMany({
        where: { vehicle_type_id: { in: vehicleTypeIds } },
        select: { vehicle_type_id: true, vehicle_type_title: true },
      }),
    ]);

    const hotspotMap = new Map<number, { hotspot_name: string | null; hotspot_location: string | null }>(
      hotspots.map((h) => [h.hotspot_ID, { hotspot_name: h.hotspot_name, hotspot_location: h.hotspot_location }]),
    );
    const vehicleTypeMap = new Map(vehicleTypes.map((v) => [v.vehicle_type_id, v.vehicle_type_title ?? '']));

    const filtered = rows
      .map((r) => {
        const hidNum = this.toNumberSafeBigInt(this.toBigIntSafe(r.hotspot_id), 'hotspot_id');
        const h = hotspotMap.get(hidNum);

        return {
          id: String(r.vehicle_parking_charge_ID),
 hotspotId: this.toBigIntSafe(r.hotspot_id).toString(), // safe JSON
          hotspotName: h?.hotspot_name ?? '',
          hotspotLocation: h?.hotspot_location ?? '',
          vehicleTypeId: r.vehicle_type_id,
          vehicleTypeName: vehicleTypeMap.get(r.vehicle_type_id) ?? '',
          parkingCharge: r.parking_charge ?? 0,
        };
      })
      .filter((r) => (q.hotspotLocation ? r.hotspotLocation === q.hotspotLocation : true));

    return { count: filtered.length, rows: filtered };
  }

  async exportParkingPricebookExcel(q: ParkingQueryDto, res: Response) {
    const data = await this.getParkingPricebook(q);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Parking Pricebook');

    const headers = ['Count', 'Hotspot Name', 'Vehicle Type Name', 'Parking Charge'];
    ws.addRow(headers);
    ws.getRow(1).font = { bold: true };

    data.rows.forEach((r, idx) => {
      ws.addRow([idx + 1, r.hotspotName, r.vehicleTypeName, r.parkingCharge]);
    });

    const filename = `parking_price_book_${this.nowStamp()}.xlsx`;
    return this.writeExcel(res, wb, filename);
  }
}
