import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { PrismaService } from '../../../prisma.service';
import { TBOHotelProvider } from '../providers/tbo-hotel.provider';
import { TboMasterPricePreviewDto, UpdateTboMasterHotelDto } from '../dto/tbo-master.dto';
import { TboMasterGalleryService } from './tbo-master-gallery.service';

export const normalizeTboMasterImportHeader = (value: unknown) =>
  String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');

export const parseTboMasterListCell = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map((item) => String(item ?? '').trim()).filter(Boolean);
  const text = String(value ?? '').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item ?? '').trim()).filter(Boolean);
    } catch {
      // Fall through to the human-friendly delimiter format.
    }
  }
  return text.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
};

const SOUTH_INDIAN_STATE_NAMES = [
  'Andhra Pradesh',
  'Karnataka',
  'Kerala',
  'Tamil Nadu',
  'Telangana',
  'Puducherry',
  'Pondicherry',
];

const SOUTH_INDIAN_REGION_STATE_NAMES: Record<string, string[]> = {
  'south-india': SOUTH_INDIAN_STATE_NAMES,
  'andhra-pradesh': ['Andhra Pradesh'],
  karnataka: ['Karnataka'],
  kerala: ['Kerala'],
  'tamil-nadu': ['Tamil Nadu'],
  telangana: ['Telangana'],
  puducherry: ['Puducherry', 'Pondicherry'],
};

const excelCellText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const item = value as any;
    if (Array.isArray(item.richText)) return item.richText.map((part: any) => part?.text || '').join('');
    if (item.text !== undefined) return String(item.text);
    if (item.result !== undefined) return excelCellText(item.result);
  }
  return String(value).trim();
};

const categoryLookupKey = (value: unknown) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

const toExcelList = (value: unknown) => parseTboMasterListCell(value).join(', ');

const toExcelJson = (value: unknown) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
};

