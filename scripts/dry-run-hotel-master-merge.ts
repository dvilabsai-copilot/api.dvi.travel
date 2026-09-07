import 'dotenv/config';
import mysql, { RowDataPacket } from 'mysql2/promise';

type Hotel = {
  hotel_id: number;
  hotel_name: string | null;
  hotel_code: string | null;
  hotel_city: string | null;
  hotel_state: string | null;
  hotel_address: string | null;
  status: number;
  deleted: number | boolean;
  tbo_hotel_code?: string | null;
  resavenue_hotel_code?: string | null;
  axisrooms_property_id?: string | null;
  staah_property_id?: string | null;
};

type Counts = Record<number, { rooms: number; ratePlans: number; priceBooks: number }>;

const mainUrl = process.env.DATABASE_URL;
const legacyUrl = process.env.LEGACY_DATABASE_URL;

if (!mainUrl || !legacyUrl) {
  throw new Error(
    'Set DATABASE_URL for dvi_main and LEGACY_DATABASE_URL for dvi_travels. This command is read-only.',
  );
}

const normalize = (value: unknown): string =>
  String(value ?? '')
    .normalize('NFKD')
    .replace(/&amp;/gi, 'and')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .toLowerCase();

const key = (name: unknown, city: unknown): string => `${normalize(name)}|${normalize(city)}`;

async function loadHotels(db: mysql.Connection, includeProviderMappings: boolean): Promise<Hotel[]> {
  const providerColumns = includeProviderMappings
    ? ', tbo_hotel_code, resavenue_hotel_code, axisrooms_property_id, staah_property_id'
    : '';
  const [rows] = await db.query<RowDataPacket[]>(`
    SELECT hotel_id, hotel_name, hotel_code, hotel_city, hotel_state,
           hotel_address, status, deleted${providerColumns}
    FROM dvi_hotel
    WHERE deleted = 0 AND status = 1
    ORDER BY hotel_id
  `);
  return rows as Hotel[];
}

async function loadCounts(db: mysql.Connection): Promise<Counts> {
  const counts: Counts = {};
  const tables = [
    ['rooms', 'dvi_hotel_rooms', 'room_ID'],
    ['ratePlans', 'dvi_hotel_room_rate_plan', 'hotel_room_rate_plan_id'],
    ['priceBooks', 'dvi_hotel_room_price_book', 'hotel_price_book_id'],
  ] as const;

  for (const [field, table, idColumn] of tables) {
    const [tableRows] = await db.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS table_count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`,
      [table],
    );
    if (Number(tableRows[0]?.table_count ?? 0) === 0) continue;
    const [rows] = await db.query<RowDataPacket[]>(`
      SELECT hotel_id, COUNT(${idColumn}) AS row_count
      FROM ${table}
      WHERE deleted = 0
      GROUP BY hotel_id
    `);
    for (const row of rows) {
      const hotelId = Number(row.hotel_id);
      counts[hotelId] ??= { rooms: 0, ratePlans: 0, priceBooks: 0 };
      counts[hotelId][field] = Number(row.row_count);
    }
  }
  return counts;
}

async function loadProtectedTargetHotels(db: mysql.Connection): Promise<number[]> {
  const [rows] = await db.query<RowDataPacket[]>(`
    SELECT DISTINCT rp.hotel_id
    FROM dvi_hotel_room_rate_plan rp
    INNER JOIN dvi_hotel_room_price_book pb ON pb.hotel_id = rp.hotel_id
    WHERE rp.deleted = 0 AND rp.status = 1
      AND pb.deleted = 0 AND pb.status = 1
  `);
  return rows.map((row) => Number(row.hotel_id)).sort((a, b) => a - b);
}

function classify(source: Hotel, targetByCode: Map<string, Hotel[]>, targetByNameCity: Map<string, Hotel[]>): string {
  const code = String(source.hotel_code ?? '').trim();
  const codeMatches = code ? targetByCode.get(code) ?? [] : [];
  const nameCityMatches = targetByNameCity.get(key(source.hotel_name, source.hotel_city)) ?? [];

  if (codeMatches.length === 1 && nameCityMatches.some((row) => row.hotel_id === codeMatches[0].hotel_id)) {
    return 'EXACT_CODE_AND_NAME_CITY';
  }
  if (nameCityMatches.length === 1) return 'NAME_CITY_ONLY';
  if (codeMatches.length > 0) return 'CODE_ONLY_OR_CONFLICT';
  if (nameCityMatches.length > 1) return 'NAME_CITY_AMBIGUOUS';
  return 'UNMATCHED';
}

async function main(): Promise<void> {
  const mainDb = await mysql.createConnection(mainUrl!);
  const legacyDb = await mysql.createConnection(legacyUrl!);
  try {
    const [target, source, targetCounts, sourceCounts, protectedTargetHotelIds] = await Promise.all([
      loadHotels(mainDb, true),
      loadHotels(legacyDb, false),
      loadCounts(mainDb),
      loadCounts(legacyDb),
      loadProtectedTargetHotels(mainDb),
    ]);

    const targetByCode = new Map<string, Hotel[]>();
    const targetByNameCity = new Map<string, Hotel[]>();
    for (const hotel of target) {
      const code = String(hotel.hotel_code ?? '').trim();
      if (code) targetByCode.set(code, [...(targetByCode.get(code) ?? []), hotel]);
      targetByNameCity.set(key(hotel.hotel_name, hotel.hotel_city), [
        ...(targetByNameCity.get(key(hotel.hotel_name, hotel.hotel_city)) ?? []),
        hotel,
      ]);
    }

    const classifications = source.map((hotel) => ({
      sourceHotelId: hotel.hotel_id,
      sourceName: hotel.hotel_name,
      sourceCode: hotel.hotel_code,
      sourceCity: hotel.hotel_city,
      classification: classify(hotel, targetByCode, targetByNameCity),
      sourceMasterRows: sourceCounts[hotel.hotel_id] ?? { rooms: 0, ratePlans: 0, priceBooks: 0 },
      providerMappingsMustRemainUnchanged: true,
    }));

    const summary = classifications.reduce<Record<string, number>>((result, row) => {
      result[row.classification] = (result[row.classification] ?? 0) + 1;
      return result;
    }, {});

    console.log(JSON.stringify({
      mode: 'DRY_RUN_READ_ONLY',
      sourceDatabase: 'dvi_travels',
      targetDatabase: 'dvi_main',
      sourceActiveHotels: source.length,
      targetActiveHotels: target.length,
      protectedTargetHotelIds,
      protectedTargetHotelCount: protectedTargetHotelIds.length,
      classifications: summary,
      providerMappingPolicy: 'PRESERVE_EXISTING_TARGET_VALUES; never overwrite from legacy source',
      dependentMasterTables: [
        'dvi_hotel_rooms',
        'dvi_hotel_room_rate_plan',
        'dvi_hotel_room_price_book',
      ],
      targetMasterRowCountsByHotel: targetCounts,
      sourceMasterRowCountsByHotel: sourceCounts,
      rows: classifications,
    }, null, 2));
  } finally {
    await Promise.all([mainDb.end(), legacyDb.end()]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
