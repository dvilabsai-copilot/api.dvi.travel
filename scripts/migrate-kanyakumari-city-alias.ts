import 'dotenv/config';
import mysql, { RowDataPacket, ResultSetHeader } from 'mysql2/promise';

/**
 * Canonicalises the duplicate Kanyakumari city identity.
 *
 * Safe usage:
 *   npm run migrate:kanyakumari-city
 *   npm run migrate:kanyakumari-city -- --expected-db=dvi_main
 *   npm run migrate:kanyakumari-city -- --apply --expected-db=dvi_main
 *
 * The default mode is read-only. `--apply` is required for writes.
 * `--include-route-text` additionally normalises display text in
 * dvi_itinerary_route_details; it does not change route IDs or relationships.
 */

const SOURCE_CITY_ID = 70950;
const TARGET_CITY_ID = 3796;
const SOURCE_CITY_NAME = 'Kanniyakumari';
const TARGET_CITY_NAME = 'Kanyakumari';
const SOURCE_TBO_CODE = '122256';
const TARGET_TBO_CODE = '123084';

type CityRow = RowDataPacket & {
  id: number;
  name: string;
  state_id: number;
  status: number;
  deleted: number;
  tbo_city_code: string | null;
};

type CountRow = RowDataPacket & { count: number | string };

type MigrationOptions = {
  apply: boolean;
  includeRouteText: boolean;
  expectedDatabase: string | null;
};

type BackupTables = {
  cities: string | null;
  storedLocations: string | null;
  routes: string | null;
};

function parseOptions(argv: string[]): MigrationOptions {
  const expectedArg = argv.find((arg) => arg.startsWith('--expected-db='));

  return {
    apply: argv.includes('--apply'),
    includeRouteText: argv.includes('--include-route-text'),
    expectedDatabase: expectedArg ? expectedArg.slice('--expected-db='.length).trim() || null : null,
  };
}

function identifier(value: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(value)) {
    throw new Error(`Unsafe SQL identifier: ${value}`);
  }
  return `\`${value}\``;
}

function countValue(row: CountRow | undefined): number {
  return Number(row?.count ?? 0);
}

function timestampToken(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
  ].join('');
}

