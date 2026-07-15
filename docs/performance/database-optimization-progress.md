# Database Optimization Progress

## Baseline

- No production SQL was executed.
- No index was added or removed.
- No query was changed.
- Query count, rows examined, payload size and database duration are not yet measured.

## Evidence required before optimization

1. Capture a representative fixture request with query logging enabled in a safe environment.
2. Attribute each query to one extracted responsibility.
3. Compare query plans and result ordering before/after.
4. Separate index proposals from code changes and provide exact rollback SQL.

## Current hypotheses (not recommendations)

The oversized itinerary/details/timeline paths are candidates for repeated reads, nested includes and queries inside loops. These are hypotheses from static inspection only and must not be reported as confirmed N+1 defects until measured.
