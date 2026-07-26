require('dotenv').config();

const fs = require('fs');
const mysql = require('mysql2/promise');
const path = require('path');

const PRICE_COLUMNS = [
  'hotel_id',
  'room_type_id',
  'room_id',
  'price_type',
  'year',
  'month',
  ...Array.from({ length: 31 }, (_, index) => `day_${index + 1}`),
  'status',
  'deleted',
];

const IDENTIFIER = /^[A-Za-z0-9_]+$/;

function parseArgs(argv) {
  const args = {};
  for (const token of argv.slice(2)) {
    if (token === '--apply') args.apply = true;
    else if (token === '--create-missing-hotels') args.createMissingHotels = true;
    else if (token === '--create-missing-rooms') args.createMissingRooms = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else if (token.startsWith('--')) {
      const separator = token.indexOf('=');
      if (separator === -1) args[token.slice(2)] = true;
      else args[token.slice(2, separator)] = token.slice(separator + 1);
    }
  }

  const batchSize = Number(args['batch-size'] || 500);
  const maxRows = args['max-rows'] === undefined ? null : Number(args['max-rows']);
  const year = args.year === undefined ? null : String(args.year);
  const month = args.month === undefined ? null : String(args.month);
  const fromDate = args['from-date'] === undefined ? null : String(args['from-date']);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) {
    throw new Error('--batch-size must be an integer between 1 and 5000');
  }
  if (maxRows !== null && (!Number.isInteger(maxRows) || maxRows < 1)) {
    throw new Error('--max-rows must be a positive integer');
  }
  if (year !== null && !/^\d{4}$/.test(year)) throw new Error('--year must be a four-digit year');
  if (fromDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) throw new Error('--from-date must use YYYY-MM-DD');

  return {
    sourceDb: args['source-db'] || process.env.SOURCE_DB || 'dvi_travels',
    targetDb: args['target-db'] || process.env.TARGET_DB || 'dvi_main',
    year,
    month,
    fromDate,
    batchSize,
    maxRows,
    apply: Boolean(args.apply),
    sqlFile: args['sql-file'] || null,
    mappingReport: args['mapping-report'] || null,
    confirm: args.confirm || '',
    createMissingHotels: Boolean(args.createMissingHotels),
    createMissingRooms: Boolean(args.createMissingRooms),
    help: Boolean(args.help),
  };
}

function printHelp() {
  console.log(`
Direct hotel-rate sync (no SQL dump files)

Default behavior is a read-only dry run. Writes require both --apply and --confirm=SYNC.

Examples:
  node scripts/sync-hotel-rates-between-databases.js --year=2026 --month=August
  node scripts/sync-hotel-rates-between-databases.js --year=2026 --month=August --apply --confirm=SYNC

Options:
  --source-db=dvi_travels       Source database (default: dvi_travels)
  --target-db=dvi_main          Target database (default: dvi_main)
  --year=2026                   Only sync one year
  --month=August                Only sync one month; month aliases are recognized
  --from-date=2026-07-25        Only include this date and future dates
  --batch-size=500              Source rows read per batch
  --max-rows=1000               Limit rows for a test run
  --create-missing-hotels       Create unmapped hotels in the target (opt-in)
  --create-missing-rooms        Create unmapped rooms in the target (opt-in)
  --apply --confirm=SYNC        Apply changes to the target database
  --sql-file=path.sql           Write mapped SQL instead of changing the target
  --mapping-report=path.json    Write skipped hotel/room mapping details

Connection settings:
  Target uses DATABASE_URL. Source uses SOURCE_DATABASE_URL when present;
  otherwise the target host/user/password is reused with --source-db.
`);
}

function parseMysqlUrl(raw, fallbackDatabase) {
  if (!raw) throw new Error('DATABASE_URL is missing or invalid');
  const url = new URL(raw);
  if (url.protocol !== 'mysql:') throw new Error(`Only mysql:// URLs are supported: ${url.protocol}`);
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')) || fallbackDatabase,
  };
}

function getConnectionConfigs(options) {
  const target = parseMysqlUrl(process.env.DATABASE_URL, options.targetDb);
  const source = parseMysqlUrl(process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL, options.sourceDb);
  target.database = options.targetDb;
  source.database = options.sourceDb;
  return { source, target };
}

