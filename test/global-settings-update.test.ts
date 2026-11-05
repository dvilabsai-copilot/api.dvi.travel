import assert from "node:assert/strict";
import test from "node:test";
import { GlobalSettingsService } from "../src/modules/settings/global-settings/global-settings.service";

function serviceWithExisting(existing: Record<string, unknown>) {
  const updates: Array<Record<string, unknown>> = [];
  const service = Object.create(GlobalSettingsService.prototype) as any;

  service.prisma = {
    dvi_global_settings: {
      findFirst: async () => existing,
      create: async () => existing,
      update: async (args: { data: Record<string, unknown> }) => {
        updates.push(args.data);
        return existing;
      },
    },
  };

  return { service, updates };
}

const commonBufferTime = new Date(Date.UTC(1970, 0, 1, 1, 0));

function existingSettings() {
  return {
    global_settings_ID: 1,
    createdby: 0,
    hotel_margin: 10,
    hotel_margin_gst_type: false,
    itinerary_common_buffer_time: commonBufferTime,
    vehicle_terms_condition: "vehicle terms".repeat(400),
    hotel_terms_condition: "hotel terms".repeat(250),
    hotel_voucher_terms_condition: "hotel voucher terms".repeat(200),
    vehicle_voucher_terms_condition: "vehicle voucher terms".repeat(200),
  };
}

test("full settings payload updates only the changed scalar field", async () => {
  const existing = existingSettings();
  const { service, updates } = serviceWithExisting(existing);

  await service.updateGlobalSettings({
    hotel_margin: 12,
    hotel_margin_gst_type: false,
    itinerary_common_buffer_time: "01:00",
    vehicle_terms_condition: existing.vehicle_terms_condition,
    hotel_terms_condition: existing.hotel_terms_condition,
    hotel_voucher_terms_condition: existing.hotel_voucher_terms_condition,
    vehicle_voucher_terms_condition: existing.vehicle_voucher_terms_condition,
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].hotel_margin, 12);
  assert.ok(updates[0].updatedon instanceof Date);
  assert.equal("vehicle_terms_condition" in updates[0], false);
  assert.equal("hotel_terms_condition" in updates[0], false);
  assert.equal("hotel_voucher_terms_condition" in updates[0], false);
  assert.equal("vehicle_voucher_terms_condition" in updates[0], false);
});

test("unchanged full settings payload does not issue an update", async () => {
  const existing = existingSettings();
  const { service, updates } = serviceWithExisting(existing);

  await service.updateGlobalSettings({
    hotel_margin: existing.hotel_margin,
    hotel_margin_gst_type: existing.hotel_margin_gst_type,
    itinerary_common_buffer_time: "01:00",
    vehicle_terms_condition: existing.vehicle_terms_condition,
    hotel_terms_condition: existing.hotel_terms_condition,
    hotel_voucher_terms_condition: existing.hotel_voucher_terms_condition,
    vehicle_voucher_terms_condition: existing.vehicle_voucher_terms_condition,
  });

  assert.equal(updates.length, 0);
});

test("changed time and boolean values keep their existing normalization", async () => {
  const existing = existingSettings();
  const { service, updates } = serviceWithExisting(existing);

  await service.updateGlobalSettings({
    hotel_margin_gst_type: "yes" as unknown as boolean,
    itinerary_common_buffer_time: "02:30",
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].hotel_margin_gst_type, true);
  assert.deepEqual(
    updates[0].itinerary_common_buffer_time,
    new Date(Date.UTC(1970, 0, 1, 2, 30)),
  );
});

test("a changed terms field is still persisted", async () => {
  const existing = existingSettings();
  const { service, updates } = serviceWithExisting(existing);
  const replacement = "new vehicle terms";

  await service.updateGlobalSettings({
    vehicle_terms_condition: replacement,
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].vehicle_terms_condition, replacement);
  assert.ok(updates[0].updatedon instanceof Date);
});

