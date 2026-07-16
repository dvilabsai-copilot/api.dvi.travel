# Index Analysis

Generated from the read-only audit at `docs/performance/database-audit-baseline.json`.

## Current evidence

- 2,288 index-column definitions were returned for 182 tables.
- Performance Schema was enabled and index-I/O counters were available.
- No declared foreign-key relationships were returned by `information_schema.KEY_COLUMN_USAGE`.
- The audit does not contain endpoint-level query plans, rows examined, write latency or workload attribution.

## Decision

No high-confidence duplicate candidate, missing-index candidate or index removal is approved. Similar names or zero counters are not sufficient evidence for a change because counters may be reset, composite indexes may serve multiple predicates, and the audit was not tied to a representative request.

The migration artifact is intentionally a no-op: `index-proposals.sql` contains the validation query, rollback statement (no-op) and locking/rollout constraints without speculative DDL.

## Required evidence for the next proposal

1. Capture representative itinerary-details, route-rebuild, hotel-search and hotspot-preview requests.
2. Attribute SQL statements to endpoint and extracted responsibility.
3. Record query count, duration, rows examined, payload size and write duration.
4. Run `EXPLAIN FORMAT=JSON` before and after any candidate index in an isolated environment.
5. Validate duplicate coverage, write amplification and rollback behavior before staging rollout.