function assertIdentifier(value, label) {
  if (!IDENTIFIER.test(value)) throw new Error(`Invalid ${label}: ${value}`);
  return value;
}

function normalize(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function monthAliases(month) {
  if (month === null) return [];
  const normalized = normalize(month);
  const names = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ];
  const numeric = Number(normalized);
  const index = names.findIndex((name, nameIndex) => (
    name === normalized || (Number.isInteger(numeric) && numeric === nameIndex + 1)
  ));
  if (index === -1) return [month];
  return [names[index], String(index + 1), String(index + 1).padStart(2, '0')];
}

function monthKey(value) {
  const normalized = normalize(value);
  const aliases = monthAliases(normalized);
  return aliases.length > 1 ? aliases[0] : normalized;
}

function monthNumber(value) {
  const aliases = monthAliases(value);
  if (aliases.length === 0) return null;
  const numeric = Number(aliases[1]);
  return Number.isInteger(numeric) ? numeric : null;
}

function isRatePeriodIncluded(row, options) {
  if (!options.fromDate) return true;
  const [fromYear, fromMonth] = options.fromDate.split('-').map(Number);
  const rowYear = Number(row.year);
  const rowMonth = monthNumber(row.month);
  if (!Number.isInteger(rowYear) || !Number.isInteger(rowMonth)) return false;
  return rowYear > fromYear || (rowYear === fromYear && rowMonth >= fromMonth);
}

function rateDayColumnsForUpdate(targetColumns, sourceRow, options) {
  let firstDay = 1;
  if (options.fromDate && Number(sourceRow.year) === Number(options.fromDate.slice(0, 4)) && monthNumber(sourceRow.month) === Number(options.fromDate.slice(5, 7))) {
    firstDay = Number(options.fromDate.slice(8, 10));
  }
  return PRICE_COLUMNS.filter((column) => {
    if (!targetColumns.has(column)) return false;
    if (!column.startsWith('day_')) return true;
    return Number(column.slice(4)) >= firstDay;
  });
}

function rateValuesForInsert(sourceRow, options) {
  const values = { ...sourceRow };
  if (options.fromDate && Number(sourceRow.year) === Number(options.fromDate.slice(0, 4)) && monthNumber(sourceRow.month) === Number(options.fromDate.slice(5, 7))) {
    const firstDay = Number(options.fromDate.slice(8, 10));
    for (let day = 1; day < firstDay; day += 1) values[`day_${day}`] = null;
  }
  return values;
}

function hotelCodeKey(value) {
  return normalize(value);
}

function hotelNameCityKey(hotel) {
  return `${normalize(hotel.hotel_name)}|${normalize(hotel.hotel_city)}`;
}

function countBy(rows, keyFn) {
  const counts = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function uniqueRowMap(rows, keyFn) {
  const counts = countBy(rows, keyFn);
  const result = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (key && counts.get(key) === 1) result.set(key, row);
  }
  return result;
}

function groupedRowsMap(rows, keyFn) {
  const result = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    const values = result.get(key) || [];
    values.push(row);
    result.set(key, values);
  }
  return result;
}

async function tableColumns(conn, table) {
  assertIdentifier(table, 'table');
  const [rows] = await conn.query(`SHOW COLUMNS FROM \`${table}\``);
  return new Set(rows.map((row) => row.Field));
}

