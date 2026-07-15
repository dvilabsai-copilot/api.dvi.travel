import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import mysql from 'mysql2/promise';

type QueryResult = Record<string, unknown>[];

function databaseConfig() {
  const rawUrl = String(process.env.DATABASE_URL || '').trim();
  if (!rawUrl) throw new Error('DATABASE_URL is required');

  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'mysql:') throw new Error('DATABASE_URL must use the mysql:// protocol');

  return {
    host: parsed.hostname,
    port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
  };
}

async function query(connection: mysql.Connection, sql: string, params: unknown[] = []): Promise<QueryResult> {
  const [rows] = await connection.query(sql, params);
  return rows as QueryResult;
}

async function timedQuery(connection: mysql.Connection, name: string, sql: string, params: unknown[] = []) {
  const startedAt = process.hrtime.bigint();
  const rows = await query(connection, sql, params);
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  return { name, durationMs: Number(durationMs.toFixed(3)), rowCount: rows.length, rows };
}

async function main() {
  const config = databaseConfig();
  const connection = await mysql.createConnection({ ...config, dateStrings: true });

  try {
    const databaseName = config.database;
    const queries = [
      timedQuery(
        connection,
        'table_sizes',
        `SELECT TABLE_NAME AS tableName, TABLE_ROWS AS estimatedRows,
                DATA_LENGTH AS dataBytes, INDEX_LENGTH AS indexBytes,
                CREATE_TIME AS createTime, UPDATE_TIME AS updateTime
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = ?
          ORDER BY (COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0)) DESC`,
        [databaseName],
      ),
      timedQuery(
        connection,
        'index_definitions',
        `SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName, NON_UNIQUE AS nonUnique,
                SEQ_IN_INDEX AS sequenceInIndex, COLUMN_NAME AS columnName,
                CARDINALITY AS cardinality, INDEX_TYPE AS indexType
           FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ?
          ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
        [databaseName],
      ),
      timedQuery(
        connection,
        'foreign_keys',
        `SELECT TABLE_NAME AS tableName, CONSTRAINT_NAME AS constraintName,
                COLUMN_NAME AS columnName, REFERENCED_TABLE_NAME AS referencedTableName,
                REFERENCED_COLUMN_NAME AS referencedColumnName
           FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
          ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
        [databaseName],
      ),
    ];

    const performanceSchema = await query(
      connection,
      `SELECT @@performance_schema AS enabled, VERSION() AS serverVersion`,
    );
    let indexUsage;
    if (Number(performanceSchema[0]?.enabled || 0) === 1) {
      try {
        indexUsage = await timedQuery(
          connection,
          'index_usage',
          `SELECT OBJECT_SCHEMA AS tableSchema, OBJECT_NAME AS tableName,
                  INDEX_NAME AS indexName, COUNT_READ AS readCount,
                  COUNT_WRITE AS writeCount, COUNT_FETCH AS fetchCount
             FROM performance_schema.table_io_waits_summary_by_index_usage
            WHERE OBJECT_SCHEMA = ?
            ORDER BY (COUNT_READ + COUNT_WRITE + COUNT_FETCH) DESC`,
          [databaseName],
        );
      } catch (error) {
        indexUsage = { name: 'index_usage', available: false, reason: String(error) };
      }
    } else {
      indexUsage = { name: 'index_usage', available: false, reason: 'performance_schema is disabled' };
    }

    const result = {
      generatedAt: new Date().toISOString(),
      readOnly: true,
      target: { host: config.host, port: config.port, database: databaseName },
      server: performanceSchema[0] || {},
      queries: await Promise.all(queries),
      indexUsage,
      interpretation: {
        tableRowsAreEstimates: true,
        queryDurationsAreAuditQueryDurations: true,
        noProductionEndpointQueryCountsClaimed: true,
        noIndexRecommendationWithoutEndpointEvidence: true,
      },
    };

    const outputPath = resolve(__dirname, '../docs/performance/database-audit-baseline.json');
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      outputPath,
      database: databaseName,
      tableCount: result.queries[0].rowCount,
      indexDefinitionCount: result.queries[1].rowCount,
      foreignKeyCount: result.queries[2].rowCount,
      indexUsageAvailable: indexUsage && 'available' in indexUsage ? indexUsage.available : true,
    }, null, 2));
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
