import { execFileSync } from 'node:child_process';
import { config as loadDotenv } from 'dotenv';
import mysql, { RowDataPacket } from 'mysql2/promise';
import {
  isBcryptPasswordHash,
  isLegacyPhpPasswordHash,
} from '../src/common/utils/password-migration.util';

const SOURCE_DATABASE = 'dvi_travels';
const ALLOWED_TARGET_DATABASES = new Set(['dvi_staging', 'dvi_main']);

const USER_COLUMNS = [
  'userID',
  'guide_id',
  'vendor_id',
  'staff_id',
  'agent_id',
  'user_profile',
  'username',
  'useremail',
  'password',
  'roleID',
  'userapproved',
  'userbanned',
  'createdby',
  'createdon',
  'updatedon',
  'status',
  'deleted',
] as const;

type UserColumn = (typeof USER_COLUMNS)[number];

type UserRow = RowDataPacket & {
  userID: string;
  guide_id: number;
  vendor_id: string;
  staff_id: number;
  agent_id: number;
  user_profile: string | null;
  username: string | null;
  useremail: string | null;
  password: string | null;
  roleID: number;
  userapproved: number;
  userbanned: number;
  createdby: string;
  createdon: string | null;
  updatedon: string;
  status: number;
  deleted: number;
};

export type PasswordFormat = 'bcrypt' | 'legacy_php' | 'empty' | 'unknown';

export function normalizeEmail(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

export function passwordFormat(value: unknown): PasswordFormat {
  const password = String(value ?? '');
  if (!password) return 'empty';
  if (isBcryptPasswordHash(password)) return 'bcrypt';
  if (isLegacyPhpPasswordHash(password)) return 'legacy_php';
  return 'unknown';
}

export type MigrationArgs = {
  apply: boolean;
  targetDatabase: string;
  legacyPhpConfig: string;
  envFile: string;
  replaceMatchedPasswords: boolean;
  skipDuplicateSourceEmails: boolean;
  allowUnusablePasswords: boolean;
  help: boolean;
};

export function parseArgs(argv: string[]): MigrationArgs {
  const args: MigrationArgs = {
    apply: false,
    targetDatabase: '',
    legacyPhpConfig: '',
    envFile: '',
    replaceMatchedPasswords: false,
    skipDuplicateSourceEmails: false,
    allowUnusablePasswords: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      args.apply = true;
    } else if (arg === '--replace-matched-passwords') {
      args.replaceMatchedPasswords = true;
    } else if (arg === '--skip-duplicate-source-emails') {
      args.skipDuplicateSourceEmails = true;
    } else if (arg === '--allow-unusable-passwords') {
      args.allowUnusablePasswords = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--target-db' || arg === '--target') {
      args.targetDatabase = String(argv[++index] || '').trim();
    } else if (arg === '--legacy-php-config') {
      args.legacyPhpConfig = String(argv[++index] || '').trim();
    } else if (arg.startsWith('--legacy-php-config=')) {
      args.legacyPhpConfig = arg.slice('--legacy-php-config='.length).trim();
    } else if (arg === '--env-file') {
      args.envFile = String(argv[++index] || '').trim();
    } else if (arg.startsWith('--env-file=')) {
      args.envFile = arg.slice('--env-file='.length).trim();
    } else if (arg.startsWith('--target-db=')) {
      args.targetDatabase = arg.slice('--target-db='.length).trim();
    } else if (arg.startsWith('--target=')) {
      args.targetDatabase = arg.slice('--target='.length).trim();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    throw new Error(`Unsafe database identifier: ${value}`);
  }
  return `\`${value}\``;
}

function databaseConfig(rawUrl: string | undefined, label: string) {
  if (!rawUrl) throw new Error(`${label} is required`);

  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'mysql:') {
    throw new Error(`${label} must use the mysql:// protocol`);
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!database) throw new Error(`${label} must include a database name`);

  return {
    host: parsed.hostname,
    port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
  };
}

