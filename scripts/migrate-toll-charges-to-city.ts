import 'dotenv/config';
import mysql, { ResultSetHeader, RowDataPacket } from 'mysql2/promise';

type RawRouteRow = RowDataPacket & {
  vehicle_toll_charge_ID: number;
  location_id: number | string | null;
  vehicle_type_id: number;
  toll_charge: number | string | null;
  status: number;
  deleted: number;
  source_location: string | null;
  destination_location: string | null;
};

type AliasRow = {
  aliasName: string;
  aliasKey: string;
  canonicalCity: string;
};

type MigrationOptions = {
  apply: boolean;
  allowConflicts: boolean;
  expectedDatabase: string | null;
};

function parseOptions(argv: string[]): MigrationOptions {
  const expectedArg = argv.find((arg) => arg.startsWith('--expected-db='));
  return {
    apply: argv.includes('--apply'),
    allowConflicts: argv.includes('--allow-conflicts'),
    expectedDatabase: expectedArg ? expectedArg.slice('--expected-db='.length).trim() || null : null,
  };
}

function aliasKey(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-IN')
    .replace(/\s+/g, ' ');
}

function compactKey(value: string): string {
  return aliasKey(value).replace(/[.,()&'\-_/]/g, '').replace(/\s+/g, '');
}

function normalizeTollCity(value: string): string {
  const decoded = value
    .replace(/&#039;|&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .trim();
  const compact = compactKey(decoded);

  const explicit: Record<string, string> = {
    trichy: 'Trichy',
    trichyairporttrz: 'Trichy',
    trichychatrambusstand: 'Trichy',
    trichyjunction: 'Trichy',
    tiruchirappalli: 'Trichy',
    trivandrum: 'Trivandrum',
    trivandrumdomesticairport: 'Trivandrum',
    trivandrumcentralrailwaystation: 'Trivandrum',
    trivandrumrailwaystation: 'Trivandrum',
    thiruvananthapuram: 'Trivandrum',
    kanyakumari: 'Kanyakumari',
    kanyakumarirailwaystation: 'Kanyakumari',
    kanniyakumari: 'Kanyakumari',
    bengaluru: 'Bangalore',
    bangalore: 'Bangalore',
    bangaloreinternationalairport: 'Bangalore',
    bangalorekrpuram: 'Bangalore',
    bangalorekadugodi: 'Bangalore',
    bangaloreksrrailwaystation: 'Bangalore',
    bangaloremajestic: 'Bangalore',
    madurai: 'Madurai',
    maduraiairport: 'Madurai',
    maduraimattuthavani: 'Madurai',
    madurairailwaystation: 'Madurai',
    maduraibusstandarappalayam: 'Madurai',
  };
  if (explicit[compact]) return explicit[compact];

  const special: Array<[RegExp, string]> = [
    [/^ecr beach, chennai/i, 'Chennai'],
    [/^railway station road, palayam, kozhikode/i, 'Calicut'],
    [/^goa international airport/i, 'Goa'],
    [/^katpadi, railway station, vellore/i, 'Vellore'],
    [/^swamimalai, kumbakonam/i, 'Kumbakonam'],
    [/^jatayu earth/i, 'Jatayu Earth Center'],
    [/^isha yoga centre coimbatore/i, 'Coimbatore'],
    [/^chennai (koyembedu|egmore station)$/i, 'Chennai'],
    [/^ernakulam railway station kerala$/i, 'Ernakulam'],
    [/^tirupathi$/i, 'Tirupati'],
    [/^tirupati bus stop/i, 'Tirupati'],
    [/^murdeshwar/i, 'Murudeshwar'],
    [/^thiruchendur/i, 'Tiruchendur'],
  ];
  for (const [pattern, city] of special) {
    if (pattern.test(decoded)) return city;
  }

  let base = decoded.split(',')[0]?.trim() || decoded;
  base = base
    .replace(/\s+(international|domestic)\s+airport(?:\s*\([^)]*\))?$/i, '')
    .replace(/\s+airport(?:\s*\([^)]*\))?$/i, '')
    .replace(/\s+central\s+railway\s+station$/i, '')
    .replace(/\s+(railway station|railway station|bus stand|bus stop)$/i, '')
    .replace(/\s+(central|junction|port|town)$/i, '')
    .trim();

  if (/^bengaluru$/i.test(base)) return 'Bangalore';
  if (/^tirupathi$/i.test(base)) return 'Tirupati';
  if (/^pondicherry$/i.test(base)) return 'Pondicherry';
  return base;
}

function toAlias(value: string): AliasRow {
  const aliasName = value.trim();
  return {
    aliasName,
    aliasKey: aliasKey(aliasName),
    canonicalCity: normalizeTollCity(aliasName),
  };
}

function addAlias(aliases: Map<string, AliasRow>, value: string): void {
  const alias = toAlias(value);
  if (!alias.aliasKey || !alias.canonicalCity) return;
  aliases.set(alias.aliasKey, alias);

  // Also store a punctuation-insensitive key so labels such as
  // "Kanyakumari, Railway Station" and "Kanyakumari Railway Station"
  // resolve to the same canonical city.
  const compactAliasKey = compactKey(value);
  if (compactAliasKey && compactAliasKey !== alias.aliasKey) {
    aliases.set(compactAliasKey, { ...alias, aliasKey: compactAliasKey });
  }
}

function routeKey(source: string, destination: string, vehicleTypeId: number): string {
  return `${source}\u0000${destination}\u0000${vehicleTypeId}`;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');

  const db = await mysql.createConnection(databaseUrl);
  try {
    const [[databaseRow]] = await db.query<RowDataPacket[]>('SELECT DATABASE() AS database_name');
    const databaseName = String(databaseRow?.database_name ?? '');
    if (!databaseName) throw new Error('Could not resolve the active database.');
    if (options.expectedDatabase && databaseName !== options.expectedDatabase) {
      throw new Error(`Expected database ${options.expectedDatabase}, but connected to ${databaseName}.`);
    }

    const [rows] = await db.query<RawRouteRow[]>(
      `SELECT t.vehicle_toll_charge_ID, t.location_id, t.vehicle_type_id,
              t.toll_charge, t.status, t.deleted,
              l.source_location, l.destination_location
       FROM dvi_vehicle_toll_charges t
       LEFT JOIN dvi_stored_locations l ON l.location_ID = t.location_id
       WHERE t.source_city IS NULL OR t.destination_city IS NULL
       ORDER BY t.vehicle_toll_charge_ID ASC`,
    );

    const [storedLocationAliases] = await db.query<RowDataPacket[]>(
      `SELECT DISTINCT l.source_location AS value
       FROM dvi_stored_locations l
       INNER JOIN dvi_vehicle_toll_charges t ON t.location_id = l.location_ID
       WHERE l.source_location IS NOT NULL AND TRIM(l.source_location) <> ''
       UNION
       SELECT DISTINCT l.destination_location AS value
       FROM dvi_stored_locations l
       INNER JOIN dvi_vehicle_toll_charges t ON t.location_id = l.location_ID
       WHERE l.destination_location IS NOT NULL AND TRIM(l.destination_location) <> ''`,
    );

    const aliases = new Map<string, AliasRow>();
    const routeByLocation = new Map<string, { source: string; destination: string }>();
    const unresolvedRows: number[] = [];

    for (const row of storedLocationAliases) {
      addAlias(aliases, String(row.value ?? '').trim());
    }

    for (const row of rows) {
      if (row.location_id === null || row.location_id === undefined) {
        unresolvedRows.push(Number(row.vehicle_toll_charge_ID));
        continue;
      }
      const sourceRaw = String(row.source_location ?? '').trim();
      const destinationRaw = String(row.destination_location ?? '').trim();
      if (!sourceRaw || !destinationRaw) {
        unresolvedRows.push(Number(row.vehicle_toll_charge_ID));
        continue;
      }
      const sourceAlias = toAlias(sourceRaw);
      const destinationAlias = toAlias(destinationRaw);
      addAlias(aliases, sourceRaw);
      addAlias(aliases, destinationRaw);
      const source = sourceAlias.canonicalCity;
      const destination = destinationAlias.canonicalCity;
      if (!source || !destination) {
        unresolvedRows.push(Number(row.vehicle_toll_charge_ID));
        continue;
      }
      // Always make canonical values valid aliases too, even when the raw
      // stored-location label only appeared in a variant form.
      addAlias(aliases, source);
      addAlias(aliases, destination);
      routeByLocation.set(String(row.location_id), { source, destination });
    }

    const groups = new Map<string, RawRouteRow[]>();
    for (const row of rows) {
      const route = routeByLocation.get(String(row.location_id));
      if (!route) continue;
      const key = routeKey(route.source, route.destination, Number(row.vehicle_type_id));
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }

    const conflicts = Array.from(groups.entries()).flatMap(([key, group]) => {
      const activeGroup = group.filter((row) => Number(row.deleted) === 0);
      const amounts = new Set(activeGroup.map((row) => String(row.toll_charge ?? '')));
      return amounts.size > 1 ? [{ key, rowIds: activeGroup.map((row) => Number(row.vehicle_toll_charge_ID)), amounts: Array.from(amounts) }] : [];
    });
    if (conflicts.length && !options.allowConflicts) {
      throw new Error(
        `${conflicts.length} canonical route/vehicle groups have conflicting toll amounts. ` +
        `Review them or rerun with --allow-conflicts to keep the newest row.`,
      );
    }

    const duplicateRows = Array.from(groups.values()).flatMap((group) => {
      const activeGroup = group.filter((row) => Number(row.deleted) === 0);
      if (activeGroup.length < 2) return [];
      const sorted = [...activeGroup].sort((a, b) => Number(b.vehicle_toll_charge_ID) - Number(a.vehicle_toll_charge_ID));
      return sorted.slice(1).map((row) => Number(row.vehicle_toll_charge_ID));
    });

    console.log(JSON.stringify({
      mode: options.apply ? 'APPLY' : 'DRY_RUN',
      database: databaseName,
      rowsToBackfill: rows.length,
      aliasesToInsert: aliases.size,
      canonicalRouteVehicleGroups: groups.size,
      duplicateRowsToRemove: duplicateRows.length,
      unresolvedRows: unresolvedRows.length,
      unresolvedRowSample: unresolvedRows.slice(0, 20),
      conflicts: conflicts.slice(0, 20),
      note: 'dvi_stored_locations is read only for backfill and is not modified. Unresolved orphan rows are preserved with null city fields.',
    }, null, 2));

    if (!options.apply) return;

    await db.beginTransaction();
    try {
      for (const alias of aliases.values()) {
        await db.query<ResultSetHeader>(
          `INSERT INTO dvi_toll_city_aliases
             (alias_name, alias_key, canonical_city, status, deleted)
           VALUES (?, ?, ?, 1, 0)
           ON DUPLICATE KEY UPDATE
             alias_name = VALUES(alias_name),
             canonical_city = VALUES(canonical_city),
             status = 1,
             deleted = 0`,
          [alias.aliasName, alias.aliasKey, alias.canonicalCity],
        );
      }

      for (const [locationId, route] of routeByLocation.entries()) {
        await db.query<ResultSetHeader>(
          `UPDATE dvi_vehicle_toll_charges
           SET source_city = ?, destination_city = ?, location_id = NULL
           WHERE location_id = ? AND (source_city IS NULL OR destination_city IS NULL)`,
          [route.source, route.destination, locationId],
        );
      }

      if (duplicateRows.length) {
        const placeholders = duplicateRows.map(() => '?').join(', ');
        await db.query<ResultSetHeader>(
          `DELETE FROM dvi_vehicle_toll_charges
           WHERE vehicle_toll_charge_ID IN (${placeholders})
             AND deleted = 0`,
          duplicateRows,
        );
      }

      await db.commit();
    } catch (error) {
      await db.rollback();
      throw error;
    }
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error('[migrate-toll-charges-to-city] Failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
