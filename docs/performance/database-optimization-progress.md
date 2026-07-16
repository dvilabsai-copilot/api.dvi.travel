# Database Optimization Progress

## Baseline

- No production SQL was executed.
- No index was added or removed.
- No query was changed.
- Query count, rows examined, payload size and database duration are not yet measured.

## Read-only schema audit

`npm run audit:database` runs read-only `information_schema` and, when enabled, `performance_schema` queries against `DATABASE_URL`. It writes `database-audit-baseline.json` with table-size estimates, index definitions, foreign-key relationships, audit-query durations and available index-I/O counters. It never runs DDL or DML.

The generated artifact is evidence about the selected database only. It does not represent endpoint query counts, production latency or index usefulness without a captured request and query plan.

## Evidence required before optimization

1. Capture a representative fixture request with query logging enabled in a safe environment.
2. Attribute each query to one extracted responsibility.
3. Compare query plans and result ordering before/after.
4. Separate index proposals from code changes and provide exact rollback SQL.

## Current hypotheses (not recommendations)

The oversized itinerary/details/timeline paths are candidates for repeated reads, nested includes and queries inside loops. These are hypotheses from static inspection only and must not be reported as confirmed N+1 defects until measured.

The broader candidate register, including index-addition/removal evidence gates, Redis suitability and invalidation controls, and query-level profiling fields, is maintained in [`performance-candidates.md`](./performance-candidates.md).