function commonSourceColumns(row, targetColumns, excluded) {
  return Object.fromEntries(
    Object.entries(row).filter(([column, value]) => targetColumns.has(column) && !excluded.has(column) && value !== undefined),
  );
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (Buffer.isBuffer(value)) return `X'${value.toString('hex')}'`;
  if (value instanceof Date) return `'${value.toISOString().slice(0, 19).replace('T', ' ')}'`;
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function quoteColumn(column) {
  return `\`${assertIdentifier(column, 'column')}\``;
}

class SqlWriter {
  constructor(fileName) {
    this.fileName = path.resolve(fileName);
    this.lines = [
      '-- Generated by sync-hotel-rates-between-databases.js',
      '-- Review this file before importing into production.',
      'SET NAMES utf8mb4;',
      'SET FOREIGN_KEY_CHECKS=0;',
      'START TRANSACTION;',
    ];
  }

  update(table, values, whereColumn, whereValue) {
    const assignments = Object.entries(values)
      .map(([column, value]) => `${quoteColumn(column)}=${sqlLiteral(value)}`)
      .join(', ');
    this.lines.push(`UPDATE ${quoteColumn(table)} SET ${assignments} WHERE ${quoteColumn(whereColumn)}=${sqlLiteral(whereValue)};`);
  }

  insert(table, row) {
    const columns = Object.keys(row);
    const values = columns.map((column) => sqlLiteral(row[column]));
    this.lines.push(`INSERT INTO ${quoteColumn(table)} (${columns.map(quoteColumn).join(', ')}) VALUES (${values.join(', ')});`);
  }

  write() {
    this.lines.push('COMMIT;', 'SET FOREIGN_KEY_CHECKS=1;', '');
    fs.mkdirSync(path.dirname(this.fileName), { recursive: true });
    fs.writeFileSync(this.fileName, `${this.lines.join('\n')}\n`, 'utf8');
  }
}

async function insertCommon(conn, table, row) {
  const columns = Object.keys(row);
  if (columns.length === 0) throw new Error(`No insertable columns for ${table}`);
  const quoted = columns.map((column) => `\`${assertIdentifier(column, 'column')}\``).join(', ');
  const placeholders = columns.map(() => '?').join(', ');
  const [result] = await conn.query(
    `INSERT INTO \`${assertIdentifier(table, 'table')}\` (${quoted}) VALUES (${placeholders})`,
    columns.map((column) => row[column]),
  );
  return result.insertId;
}

async function loadReferenceData(sourceConn, targetConn, options) {
  const targetRoomTypeColumns = await tableColumns(targetConn, 'dvi_hotel_roomtype');
  const [sourceTypes] = await sourceConn.query('SELECT * FROM dvi_hotel_roomtype WHERE status=1 AND deleted=0 ORDER BY room_type_id');
  const [targetTypes] = await targetConn.query('SELECT * FROM dvi_hotel_roomtype WHERE status=1 AND deleted=0 ORDER BY room_type_id');
  const targetTypeByTitle = uniqueRowMap(targetTypes, (row) => normalize(row.room_type_title));
  const sourceTypeCounts = countBy(sourceTypes, (row) => normalize(row.room_type_title));
  const roomTypeMap = new Map();
  let createdRoomTypes = 0;
  let skippedRoomTypes = 0;

  for (const sourceType of sourceTypes) {
    const key = normalize(sourceType.room_type_title);
    let targetType = sourceTypeCounts.get(key) === 1 ? targetTypeByTitle.get(key) : null;
    if (!targetType && options.apply && options.createMissingRooms && key) {
      const row = commonSourceColumns(sourceType, targetRoomTypeColumns, new Set(['room_type_id', 'createdon', 'updatedon']));
      const id = await insertCommon(targetConn, 'dvi_hotel_roomtype', row);
      targetType = { ...sourceType, room_type_id: id };
      targetTypeByTitle.set(key, targetType);
      createdRoomTypes += 1;
    }
    if (targetType) roomTypeMap.set(Number(sourceType.room_type_id), Number(targetType.room_type_id));
    else skippedRoomTypes += 1;
  }

  const [sourceHotels] = await sourceConn.query('SELECT * FROM dvi_hotel WHERE status=1 AND deleted=0 ORDER BY hotel_id');
  const [targetHotels] = await targetConn.query('SELECT * FROM dvi_hotel WHERE status=1 AND deleted=0 ORDER BY hotel_id');
  const targetByCode = uniqueRowMap(targetHotels, (row) => hotelCodeKey(row.hotel_code));
  const targetByNameCity = uniqueRowMap(targetHotels, hotelNameCityKey);
  const targetCandidatesByCode = groupedRowsMap(targetHotels, (row) => hotelCodeKey(row.hotel_code));
  const targetCandidatesByNameCity = groupedRowsMap(targetHotels, hotelNameCityKey);
  const sourceCodeCounts = countBy(sourceHotels, (row) => hotelCodeKey(row.hotel_code));
  const hotelMap = new Map();
  const skippedHotels = [];
  const skippedHotelDetails = [];
  let createdHotels = 0;

  const hotelColumns = await tableColumns(targetConn, 'dvi_hotel');
  for (const sourceHotel of sourceHotels) {
    const code = hotelCodeKey(sourceHotel.hotel_code);
    let targetHotel = null;
    if (code && sourceCodeCounts.get(code) === 1 && targetByCode.has(code)) targetHotel = targetByCode.get(code);
    else {
      const nameCity = hotelNameCityKey(sourceHotel);
      if (targetByNameCity.has(nameCity)) targetHotel = targetByNameCity.get(nameCity);
    }

    if (!targetHotel && options.apply && options.createMissingHotels) {
      const row = commonSourceColumns(sourceHotel, hotelColumns, new Set(['hotel_id', 'createdon', 'updatedon']));
      const id = await insertCommon(targetConn, 'dvi_hotel', row);
      targetHotel = { ...sourceHotel, hotel_id: id };
      if (code) targetByCode.set(code, targetHotel);
      targetByNameCity.set(hotelNameCityKey(sourceHotel), targetHotel);
      createdHotels += 1;
    }

    if (targetHotel) hotelMap.set(Number(sourceHotel.hotel_id), Number(targetHotel.hotel_id));
    else {
      skippedHotels.push({ id: sourceHotel.hotel_id, name: sourceHotel.hotel_name, code: sourceHotel.hotel_code });
      const codeCandidates = code ? targetCandidatesByCode.get(code) || [] : [];
      const nameCityCandidates = targetCandidatesByNameCity.get(hotelNameCityKey(sourceHotel)) || [];
      const reason = codeCandidates.length > 1
        ? 'AMBIGUOUS_TARGET_HOTEL_CODE'
        : sourceCodeCounts.get(code) > 1
          ? 'DUPLICATE_SOURCE_HOTEL_CODE'
          : nameCityCandidates.length > 1
            ? 'AMBIGUOUS_TARGET_NAME_AND_CITY'
            : codeCandidates.length === 0 && nameCityCandidates.length === 0
              ? 'NO_TARGET_MATCH'
              : 'NO_UNIQUE_TARGET_MATCH';
      skippedHotelDetails.push({
        sourceHotelId: Number(sourceHotel.hotel_id),
        sourceHotelName: sourceHotel.hotel_name,
        sourceHotelCode: sourceHotel.hotel_code,
        sourceHotelCity: sourceHotel.hotel_city,
        sourceHotelState: sourceHotel.hotel_state,
        reason,
        targetCandidatesByCode: codeCandidates.map((candidate) => ({
          hotelId: Number(candidate.hotel_id),
          hotelName: candidate.hotel_name,
          hotelCode: candidate.hotel_code,
          hotelCity: candidate.hotel_city,
          hotelState: candidate.hotel_state,
        })),
        targetCandidatesByNameAndCity: nameCityCandidates.map((candidate) => ({
          hotelId: Number(candidate.hotel_id),
          hotelName: candidate.hotel_name,
          hotelCode: candidate.hotel_code,
          hotelCity: candidate.hotel_city,
          hotelState: candidate.hotel_state,
        })),
      });
    }
  }

  const [sourceRooms] = await sourceConn.query('SELECT * FROM dvi_hotel_rooms WHERE status=1 AND deleted=0 ORDER BY room_ID');
  const [targetRooms] = await targetConn.query('SELECT * FROM dvi_hotel_rooms WHERE status=1 AND deleted=0 ORDER BY room_ID');
  const targetRoomsByHotel = new Map();
  for (const room of targetRooms) {
    const hotelId = Number(room.hotel_id);
    if (!targetRoomsByHotel.has(hotelId)) targetRoomsByHotel.set(hotelId, []);
    targetRoomsByHotel.get(hotelId).push(room);
  }
  const roomColumns = await tableColumns(targetConn, 'dvi_hotel_rooms');
  const roomMap = new Map();
  const skippedRooms = [];
  let createdRooms = 0;

  for (const sourceRoom of sourceRooms) {
    const targetHotelId = hotelMap.get(Number(sourceRoom.hotel_id));
    const targetRoomTypeId = roomTypeMap.get(Number(sourceRoom.room_type_id));
    if (!targetHotelId || !targetRoomTypeId) {
      skippedRooms.push({ id: sourceRoom.room_ID, reason: 'hotel or room type was not mapped' });
      continue;
    }

    const candidates = targetRoomsByHotel.get(targetHotelId) || [];
    const ref = normalize(sourceRoom.room_ref_code);
    const refMatches = ref ? candidates.filter((room) => normalize(room.room_ref_code) === ref) : [];
    const titleMatches = candidates.filter(
      (room) => Number(room.room_type_id) === targetRoomTypeId && normalize(room.room_title) === normalize(sourceRoom.room_title),
    );
    let targetRoom = refMatches.length === 1 ? refMatches[0] : titleMatches.length === 1 ? titleMatches[0] : null;

    if (!targetRoom && options.apply && options.createMissingRooms) {
      const row = commonSourceColumns(
        { ...sourceRoom, hotel_id: targetHotelId, room_type_id: targetRoomTypeId },
        roomColumns,
        new Set(['room_ID', 'createdon', 'updatedon']),
      );
      const id = await insertCommon(targetConn, 'dvi_hotel_rooms', row);
      targetRoom = { ...sourceRoom, room_ID: id, hotel_id: targetHotelId, room_type_id: targetRoomTypeId };
      candidates.push(targetRoom);
      targetRoomsByHotel.set(targetHotelId, candidates);
      createdRooms += 1;
    }

    if (targetRoom) roomMap.set(String(sourceRoom.room_ID), Number(targetRoom.room_ID));
    else skippedRooms.push({ id: sourceRoom.room_ID, reason: 'room reference/title was ambiguous or missing' });
  }

  return { hotelMap, roomTypeMap, roomMap, skippedHotels, skippedHotelDetails, skippedRooms, skippedRoomTypes, createdHotels, createdRooms, createdRoomTypes };
}

function sourcePriceWhere(options) {
  const conditions = ['hotel_price_book_id > ?'];
  const params = [0];
  if (options.year !== null) {
    conditions.push('year = ?');
    params.push(options.year);
  }
  if (options.month !== null) {
    const aliases = monthAliases(options.month);
    conditions.push(`month IN (${aliases.map(() => '?').join(',')})`);
    params.push(...aliases);
  }
  return { conditions, params };
}

function priceKey(row) {
  return [
    Number(row.hotel_id),
    Number(row.room_type_id),
    row.room_id === null || row.room_id === undefined ? '' : String(row.room_id),
    Number(row.price_type),
    String(row.year),
    monthKey(row.month),
  ].join('|');
}

async function loadTargetPriceRows(targetConn, options, hotelMap) {
  const targetHotelIds = [...new Set([...hotelMap.values()])];
  if (targetHotelIds.length === 0) return new Map();
  const conditions = [`hotel_id IN (${targetHotelIds.map(() => '?').join(',')})`];
  const params = [...targetHotelIds];
  if (options.year !== null) {
    conditions.push('year = ?');
    params.push(options.year);
  }
  if (options.month !== null) {
    const aliases = monthAliases(options.month);
    conditions.push(`month IN (${aliases.map(() => '?').join(',')})`);
    params.push(...aliases);
  }
  const [rows] = await targetConn.query(`SELECT * FROM dvi_hotel_room_price_book WHERE ${conditions.join(' AND ')}`, params);
  const map = new Map();
  for (const row of rows) if (!map.has(priceKey(row))) map.set(priceKey(row), row);
  return map;
}

async function updatePriceRow(targetConn, targetId, sourceRow, targetHotelId, targetRoomTypeId, targetRoomId, targetColumns, options) {
  const values = { ...sourceRow, hotel_id: targetHotelId, room_type_id: targetRoomTypeId, room_id: targetRoomId };
  const columns = rateDayColumnsForUpdate(targetColumns, sourceRow, options).filter((column) => !['hotel_id', 'room_type_id', 'room_id'].includes(column));
  const assignments = columns.map((column) => `\`${column}\`=?`).join(', ');
  const params = columns.map((column) => values[column]);
  params.push(targetId);
  const updatedAt = targetColumns.has('updatedon') ? ', updatedon=NOW()' : '';
  await targetConn.query(`UPDATE dvi_hotel_room_price_book SET ${assignments}${updatedAt} WHERE hotel_price_book_id=?`, params);
}

async function insertPriceRow(targetConn, sourceRow, targetHotelId, targetRoomTypeId, targetRoomId, targetColumns, options) {
  const row = {};
  const values = rateValuesForInsert(sourceRow, options);
  for (const column of PRICE_COLUMNS) if (targetColumns.has(column)) row[column] = values[column];
  row.hotel_id = targetHotelId;
  row.room_type_id = targetRoomTypeId;
  row.room_id = targetRoomId;
  if (targetColumns.has('createdon')) row.createdon = new Date();
  if (targetColumns.has('updatedon')) row.updatedon = new Date();
  return insertCommon(targetConn, 'dvi_hotel_room_price_book', row);
}

async function syncPriceRows(sourceConn, targetConn, options, references, sqlWriter) {
  const targetPriceColumns = await tableColumns(targetConn, 'dvi_hotel_room_price_book');
  const targetRowsByKey = await loadTargetPriceRows(targetConn, options, references.hotelMap);
  const where = sourcePriceWhere(options);
  let lastId = 0;
  let processed = 0;
  let updated = 0;
  let inserted = 0;
  let skipped = 0;
  const skipExamples = [];

  while (true) {
    const remaining = options.maxRows === null ? options.batchSize : Math.min(options.batchSize, options.maxRows - processed);
    if (remaining <= 0) break;
    const query = `SELECT * FROM dvi_hotel_room_price_book WHERE ${where.conditions.join(' AND ')} ORDER BY hotel_price_book_id LIMIT ${remaining}`;
    const [rows] = await sourceConn.query(query, [lastId, ...where.params.slice(1)]);
    if (rows.length === 0) break;
    for (const sourceRow of rows) {
      lastId = Number(sourceRow.hotel_price_book_id);
      if (!isRatePeriodIncluded(sourceRow, options)) continue;
      processed += 1;
      const targetHotelId = references.hotelMap.get(Number(sourceRow.hotel_id));
      const targetRoomTypeId = references.roomTypeMap.get(Number(sourceRow.room_type_id));
      const targetRoomId = sourceRow.room_id === null || sourceRow.room_id === undefined ? null : references.roomMap.get(String(sourceRow.room_id));
      if (!targetHotelId || !targetRoomTypeId || (sourceRow.room_id !== null && sourceRow.room_id !== undefined && !targetRoomId)) {
        skipped += 1;
        if (skipExamples.length < 10) skipExamples.push({ id: sourceRow.hotel_price_book_id, hotelId: sourceRow.hotel_id, roomId: sourceRow.room_id, reason: !targetHotelId ? 'hotel not mapped' : !targetRoomTypeId ? 'room type not mapped' : 'room not mapped' });
        continue;
      }

      const targetKey = priceKey({ ...sourceRow, hotel_id: targetHotelId, room_type_id: targetRoomTypeId, room_id: targetRoomId });
      const existing = targetRowsByKey.get(targetKey);
      if (existing) {
        if (options.apply) await updatePriceRow(targetConn, existing.hotel_price_book_id, sourceRow, targetHotelId, targetRoomTypeId, targetRoomId, targetPriceColumns, options);
        else if (sqlWriter) {
          const values = { ...sourceRow, hotel_id: targetHotelId, room_type_id: targetRoomTypeId, room_id: targetRoomId };
          const updateValues = Object.fromEntries(rateDayColumnsForUpdate(targetPriceColumns, sourceRow, options).filter((column) => !['hotel_id', 'room_type_id', 'room_id'].includes(column)).map((column) => [column, values[column]]));
          if (targetPriceColumns.has('updatedon')) updateValues.updatedon = new Date();
          sqlWriter.update('dvi_hotel_room_price_book', updateValues, 'hotel_price_book_id', existing.hotel_price_book_id);
        }
        updated += 1;
      } else {
        const insertedId = options.apply
          ? await insertPriceRow(targetConn, sourceRow, targetHotelId, targetRoomTypeId, targetRoomId, targetPriceColumns, options)
          : `dry-run-${inserted + 1}`;
        if (sqlWriter) {
          const values = { ...sourceRow, hotel_id: targetHotelId, room_type_id: targetRoomTypeId, room_id: targetRoomId };
          const insertValues = Object.fromEntries(PRICE_COLUMNS.filter((column) => targetPriceColumns.has(column)).map((column) => [column, rateValuesForInsert(sourceRow, options)[column]]));
          if (targetPriceColumns.has('createdon')) insertValues.createdon = new Date();
          if (targetPriceColumns.has('updatedon')) insertValues.updatedon = new Date();
          sqlWriter.insert('dvi_hotel_room_price_book', insertValues);
        }
        inserted += 1;
        targetRowsByKey.set(targetKey, { hotel_price_book_id: insertedId });
      }
    }
    if (rows.length < remaining) break;
  }
  return { processed, updated, inserted, skipped, skipExamples };
}

function printSummary(options, references, prices) {
  console.log(`Mode: ${options.apply ? 'APPLY' : 'DRY RUN'}`);
  console.log(`Source: ${options.sourceDb} -> Target: ${options.targetDb}`);
  console.log(`Filter: year=${options.year || 'all'}, month=${options.month || 'all'}, batch=${options.batchSize}`);
  console.log(`Hotels mapped: ${references.hotelMap.size}; skipped: ${references.skippedHotels.length}; created: ${references.createdHotels}`);
  console.log(`Rooms mapped: ${references.roomMap.size}; skipped: ${references.skippedRooms.length}; created: ${references.createdRooms}`);
  console.log(`Room types skipped: ${references.skippedRoomTypes}; created: ${references.createdRoomTypes}`);
  console.log(`Rate rows processed: ${prices.processed}; would update/updated: ${prices.updated}; would insert/inserted: ${prices.inserted}; skipped: ${prices.skipped}`);
  if (references.skippedHotels.length) console.log('Hotel skip examples:', references.skippedHotels.slice(0, 10));
  if (prices.skipExamples.length) console.log('Rate skip examples:', prices.skipExamples);
}

async function run() {
  const options = parseArgs(process.argv);
  if (options.help) return printHelp();
  if (options.apply && options.confirm !== 'SYNC') throw new Error('Refusing to write. Use --apply --confirm=SYNC explicitly.');
  if (options.apply && options.sqlFile) throw new Error('Use either --apply or --sql-file, not both.');
  if (options.sqlFile && (options.createMissingHotels || options.createMissingRooms)) {
    throw new Error('--sql-file currently exports mapped rate rows only; do not combine it with missing-record creation.');
  }
  const configs = getConnectionConfigs(options);
  const sourceConn = await mysql.createConnection(configs.source);
  const targetConn = await mysql.createConnection(configs.target);
  let transactionStarted = false;

  try {
    console.log(`Preparing direct sync: ${options.sourceDb} -> ${options.targetDb}`);
    if (options.apply) {
      await targetConn.beginTransaction();
      transactionStarted = true;
    }
    const references = await loadReferenceData(sourceConn, targetConn, options);
    if (!references.roomTypeMap.size) throw new Error('No room-type mappings were found. Refusing to sync rate rows.');
    const sqlWriter = options.sqlFile ? new SqlWriter(options.sqlFile) : null;
    const prices = await syncPriceRows(sourceConn, targetConn, options, references, sqlWriter);
    if (transactionStarted) await targetConn.commit();
    if (sqlWriter) {
      sqlWriter.write();
      console.log(`SQL export written: ${sqlWriter.fileName}`);
    }
    if (options.mappingReport) {
      const reportFile = path.resolve(options.mappingReport);
      fs.mkdirSync(path.dirname(reportFile), { recursive: true });
      fs.writeFileSync(reportFile, JSON.stringify({
        generatedAt: new Date().toISOString(),
        sourceDb: options.sourceDb,
        targetDb: options.targetDb,
        fromDate: options.fromDate,
        skippedHotels: references.skippedHotelDetails,
        skippedRooms: references.skippedRooms,
        summary: {
          skippedHotelCount: references.skippedHotelDetails.length,
          skippedRoomCount: references.skippedRooms.length,
          processedRateRows: prices.processed,
          skippedRateRows: prices.skipped,
        },
      }, null, 2), 'utf8');
      console.log(`Mapping report written: ${reportFile}`);
    }
    printSummary(options, references, prices);
  } catch (error) {
    if (transactionStarted) await targetConn.rollback();
    throw error;
  } finally {
    await sourceConn.end();
    await targetConn.end();
  }
}

run().catch((error) => {
  console.error(`Sync failed: ${error.message}`);
  process.exitCode = 1;
});
