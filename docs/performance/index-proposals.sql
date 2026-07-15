-- DVI evidence-gated index proposal for 2026-07-16.
-- No index addition or removal is approved by the current evidence.

-- UP (intentionally no-op)
-- No DDL is emitted until representative endpoint traces, EXPLAIN plans,
-- write-volume impact and duplicate-index validation are available.

-- DOWN / ROLLBACK (intentionally no-op)
-- There is no schema change to roll back.

-- VALIDATION (read-only; run manually against the approved target database)
SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, CARDINALITY
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;

-- LOCKING / ROLLOUT
-- No DDL means no metadata lock and no rollout action for this artifact.
-- Any future ALTER TABLE must be reviewed for MySQL online-DDL behavior,
-- table size, write load, lock timeout and a tested rollback before approval.