test('GET returns the configured hotel hold bands and reminder settings', async () => {
  const expected = {
    ...existingSettings(),
    hotel_hold_min_lead_days: 3,
    hotel_hold_short_lead_days: 15,
    hotel_hold_medium_lead_days: 30,
    hotel_hold_long_lead_days: 60,
    hotel_hold_short_duration_hours: 48,
    hotel_hold_medium_duration_hours: 12,
    hotel_hold_long_duration_hours: 48,
    hotel_hold_extended_duration_hours: 240,
    hotel_hold_reminders_enabled: 1,
    hotel_hold_reminder_email_enabled: 1,
    hotel_hold_reminder_milestones: '{"12":[6,3,0.25],"48":[36,24,12,1,0.25],"240":[216,192,168,144,120,96,72,48,24,12,1,0.25]}',
    hotel_hold_final_reminder_minutes: 15,
  };
  const { service } = serviceWithExisting(expected);

  assert.deepEqual(await service.getGlobalSettings(), expected);
});

test("persists the configurable hotel hold policy fields", async () => {
  const existing = existingSettings();
  const { service, updates } = serviceWithExisting(existing);

  await service.updateGlobalSettings({
    hotel_hold_no_block_before_hours: 48,
    hotel_hold_min_lead_days: 3,
    hotel_hold_short_lead_days: 15,
    hotel_hold_medium_lead_days: 30,
    hotel_hold_long_lead_days: 60,
    hotel_hold_short_duration_hours: 48,
    hotel_hold_medium_duration_hours: 12,
    hotel_hold_long_duration_hours: 48,
    hotel_hold_extended_duration_hours: 240,
    hotel_hold_reminders_enabled: 1,
    hotel_hold_reminder_email_enabled: 1,
    hotel_hold_reminder_milestones: '{"12":[6,3,0.25],"48":[36,24,12,1,0.25],"240":[24,12,1,0.25]}',
    hotel_hold_final_reminder_minutes: 15,
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].hotel_hold_no_block_before_hours, 48);
  assert.equal(updates[0].hotel_hold_min_lead_days, 3);
  assert.equal(updates[0].hotel_hold_short_duration_hours, 48);
  assert.equal(updates[0].hotel_hold_long_duration_hours, 48);
  assert.equal(updates[0].hotel_hold_extended_duration_hours, 240);
});

test('validates complete lead-day band ordering while preserving partial updates', async () => {
  const existing = {
    ...existingSettings(),
    hotel_hold_min_lead_days: 3,
    hotel_hold_short_lead_days: 15,
    hotel_hold_medium_lead_days: 30,
    hotel_hold_long_lead_days: 60,
    hotel_hold_short_duration_hours: 48,
    hotel_hold_medium_duration_hours: 12,
    hotel_hold_long_duration_hours: 48,
    hotel_hold_extended_duration_hours: 240,
    hotel_hold_no_block_before_hours: 48,
  };
  const { service, updates } = serviceWithExisting(existing);
  await service.updateGlobalSettings({ hotel_hold_medium_duration_hours: 18 });
  assert.equal(updates[0].hotel_hold_medium_duration_hours, 18);
  assert.equal('hotel_margin' in updates[0], false);

  await assert.rejects(
    service.updateGlobalSettings({ hotel_hold_long_lead_days: 30 }),
    (error: any) => String(error?.message || '').includes('strictly increasing'),
  );
});

test('rejects non-positive hold durations and malformed reminder configuration', async () => {
  const existing = {
    ...existingSettings(),
    hotel_hold_min_lead_days: 3,
    hotel_hold_short_lead_days: 15,
    hotel_hold_medium_lead_days: 30,
    hotel_hold_long_lead_days: 60,
    hotel_hold_short_duration_hours: 48,
    hotel_hold_medium_duration_hours: 12,
    hotel_hold_long_duration_hours: 48,
    hotel_hold_extended_duration_hours: 240,
  };
  const { service } = serviceWithExisting(existing);
  await assert.rejects(service.updateGlobalSettings({ hotel_hold_extended_duration_hours: 0 }));
  await assert.rejects(service.updateGlobalSettings({ hotel_hold_reminder_milestones: 'oops' }));
});