const toFileNamePart = (value: unknown) => String(value ?? '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 60);

@Injectable()
export class TboMasterHotelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tboProvider: TBOHotelProvider,
    private readonly gallery: TboMasterGalleryService,
  ) {}

  async exportBulk(query: { search?: string; cityCode?: string; priority?: string; region?: string } = {}) {
    const where = await this.buildListWhere(query);
    const [items, categories] = await Promise.all([
      this.prisma.tbo_hotel_master.findMany({ where, orderBy: { id: 'asc' } }),
      this.prisma.dvi_hotel_category.findMany({
        where: { deleted: 0 },
        select: { hotel_category_id: true, hotel_category_title: true, hotel_category_code: true },
      }),
    ]);
    const categoryById = new Map(categories.map((category) => [Number(category.hotel_category_id), category]));
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'DVI Travel';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Hotels');
    const headers = [
      'Hotel name',
      'Hotel category',
      'Hotel email',
      'Hotel phone',
      'Facilities',
      'Amenities',
      'hotel_id',
      'TBO hotel code',
      'TBO city code',
      'Hotel address',
      'City',
      'Star rating',
      'Hotel category ID',
      'Hotel image URL',
      'Check-in time',
      'Check-out time',
      'Status',
      'Hotel latitude',
      'Hotel longitude',
      'Priority',
      'Reviews',
    ];
    sheet.addRow(headers);
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    headerRow.alignment = { vertical: 'middle', wrapText: true };
    headerRow.height = 28;
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + headers.length)}1` };

    for (const item of items) {
      const category = categoryById.get(Number(item.hotel_category_id || 0));
      sheet.addRow([
        item.hotel_name || '',
        category?.hotel_category_title || category?.hotel_category_code || (item.hotel_category_id ? String(item.hotel_category_id) : ''),
        item.hotel_email || '',
        item.hotel_mobile || '',
        toExcelList(item.facilities),
        toExcelList(item.amenities),
        item.id,
        item.tbo_hotel_code,
        item.tbo_city_code,
        item.hotel_address || '',
        item.city_name || '',
        item.star_rating ?? '',
        item.hotel_category_id ?? 0,
        item.hotel_image_url || '',
        item.check_in_time || '',
        item.check_out_time || '',
        item.status ?? '',
        item.hotel_latitude || '',
        item.hotel_longitude || '',
        Number(item.is_priority) === 1 ? 'Yes' : 'No',
        toExcelJson(item.reviews),
      ]);
    }

    const widths = [32, 22, 32, 20, 36, 36, 12, 18, 16, 40, 20, 12, 18, 40, 16, 16, 10, 18, 18, 12, 50];
    widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1) row.alignment = { vertical: 'top', wrapText: true };
    });
    const buffer = await workbook.xlsx.writeBuffer();
    const filterParts = [
      query.region,
      query.priority === '1' ? 'priority-only' : query.priority === '0' ? 'non-priority' : '',
      query.search ? `search-${query.search}` : '',
    ].map(toFileNamePart).filter(Boolean);
    const filterSuffix = filterParts.length ? `-${filterParts.join('-')}` : '';
    return {
      buffer: Buffer.from(buffer as any),
      fileName: `vsr-master-hotels${filterSuffix}-${new Date().toISOString().slice(0, 10)}.xlsx`,
      count: items.length,
    };
  }

  async importBulk(buffer: Buffer) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new BadRequestException('Workbook does not contain a Hotels sheet');
    const headerRow = sheet.getRow(1);
    const columns = new Map<string, number>();
    headerRow.eachCell((cell, columnNumber) => {
      const key = normalizeTboMasterImportHeader(excelCellText(cell.value));
      if (key) columns.set(key, columnNumber);
    });
    const aliases: Record<string, string[]> = {
      hotelId: ['hotelid', 'id'],
      name: ['hotelname', 'name'],
      category: ['hotelcategory', 'category'],
      email: ['hotelemail', 'email', 'hotelemailid'],
      phone: ['hotelphone', 'hotelmobile', 'hotelmobileno', 'phone'],
      facilities: ['facilities', 'facility'],
      amenities: ['amenities', 'amenity'],
    };
    const columnFor = (field: string) => aliases[field].map((alias) => columns.get(alias)).find(Boolean);
    const idColumn = columnFor('hotelId');
    if (!idColumn) throw new BadRequestException('The workbook must include the hotel_id column');
    const categoryColumn = columnFor('category');
    const categoryRows = categoryColumn
      ? await this.prisma.dvi_hotel_category.findMany({
          where: { deleted: 0 },
          select: { hotel_category_id: true, hotel_category_title: true, hotel_category_code: true },
        })
      : [];
    const categoryByKey = new Map<string, number>();
    for (const category of categoryRows) {
      const id = Number(category.hotel_category_id);
      if (category.hotel_category_title) categoryByKey.set(categoryLookupKey(category.hotel_category_title), id);
      if (category.hotel_category_code) categoryByKey.set(categoryLookupKey(category.hotel_category_code), id);
      categoryByKey.set(String(id), id);
    }
    categoryByKey.set(categoryLookupKey('no category'), 0);
    categoryByKey.set('', 0);

    const rows: Array<{ rowNumber: number; id: number; data: Record<string, unknown> }> = [];
    const errors: Array<{ row: number; message: string }> = [];
    const ids = new Set<number>();
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const rawId = excelCellText(idColumn ? row.getCell(idColumn).value : '');
      if (!rawId) continue;
      const id = Number(rawId);
      if (!Number.isInteger(id) || id <= 0) {
        errors.push({ row: rowNumber, message: 'hotel_id must be a positive integer' });
        continue;
      }
      if (ids.has(id)) {
        errors.push({ row: rowNumber, message: `hotel_id ${id} is duplicated` });
        continue;
      }
      ids.add(id);
      const data: Record<string, unknown> = {};
      const valueFor = (field: string) => {
        const column = columnFor(field);
        return column ? excelCellText(row.getCell(column).value) : undefined;
      };
      const name = valueFor('name');
      if (name !== undefined) {
        if (!name) errors.push({ row: rowNumber, message: 'Hotel name cannot be blank' });
        else data.hotel_name = name;
      }
      const category = valueFor('category');
      if (category !== undefined) {
        const categoryId = categoryByKey.get(categoryLookupKey(category));
        if (categoryId === undefined) errors.push({ row: rowNumber, message: `Unknown hotel category: ${category}` });
        else data.hotel_category_id = categoryId;
      }
      const email = valueFor('email');
      if (email !== undefined) {
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push({ row: rowNumber, message: 'Hotel email is invalid' });
        else data.hotel_email = email || null;
      }
      const phone = valueFor('phone');
      if (phone !== undefined) data.hotel_mobile = phone || null;
      const facilities = valueFor('facilities');
      if (facilities !== undefined) data.facilities = parseTboMasterListCell(facilities);
      const amenities = valueFor('amenities');
      if (amenities !== undefined) data.amenities = parseTboMasterListCell(amenities);
      if (!Object.keys(data).length) errors.push({ row: rowNumber, message: 'No editable hotel fields found' });
      rows.push({ rowNumber, id, data });
    }
    if (errors.length) throw new BadRequestException({ message: 'The workbook contains validation errors', errors });
    if (!rows.length) throw new BadRequestException('The workbook does not contain any hotel rows');

    const existing = await this.prisma.tbo_hotel_master.findMany({ where: { id: { in: rows.map((row) => row.id) } }, select: { id: true } });
    const existingIds = new Set(existing.map((row) => Number(row.id)));
    const missing = rows.filter((row) => !existingIds.has(row.id));
    if (missing.length) {
      throw new BadRequestException({
        message: 'Some hotel_id values do not exist in the VSR master table',
        errors: missing.map((row) => ({ row: row.rowNumber, message: `hotel_id ${row.id} was not found` })),
      });
    }
    await this.prisma.$transaction(rows.map((row) => this.prisma.tbo_hotel_master.update({ where: { id: row.id }, data: row.data as any })));
    return { success: true, updated: rows.length };
  }

  private async buildListWhere(query: { search?: string; cityCode?: string; priority?: string; region?: string }) {
    const search = String(query.search || '').trim();
    const cityCode = String(query.cityCode || '').trim();
    const priority = query.priority === undefined || query.priority === '' ? undefined : Number(query.priority) ? 1 : 0;
    const region = String(query.region || '').trim().toLowerCase();
    const filters: Record<string, unknown>[] = [];
    const selectedStateNames = SOUTH_INDIAN_REGION_STATE_NAMES[region];
    if (selectedStateNames) {
      const states = await this.prisma.dvi_states.findMany({
        where: { deleted: 0, name: { in: selectedStateNames } },
        select: { id: true },
      });
      const stateIds = states.map((state) => state.id);
      const cities = stateIds.length
        ? await this.prisma.dvi_cities.findMany({
            where: { deleted: 0, state_id: { in: stateIds } },
            select: { name: true, tbo_city_code: true },
          })
        : [];
      const cityCodes = cities.map((city) => String(city.tbo_city_code || '').trim()).filter(Boolean);
      const cityNames = cities.map((city) => String(city.name || '').trim()).filter(Boolean);
      const regionWhere = {
        OR: [
          ...(cityCodes.length ? [{ tbo_city_code: { in: cityCodes } }] : []),
          ...(cityNames.length ? [{ city_name: { in: cityNames } }] : []),
        ],
      };
      filters.push(regionWhere);
    }
    if (search) {
      filters.push({
        OR: [
          { hotel_name: { contains: search } },
          { tbo_hotel_code: { contains: search } },
          { city_name: { contains: search } },
        ],
      });
    }
    const where = {
      status: 1,
      ...(cityCode ? { tbo_city_code: cityCode } : {}),
      ...(priority === undefined ? {} : { is_priority: priority }),
      ...(filters.length ? { AND: filters } : {}),
    };
    return where;
  }

  async list(query: { search?: string; cityCode?: string; page?: number; limit?: number; priority?: string; region?: string }) {
    const page = Math.max(1, Number(query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit || 20)));
    const where = await this.buildListWhere(query);
    const [total, items] = await Promise.all([
      this.prisma.tbo_hotel_master.count({ where }),
      this.prisma.tbo_hotel_master.findMany({
        where,
        orderBy: [{ is_priority: 'desc' }, { hotel_name: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    const galleryByCode = await this.gallery.getHotelImagesForCodes(items.map((item) => item.tbo_hotel_code));
    const roomImages = await Promise.all(items.map((item) => this.gallery.getRoomImages(item.tbo_hotel_code)));
    const cityIds = await this.resolveDviCityIds(items);
    return {
      page,
      limit,
      total,
      items: items.map((item, index) => this.toResponse(item, galleryByCode.get(item.tbo_hotel_code) || [], roomImages[index] || [], cityIds.get(Number(item.id)) ?? null)),
    };
  }

  async get(code: string) {
    const item = await this.prisma.tbo_hotel_master.findUnique({ where: { tbo_hotel_code: String(code).trim() } });
    if (!item) throw new NotFoundException('TBO master hotel not found');
    const [images, roomGallery, cityIds] = await Promise.all([
      this.gallery.getHotelImages(item.tbo_hotel_code),
      this.gallery.getRoomImages(item.tbo_hotel_code),
      this.resolveDviCityIds([item]),
    ]);
    return this.toResponse(item, images, roomGallery, cityIds.get(Number(item.id)) ?? null);
  }

  async update(code: string, dto: UpdateTboMasterHotelDto, userId?: number) {
    const existing = await this.prisma.tbo_hotel_master.findUnique({ where: { tbo_hotel_code: String(code).trim() } });
    if (!existing) throw new NotFoundException('TBO master hotel not found');
    const data: any = {};
    if (dto.name !== undefined) data.hotel_name = dto.name;
    if (dto.address !== undefined) data.hotel_address = dto.address;
    if (dto.city !== undefined) data.city_name = dto.city;
    if (dto.cityId !== undefined) {
      if (dto.cityId === null) {
        data.dvi_city_id = null;
      } else {
        const city = await this.prisma.dvi_cities.findFirst({
          where: { id: dto.cityId, deleted: 0 },
          select: { id: true },
        });
        if (!city) throw new BadRequestException('The selected DVI city does not exist or is deleted');
        data.dvi_city_id = city.id;
      }
    }
    if (dto.rating !== undefined) data.star_rating = dto.rating;
    if (dto.categoryId !== undefined) data.hotel_category_id = dto.categoryId || 0;
    if (dto.imageUrl !== undefined) data.hotel_image_url = dto.imageUrl;
    if (dto.hotelEmail !== undefined) data.hotel_email = dto.hotelEmail?.trim() || null;
    if (dto.hotelMobile !== undefined) data.hotel_mobile = dto.hotelMobile?.trim() || null;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.checkInTime !== undefined) data.check_in_time = dto.checkInTime;
    if (dto.checkOutTime !== undefined) data.check_out_time = dto.checkOutTime;
    if (dto.facilities !== undefined) data.facilities = dto.facilities;
    if (dto.amenities !== undefined) data.amenities = dto.amenities;
    if (dto.reviews !== undefined) data.reviews = dto.reviews;
    if (dto.latitude !== undefined) data.hotel_latitude = dto.latitude;
    if (dto.longitude !== undefined) data.hotel_longitude = dto.longitude;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.isPriority !== undefined) data.is_priority = dto.isPriority ? 1 : 0;
    const updated = await this.prisma.tbo_hotel_master.update({ where: { tbo_hotel_code: existing.tbo_hotel_code }, data });
    return this.get(code);
  }

  async setPriority(code: string, isPriority: boolean) {
    const updated = await this.prisma.tbo_hotel_master.updateMany({
      where: { tbo_hotel_code: String(code).trim() },
      data: { is_priority: isPriority ? 1 : 0 },
    });
    if (!updated.count) throw new NotFoundException('TBO master hotel not found');
    return this.get(code);
  }

  async pricePreview(code: string, dto: TboMasterPricePreviewDto) {
    const hotel = await this.prisma.tbo_hotel_master.findUnique({ where: { tbo_hotel_code: String(code).trim() } });
    if (!hotel) throw new NotFoundException('TBO master hotel not found');
    if (new Date(dto.checkOut) <= new Date(dto.checkIn)) throw new BadRequestException('Check-out must be after check-in');
    // The master preview form treats adults/children as the occupancy for each
    // requested room. TBO requires one PaxRooms entry per room; passing one
    // entry while changing only roomCount silently quotes a single room.
    const childCount = dto.children || 0;
    const childAges = childCount > 0 && dto.childAges?.length === childCount
      ? dto.childAges
      : childCount > 0 ? Array.from({ length: childCount }, () => 10) : [];
    const occupancies = Array.from({ length: dto.rooms }, () => ({
      adults: dto.adults,
      children: childCount,
      // The master-preview form sends one agreed default age for every child.
      // Keep the fallback for older API callers that only send a child count.
      childrenAges: childAges,
    }));
    const results = await this.tboProvider.search({
      cityCode: hotel.tbo_city_code,
      hotelCodes: hotel.tbo_hotel_code,
      checkInDate: dto.checkIn,
      checkOutDate: dto.checkOut,
      roomCount: dto.rooms,
      guestCount: (dto.adults + childCount) * dto.rooms,
      guestNationality: 'IN',
      occupancies,
    }, { mealPlanCode: dto.mealPlanCode, tboNoOfRooms: dto.rooms });
    const matches = results.filter((result) => String(result.providerHotelCode || result.hotelCode) === hotel.tbo_hotel_code);
    if (!matches.length) return { status: 'NO_AVAILABILITY', hotelCode: hotel.tbo_hotel_code, options: [] };
    return {
      status: 'AVAILABLE',
      hotelCode: hotel.tbo_hotel_code,
      checkIn: dto.checkIn,
      checkOut: dto.checkOut,
      options: matches.map((result) => ({
        hotelName: result.hotelName,
        roomType: result.roomType,
        mealPlan: result.mealPlan,
        price: result.price,
        totalStayPrice: result.totalStayPrice,
        currency: result.currency,
        cancellationPolicy: result.cancellationPolicy,
        rateOptionId: result.rateOptionId,
        expiresAt: result.expiresAt,
      })),
    };
  }

  private async resolveDviCityIds(items: any[]) {
    const explicitIds = [...new Set(items.map((item) => Number(item.dvi_city_id)).filter((id) => Number.isInteger(id) && id > 0))];
    const codes = [...new Set(items.map((item) => String(item.tbo_city_code || '').trim()).filter(Boolean))];
    const names = [...new Set(items.map((item) => String(item.city_name || '').trim()).filter(Boolean))];
    const [explicitCities, byCode, byName] = await Promise.all([
      explicitIds.length
        ? this.prisma.dvi_cities.findMany({ where: { id: { in: explicitIds }, deleted: 0 }, select: { id: true } })
        : [],
      codes.length ? this.prisma.dvi_cities.findMany({ where: { deleted: 0, tbo_city_code: { in: codes } }, select: { id: true, tbo_city_code: true } }) : [],
      names.length ? this.prisma.dvi_cities.findMany({ where: { deleted: 0, name: { in: names } }, select: { id: true, name: true } }) : [],
    ]);
    const validExplicitIds = new Set(explicitCities.map((city) => Number(city.id)));
    const idByCode = new Map<string, number>(byCode.map((city): [string, number] => [String(city.tbo_city_code || '').trim(), Number(city.id)]));
    const idByName = new Map<string, number>(byName.map((city): [string, number] => [String(city.name || '').trim().toLowerCase(), Number(city.id)]));
    return new Map<number, number | null>(items.map((item): [number, number | null] => {
      const explicitId = Number(item.dvi_city_id);
      const resolvedId = validExplicitIds.has(explicitId)
        ? explicitId
        : idByCode.get(String(item.tbo_city_code || '').trim())
          ?? idByName.get(String(item.city_name || '').trim().toLowerCase())
          ?? null;
      return [Number(item.id), resolvedId];
    }));
  }

  private toResponse(item: any, images: any[] = [], roomGallery: any[] = [], cityId: number | null = null) {
    return {
      id: item.id,
      hotelCode: item.tbo_hotel_code,
      cityCode: item.tbo_city_code,
      cityId,
      name: item.hotel_name,
      city: item.city_name,
      address: item.hotel_address,
      rating: item.star_rating,
      categoryId: Number(item.hotel_category_id || 0),
      imageUrl: item.hotel_image_url || images.find((image) => image.isPrimary)?.url || images[0]?.url || null,
      hotelEmail: item.hotel_email,
      hotelMobile: item.hotel_mobile,
      images,
      primaryImageUrl: images.find((image) => image.isPrimary)?.url || images[0]?.url || item.hotel_image_url || null,
      roomGallery,
      description: item.description,
      checkInTime: item.check_in_time,
      checkOutTime: item.check_out_time,
      facilities: Array.isArray(item.facilities) ? item.facilities : [],
      amenities: Array.isArray(item.amenities) ? item.amenities : [],
      reviews: Array.isArray(item.reviews) ? item.reviews : [],
      latitude: item.hotel_latitude,
      longitude: item.hotel_longitude,
      isPriority: Number(item.is_priority) === 1,
      status: item.status,
      updatedAt: item.updated_at,
    };
  }
}
