import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveHotelHoldNotificationRecipients } from '../src/modules/itineraries/utils/hotel-hold-recipient.util';

test('resolves the selected Agent and the assigned Travel Expert from staff details', async () => {
  const prisma: any = {
    dvi_agent: {
      findFirst: async () => ({
        agent_name: 'Agent Name', agent_lastname: 'Agency', agent_email_id: 'agent@example.test', travel_expert_id: 81,
      }),
    },
    dvi_staff_details: {
      findFirst: async ({ where }: any) => {
        assert.equal(where.staff_id, 81);
        return { staff_name: 'Expert Name', staff_email: 'expert@example.test' };
      },
    },
    dvi_users: { findFirst: async () => null },
  };

  assert.deepEqual(await resolveHotelHoldNotificationRecipients(prisma, { agent_id: 7, staff_id: 92 }), [
    { role: 'Agent', name: 'Agent Name Agency', email: 'agent@example.test' },
    { role: 'Travel Expert', name: 'Expert Name', email: 'expert@example.test' },
  ]);
});

test('uses linked login emails when profile email fields are missing while preserving both intended roles', async () => {
  const prisma: any = {
    dvi_agent: { findFirst: async () => ({ agent_name: 'Agent Name', travel_expert_id: 81 }) },
    dvi_staff_details: { findFirst: async () => ({ staff_name: 'Expert Name', staff_email: null }) },
    dvi_users: {
      findFirst: async ({ where }: any) => where.agent_id === 7
        ? { username: 'Agent Login', useremail: 'same@example.test' }
        : { username: 'Expert Login', useremail: 'same@example.test' },
    },
  };

  assert.deepEqual(await resolveHotelHoldNotificationRecipients(prisma, { agent_id: 7 }), [
    { role: 'Agent', name: 'Agent Login', email: 'same@example.test' },
    { role: 'Travel Expert', name: 'Expert Login', email: 'same@example.test' },
  ]);
});

test('does not fall back to the itinerary creator when the assigned recipients have no email', async () => {
  const prisma: any = {
    dvi_agent: { findFirst: async () => ({ agent_name: 'Agent Name', agent_email_id: '', travel_expert_id: 0 }) },
    dvi_staff_details: { findFirst: async () => null },
    dvi_users: { findFirst: async () => null },
  };

  assert.deepEqual(await resolveHotelHoldNotificationRecipients(prisma, { agent_id: 7, staff_id: 0, createdby: 12 }), []);
});