function databaseUrlFromPhpConfig(configPath: string): string {
  const php = `
    $path = $argv[1] ?? '';
    if (!$path || !is_readable($path)) { fwrite(STDERR, "PHP database config is not readable\\n"); exit(2); }
    require $path;
    $required = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
    foreach ($required as $name) {
      if (!defined($name)) { fwrite(STDERR, "Missing PHP database constant: {$name}\\n"); exit(3); }
    }
    echo json_encode([
      'host' => DB_HOST,
      'database' => DB_NAME,
      'user' => DB_USER,
      'password' => DB_PASSWORD,
    ], JSON_THROW_ON_ERROR);
  `;
  const output = execFileSync('php', ['-r', php, configPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const config = JSON.parse(output) as {
    host: string;
    database: string;
    user: string;
    password: string;
  };
  return `mysql://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@${config.host}:3306/${encodeURIComponent(config.database)}`;
}

function databaseUrlForTarget(targetDatabase: string): string | undefined {
  const explicit = process.env.TARGET_DATABASE_URL;
  if (explicit) return explicit;

  const configured = process.env.DATABASE_URL;
  if (!configured) return undefined;

  const parsed = new URL(configured);
  parsed.pathname = `/${targetDatabase}`;
  return parsed.toString();
}

async function tableExists(connection: mysql.Connection, database: string): Promise<boolean> {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS table_count
       FROM information_schema.tables
      WHERE table_schema = ? AND table_name = 'dvi_users'`,
    [database],
  );
  return Number(rows[0]?.table_count || 0) === 1;
}

async function assertColumns(
  connection: mysql.Connection,
  database: string,
  label: string,
): Promise<void> {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT column_name AS column_name
       FROM information_schema.columns
      WHERE table_schema = ? AND table_name = 'dvi_users'`,
    [database],
  );
  const available = new Set(rows.map((row) => String(row.column_name)));
  const missing = USER_COLUMNS.filter((column) => !available.has(column));
  if (missing.length) {
    throw new Error(`${label} dvi_users is missing columns: ${missing.join(', ')}`);
  }
}

async function loadUsers(connection: mysql.Connection, database: string): Promise<UserRow[]> {
  const table = `${quoteIdentifier(database)}.${quoteIdentifier('dvi_users')}`;
  const [rows] = await connection.query<UserRow[]>(`
    SELECT
      CAST(userID AS CHAR) AS userID,
      COALESCE(guide_id, 0) AS guide_id,
      COALESCE(vendor_id, 0) AS vendor_id,
      COALESCE(staff_id, 0) AS staff_id,
      COALESCE(agent_id, 0) AS agent_id,
      user_profile,
      username,
      useremail,
      password,
      COALESCE(roleID, 0) AS roleID,
      COALESCE(userapproved, 0) AS userapproved,
      COALESCE(userbanned, 0) AS userbanned,
      COALESCE(createdby, 0) AS createdby,
      createdon,
      COALESCE(updatedon, createdon, NOW()) AS updatedon,
      COALESCE(status, 0) AS status,
      COALESCE(deleted, 0) AS deleted
    FROM ${table}
    ORDER BY userID
  `);
  return rows;
}

function duplicateEmails(rows: UserRow[]): Map<string, UserRow[]> {
  const grouped = new Map<string, UserRow[]>();
  for (const row of rows) {
    const email = normalizeEmail(row.useremail);
    if (!email) continue;
    grouped.set(email, [...(grouped.get(email) || []), row]);
  }
  return new Map([...grouped].filter(([, values]) => values.length > 1));
}

function emailMap(rows: UserRow[]): Map<string, UserRow> {
  const result = new Map<string, UserRow>();
  for (const row of rows) {
    const email = normalizeEmail(row.useremail);
    if (email) result.set(email, row);
  }
  return result;
}

function passwordFormatCounts(rows: UserRow[]): Record<PasswordFormat, number> {
  return rows.reduce<Record<PasswordFormat, number>>((counts, row) => {
    const format = passwordFormat(row.password);
    counts[format] += 1;
    return counts;
  }, { bcrypt: 0, legacy_php: 0, empty: 0, unknown: 0 });
}

function describeRows(rows: UserRow[]) {
  const sourceDuplicateEmails = duplicateEmails(rows);
  return {
    rows: rows.length,
    activeRows: rows.filter((row) => row.status === 1 && row.deleted === 0 && row.userbanned === 0).length,
    missingEmails: rows.filter((row) => !normalizeEmail(row.useremail)).length,
    passwordFormats: passwordFormatCounts(rows),
    duplicateEmailCount: sourceDuplicateEmails.size,
    inactiveRows: rows.filter((row) => row.status !== 1 || row.deleted !== 0 || row.userbanned !== 0).length,
  };
}

function helpText(): string {
  return `
Legacy user migration (dry-run by default)

Required environment variables:
  LEGACY_DATABASE_URL=mysql://.../dvi_travels
  DATABASE_URL=mysql://.../<target>       (or TARGET_DATABASE_URL)

Alternatively, when running on the legacy server:
  --legacy-php-config /var/www/html/head/config/database.php

For production credentials stored in a separate file:
  --env-file .env-prod

Examples:
  npx tsx scripts/migrate-legacy-users.ts --target-db dvi_staging
  npx tsx scripts/migrate-legacy-users.ts --target-db dvi_staging --apply
  npx tsx scripts/migrate-legacy-users.ts --target-db dvi_main --apply

Optional flags:
  --replace-matched-passwords   Replace an existing target user's password only when
                                the normalized email matches a legacy user.
  --skip-duplicate-source-emails
                                Skip every legacy row whose normalized email occurs
                                more than once in the legacy source.
  --allow-unusable-passwords    Allow empty/unknown legacy password formats. Those
                                accounts will need a password reset.
`;
}

async function createBackup(
  target: mysql.Connection,
  targetDatabase: string,
  timestamp: string,
): Promise<string> {
  const backupTable = `dvi_users_migration_backup_${timestamp}`;
  const targetUsers = `${quoteIdentifier(targetDatabase)}.${quoteIdentifier('dvi_users')}`;
  await target.query(
    `CREATE TABLE ${quoteIdentifier(backupTable)} LIKE ${targetUsers}`,
  );
  await target.query(
    `INSERT INTO ${quoteIdentifier(backupTable)} SELECT * FROM ${targetUsers}`,
  );
  return backupTable;
}

async function createMappingTable(
  target: mysql.Connection,
  timestamp: string,
): Promise<string> {
  const mappingTable = `dvi_users_migration_map_${timestamp}`;
  await target.query(`
    CREATE TABLE ${quoteIdentifier(mappingTable)} (
      source_userID VARCHAR(32) NOT NULL,
      target_userID VARCHAR(32) NULL,
      normalized_email VARCHAR(320) NULL,
      action VARCHAR(32) NOT NULL,
      migrated_at DATETIME NOT NULL,
      PRIMARY KEY (source_userID),
      INDEX idx_normalized_email (normalized_email)
    ) ENGINE=InnoDB
  `);
  return mappingTable;
}

async function insertUsers(
  target: mysql.Connection,
  targetDatabase: string,
  rows: UserRow[],
  preserveIds: boolean,
): Promise<void> {
  if (!rows.length) return;

  const targetUsers = `${quoteIdentifier(targetDatabase)}.${quoteIdentifier('dvi_users')}`;
  const columns: UserColumn[] = preserveIds
    ? [...USER_COLUMNS]
    : USER_COLUMNS.filter((column) => column !== 'userID');
  const fields = columns.map(quoteIdentifier).join(', ');
  const values = rows.map((row) => columns.map((column) => row[column]));

  await target.query(
    `INSERT INTO ${targetUsers} (${fields}) VALUES ?`,
    [values],
  );
}

async function insertMappings(
  target: mysql.Connection,
  mappingTable: string,
  rows: Array<{ sourceUserId: string; targetUserId: string | null; email: string | null; action: string }>,
): Promise<void> {
  if (!rows.length) return;
  await target.query(
    `INSERT INTO ${quoteIdentifier(mappingTable)}
      (source_userID, target_userID, normalized_email, action, migrated_at)
     VALUES ?`,
    [rows.map((row) => [row.sourceUserId, row.targetUserId, row.email, row.action, new Date()])],
  );
}

export async function runMigration(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(helpText());
    return;
  }

  loadDotenv({ path: args.envFile || '.env' });

  const targetDatabase = args.targetDatabase;
  if (!ALLOWED_TARGET_DATABASES.has(targetDatabase)) {
    throw new Error('--target-db must be exactly dvi_staging or dvi_main');
  }

  const legacyUrl = args.legacyPhpConfig
    ? databaseUrlFromPhpConfig(args.legacyPhpConfig)
    : process.env.LEGACY_DATABASE_URL;
  const legacy = databaseConfig(legacyUrl, args.legacyPhpConfig ? 'legacy PHP database config' : 'LEGACY_DATABASE_URL');
  const target = databaseConfig(databaseUrlForTarget(targetDatabase), 'TARGET_DATABASE_URL/DATABASE_URL');

  if (legacy.database !== SOURCE_DATABASE) {
    throw new Error(`LEGACY_DATABASE_URL must point to ${SOURCE_DATABASE}, not ${legacy.database}`);
  }
  if (target.database !== targetDatabase) {
    throw new Error(`Target URL points to ${target.database}, but --target-db is ${targetDatabase}`);
  }

  let legacyDb: mysql.Connection | null = null;
  let targetDb: mysql.Connection | null = null;

  try {
    legacyDb = await mysql.createConnection({ ...legacy, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true });
    targetDb = await mysql.createConnection({ ...target, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true });

    if (!(await tableExists(legacyDb, SOURCE_DATABASE))) throw new Error(`${SOURCE_DATABASE}.dvi_users does not exist`);
    if (!(await tableExists(targetDb, targetDatabase))) throw new Error(`${targetDatabase}.dvi_users does not exist`);
    await assertColumns(legacyDb, SOURCE_DATABASE, 'Source');
    await assertColumns(targetDb, targetDatabase, 'Target');

    const [sourceRows, targetRows] = await Promise.all([
      loadUsers(legacyDb, SOURCE_DATABASE),
      loadUsers(targetDb, targetDatabase),
    ]);
    const targetByEmail = emailMap(targetRows.filter((row) => row.deleted === 0));
    const sourceDuplicates = duplicateEmails(sourceRows);
    const targetDuplicates = duplicateEmails(targetRows.filter((row) => row.deleted === 0));
    const duplicateEmailSet = new Set(sourceDuplicates.keys());
    const sourceRowsForMigration = args.skipDuplicateSourceEmails
      ? sourceRows.filter((row) => !duplicateEmailSet.has(normalizeEmail(row.useremail)))
      : sourceRows;
    const matched = sourceRowsForMigration.filter((row) => {
      const email = normalizeEmail(row.useremail);
      return Boolean(email && targetByEmail.has(email));
    });
    const missingEmailRows = sourceRows.filter((row) => !normalizeEmail(row.useremail));
    const newRows = sourceRowsForMigration.filter((row) => {
      const email = normalizeEmail(row.useremail);
      return Boolean(email && !targetByEmail.has(email));
    });
    const unusablePasswords = sourceRows.filter((row) => passwordFormat(row.password) === 'empty' || passwordFormat(row.password) === 'unknown');
    const activeUnusablePasswords = unusablePasswords.filter((row) => row.status === 1 && row.deleted === 0 && row.userbanned === 0);

    const summary = {
      mode: args.apply ? 'APPLY' : 'DRY_RUN',
      sourceDatabase: SOURCE_DATABASE,
      targetDatabase,
      source: describeRows(sourceRows),
      target: describeRows(targetRows),
      matchedExistingEmails: matched.length,
      newRowsWithEmail: newRows.length,
      skippedMissingEmailWhenMerging: targetRows.length > 0 ? missingEmailRows.length : 0,
      skippedDuplicateSourceRows: sourceRows.length - sourceRowsForMigration.length,
      preserveSourceUserIds: targetRows.length === 0,
      sourceDuplicateEmails: [...sourceDuplicates.keys()],
      targetDuplicateEmails: [...targetDuplicates.keys()],
      unusablePasswordRows: unusablePasswords.length,
      activeUnusablePasswordRows: activeUnusablePasswords.length,
      replaceMatchedPasswords: args.replaceMatchedPasswords,
      skipDuplicateSourceEmails: args.skipDuplicateSourceEmails,
    };
    console.log(JSON.stringify(summary, null, 2));

    if (!args.apply) return;
    if (sourceDuplicates.size && !args.skipDuplicateSourceEmails) {
      throw new Error('Aborting: source contains duplicate normalized emails. Use --skip-duplicate-source-emails to skip those rows.');
    }
    if (targetDuplicates.size) throw new Error('Aborting: target contains duplicate active normalized emails. Resolve them first.');
    if (activeUnusablePasswords.length && !args.allowUnusablePasswords) {
      throw new Error('Aborting: active users contain empty/unknown password formats. Use --allow-unusable-passwords only if those users will reset their passwords.');
    }

    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const backupTable = await createBackup(targetDb, targetDatabase, timestamp);
    const mappingTable = await createMappingTable(targetDb, timestamp);
    console.log(JSON.stringify({ backupTable, mappingTable }));

    await targetDb.beginTransaction();
    try {
      const rowsToInsert = targetRows.length === 0 ? sourceRowsForMigration : newRows;
      await insertUsers(targetDb, targetDatabase, rowsToInsert, targetRows.length === 0);

      if (args.replaceMatchedPasswords && matched.length) {
        for (const sourceRow of matched) {
          const email = normalizeEmail(sourceRow.useremail);
          const targetRow = targetByEmail.get(email);
          if (!targetRow) continue;
          await targetDb.execute(
            `UPDATE ${quoteIdentifier(targetDatabase)}.${quoteIdentifier('dvi_users')}
                SET password = ?
              WHERE userID = ?`,
            [sourceRow.password, targetRow.userID],
          );
        }
      }

      const insertedByEmail = new Map<string, UserRow>();
      if (rowsToInsert.length) {
        const [insertedRows] = await targetDb.query<UserRow[]>(`
          SELECT CAST(userID AS CHAR) AS userID, useremail
            FROM ${quoteIdentifier(targetDatabase)}.${quoteIdentifier('dvi_users')}
           WHERE useremail IS NOT NULL
        `);
        for (const row of insertedRows) insertedByEmail.set(normalizeEmail(row.useremail), row);
      }

      const mappings = sourceRows
        .filter((row) => normalizeEmail(row.useremail))
        .map((row) => {
          const email = normalizeEmail(row.useremail);
          const existing = targetByEmail.get(email);
          const inserted = insertedByEmail.get(email);
          const skippedDuplicate = args.skipDuplicateSourceEmails && duplicateEmailSet.has(email);
          return {
            sourceUserId: row.userID,
            targetUserId: skippedDuplicate ? null : (existing?.userID || inserted?.userID || null),
            email,
            action: skippedDuplicate
              ? 'SKIPPED_DUPLICATE_EMAIL'
              : existing
              ? (args.replaceMatchedPasswords ? 'MATCHED_PASSWORD_REPLACED' : 'MATCHED_UNCHANGED')
              : 'INSERTED',
          };
        });
      await insertMappings(targetDb, mappingTable, mappings);
      await targetDb.commit();
    } catch (error) {
      await targetDb.rollback();
      throw error;
    }

    console.log(`Migration applied to ${targetDatabase}. The target backup is ${backupTable}.`);
  } finally {
    await Promise.all([
      legacyDb?.end(),
      targetDb?.end(),
    ]);
  }
}

if (require.main === module) {
  runMigration().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
