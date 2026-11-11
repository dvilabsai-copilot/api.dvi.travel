# Hotel hold lifecycle migration

This migration is additive: it adds hold-policy settings, payment/release tracking columns, and the durable notification outbox. It also updates only legacy default values (`4` hour short holds to `48`, and the old `48` hour no-block threshold to `0`) and fills missing reminder configuration. Existing non-default values and existing hold cutoff timestamps are left intact.

## Rollback guidance

1. Stop deploying the new application version and roll back the application code first. Older code ignores the added columns and table.
2. Keep the migration applied if preserving reminder delivery, payment markers, or release audit data matters. The schema additions are backward-compatible with the prior application.
3. If a full schema rollback is required, take a database backup first. Then drop `dvi_hotel_hold_notifications`, remove the columns added to `dvi_hotel_block_requests` and `dvi_global_settings`, and restore the two settings only where their values are still the migration defaults. Do not blindly change user-edited settings or existing hold cutoff timestamps.
4. Dropping the new table/columns permanently removes notification, payment-marker, and release-progress history. Restore from backup if that data must be retained.

The SQL migration intentionally has no automatic destructive down migration.
