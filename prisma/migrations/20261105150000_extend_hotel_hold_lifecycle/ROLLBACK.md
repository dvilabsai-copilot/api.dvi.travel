# Rollback guidance

This migration is additive, but it also updates legacy hold-policy values and
creates durable hold-notification records. MySQL DDL commits separately, so a
transaction cannot roll the migration back as one unit.

1. Stop the API instances that run the reminder and expiry schedulers. Keep
   hotel confirmation and payment actions paused while rolling back.
2. Back up `dvi_global_settings`, `dvi_hotel_block_requests`, and
   `dvi_hotel_hold_notifications`. Do not discard active or historical hold,
   payment, release, or notification records.
3. Deploy the previous application version. It ignores the additive fields;
   leave the new columns and notification table in place until all holds
   created by this version have been resolved and their release work is done.
4. If removing the schema additions is required, first archive the notification
   table, then drop `dvi_hotel_hold_notifications` and the lifecycle columns
   added to `dvi_hotel_block_requests` and `dvi_global_settings` by this
   migration. Use the exact column list in `migration.sql` and verify the
   deployed Prisma schema before running DDL.
5. Restore `hotel_hold_short_duration_hours` and
   `hotel_hold_no_block_before_hours` from the pre-migration settings backup.
   The migration intentionally converts legacy defaults (`4` and `48`) to
   `48` and `0`; do not reverse those values with a blanket update because
   settings may have been edited after rollout.
6. Restart the previous API version and verify Global Settings, itinerary
   confirmation, and existing provider cancellation flows before resuming
   normal operations.

Do not run this rollback against production without an approved backup and a
review of active holds. Existing hold cutoffs are not altered by the forward
migration and must retain their original stored values.