async function tableExists(db: mysql.Connection, tableName: string): Promise<boolean> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS count
     FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ?`,
    [tableName],
  );
  return countValue(rows[0] as CountRow | undefined) > 0;
}

async function loadCities(db: mysql.Connection): Promise<CityRow[]> {
  const [rows] = await db.query<CityRow[]>(
    `SELECT id, name, state_id, status, deleted, tbo_city_code
     FROM dvi_cities
     WHERE id IN (?, ?)
     ORDER BY id`,
    [SOURCE_CITY_ID, TARGET_CITY_ID],
  );
  return rows;
}

async function loadCounts(db: mysql.Connection, includeRouteText: boolean) {
  const [[destinationSourceRefs], [sourceRefs], [sourceText], [destinationText], [routeText]] = await Promise.all([
    db.query<CountRow[]>(
      `SELECT COUNT(*) AS count
       FROM dvi_stored_locations
       WHERE destination_city_id = ?`,
      [SOURCE_CITY_ID],
    ),
    db.query<CountRow[]>(
      `SELECT COUNT(*) AS count
       FROM dvi_stored_locations
       WHERE source_city_id = ?`,
      [SOURCE_CITY_ID],
    ),
    db.query<CountRow[]>(
      `SELECT COUNT(*) AS count
       FROM dvi_stored_locations
       WHERE LOWER(TRIM(source_location_city)) = LOWER(?)`,
      [SOURCE_CITY_NAME],
    ),
    db.query<CountRow[]>(
      `SELECT COUNT(*) AS count
       FROM dvi_stored_locations
       WHERE LOWER(TRIM(destination_location_city)) = LOWER(?)`,
      [SOURCE_CITY_NAME],
    ),
    includeRouteText
      ? db.query<CountRow[]>(
        `SELECT COUNT(*) AS count
         FROM dvi_itinerary_route_details
         WHERE LOWER(location_name) LIKE LOWER(?)
            OR LOWER(next_visiting_location) LIKE LOWER(?)`,
        [`%${SOURCE_CITY_NAME}%`, `%${SOURCE_CITY_NAME}%`],
      )
      : Promise.resolve([[{ count: 0 } as CountRow], []] as any),
  ]);

  return {
    destinationCityIdRefs: countValue(destinationSourceRefs[0]),
    sourceCityIdRefs: countValue(sourceRefs[0]),
    sourceCityTextRefs: countValue(sourceText[0]),
    destinationCityTextRefs: countValue(destinationText[0]),
    routeDisplayTextRefs: countValue(routeText[0]),
  };
}

async function createBackups(
  db: mysql.Connection,
  includeRouteText: boolean,
): Promise<BackupTables> {
  const token = timestampToken();
  const backupTables: BackupTables = {
    cities: `dvi_kanyakumari_cities_backup_${token}`,
    storedLocations: `dvi_kanyakumari_stored_locations_backup_${token}`,
    routes: includeRouteText ? `dvi_kanyakumari_routes_backup_${token}` : null,
  };

  for (const table of Object.values(backupTables)) {
    if (table && await tableExists(db, table)) {
      throw new Error(`Backup table already exists: ${table}`);
    }
  }

  await db.query(
    `CREATE TABLE ${identifier(backupTables.cities!)} AS
     SELECT * FROM dvi_cities WHERE id IN (?, ?)`,
    [SOURCE_CITY_ID, TARGET_CITY_ID],
  );
  await db.query(
    `CREATE TABLE ${identifier(backupTables.storedLocations!)} AS
     SELECT *
     FROM dvi_stored_locations
     WHERE source_city_id = ?
        OR destination_city_id = ?
        OR LOWER(TRIM(source_location_city)) = LOWER(?)
        OR LOWER(TRIM(destination_location_city)) = LOWER(?)`,
    [SOURCE_CITY_ID, SOURCE_CITY_ID, SOURCE_CITY_NAME, SOURCE_CITY_NAME],
  );

  if (backupTables.routes) {
    await db.query(
      `CREATE TABLE ${identifier(backupTables.routes)} AS
       SELECT *
       FROM dvi_itinerary_route_details
       WHERE LOWER(location_name) LIKE LOWER(?)
          OR LOWER(next_visiting_location) LIKE LOWER(?)`,
      [`%${SOURCE_CITY_NAME}%`, `%${SOURCE_CITY_NAME}%`],
    );
  }

  return backupTables;
}

async function validatePreconditions(db: mysql.Connection): Promise<CityRow[]> {
  const cities = await loadCities(db);
  if (cities.length !== 2) {
    throw new Error(
      `Expected both city rows ${SOURCE_CITY_ID} and ${TARGET_CITY_ID}; found ${cities.length}. No changes made.`,
    );
  }

  const source = cities.find((city) => city.id === SOURCE_CITY_ID)!;
  const target = cities.find((city) => city.id === TARGET_CITY_ID)!;

  if (
    source.name.trim().toLowerCase() !== SOURCE_CITY_NAME.toLowerCase()
    || source.tbo_city_code !== SOURCE_TBO_CODE
  ) {
    throw new Error(
      `Source city ${SOURCE_CITY_ID} does not match the expected ${SOURCE_CITY_NAME}/${SOURCE_TBO_CODE} identity. No changes made.`,
    );
  }
  if (
    target.name.trim().toLowerCase() !== TARGET_CITY_NAME.toLowerCase()
    || target.tbo_city_code !== TARGET_TBO_CODE
  ) {
    throw new Error(
      `Target city ${TARGET_CITY_ID} does not match the expected ${TARGET_CITY_NAME}/${TARGET_TBO_CODE} identity. No changes made.`,
    );
  }

  return cities;
}

async function applyMigration(
  db: mysql.Connection,
  includeRouteText: boolean,
): Promise<void> {
  await db.beginTransaction();
  try {
    await db.query(
      `UPDATE dvi_cities
       SET status = 1, deleted = 0
       WHERE id = ?`,
      [TARGET_CITY_ID],
    );

    await db.query(
      `UPDATE dvi_stored_locations
       SET source_city_id = ?
       WHERE source_city_id = ?`,
      [TARGET_CITY_ID, SOURCE_CITY_ID],
    );
    await db.query(
      `UPDATE dvi_stored_locations
       SET destination_city_id = ?
       WHERE destination_city_id = ?`,
      [TARGET_CITY_ID, SOURCE_CITY_ID],
    );
    await db.query(
      `UPDATE dvi_stored_locations
       SET source_location_city = ?
       WHERE LOWER(TRIM(source_location_city)) = LOWER(?)`,
      [TARGET_CITY_NAME, SOURCE_CITY_NAME],
    );
    await db.query(
      `UPDATE dvi_stored_locations
       SET destination_location_city = ?
       WHERE LOWER(TRIM(destination_location_city)) = LOWER(?)`,
      [TARGET_CITY_NAME, SOURCE_CITY_NAME],
    );

    if (includeRouteText) {
      await db.query(
        `UPDATE dvi_itinerary_route_details
         SET location_name = REPLACE(location_name, ?, ?),
             next_visiting_location = REPLACE(next_visiting_location, ?, ?)
         WHERE LOWER(location_name) LIKE LOWER(?)
            OR LOWER(next_visiting_location) LIKE LOWER(?)`,
        [SOURCE_CITY_NAME, TARGET_CITY_NAME, SOURCE_CITY_NAME, TARGET_CITY_NAME, `%${SOURCE_CITY_NAME}%`, `%${SOURCE_CITY_NAME}%`],
      );
    }

    await db.query(
      `UPDATE dvi_cities
       SET status = 0, deleted = 1
       WHERE id = ?`,
      [SOURCE_CITY_ID],
    );

    const after = await loadCounts(db, includeRouteText);
    if (
      after.destinationCityIdRefs !== 0
      || after.sourceCityIdRefs !== 0
      || after.sourceCityTextRefs !== 0
      || after.destinationCityTextRefs !== 0
      || (includeRouteText && after.routeDisplayTextRefs !== 0)
    ) {
      throw new Error(`Post-update validation failed: ${JSON.stringify(after)}`);
    }

    await db.commit();
  } catch (error) {
    await db.rollback();
    throw error;
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');

  const db = await mysql.createConnection(databaseUrl);
  let backupTables: BackupTables = { cities: null, storedLocations: null, routes: null };

  try {
    const [[databaseRow]] = await db.query<RowDataPacket[]>('SELECT DATABASE() AS database_name');
    const databaseName = String(databaseRow?.database_name ?? '');
    if (!databaseName) throw new Error('Could not resolve the active database.');
    if (options.expectedDatabase && databaseName !== options.expectedDatabase) {
      throw new Error(`Expected database ${options.expectedDatabase}, but connected to ${databaseName}. No changes made.`);
    }

    await validatePreconditions(db);
    const before = await loadCounts(db, options.includeRouteText);

    if (options.apply) {
      backupTables = await createBackups(db, options.includeRouteText);
      await applyMigration(db, options.includeRouteText);
    }

    const citiesAfter = await loadCities(db);
    const after = await loadCounts(db, options.includeRouteText);

    console.log(JSON.stringify({
      mode: options.apply ? 'APPLIED' : 'DRY_RUN',
      database: databaseName,
      includeRouteText: options.includeRouteText,
      source: {
        id: SOURCE_CITY_ID,
        name: SOURCE_CITY_NAME,
        tboCityCode: SOURCE_TBO_CODE,
        action: options.apply ? 'soft-retired' : 'would be soft-retired',
      },
      target: {
        id: TARGET_CITY_ID,
        name: TARGET_CITY_NAME,
        tboCityCode: TARGET_TBO_CODE,
        action: options.apply ? 'activated and made canonical' : 'would be activated and made canonical',
      },
      before,
      after,
      citiesAfter,
      backupTables,
      note: 'No tbo_hotel_master, dvi_hotel, itinerary route IDs, or plan relationships were changed.',
    }, null, 2));
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error('[migrate-kanyakumari-city-alias] Failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

