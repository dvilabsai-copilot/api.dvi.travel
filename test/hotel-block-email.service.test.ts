import assert from 'node:assert/strict';
import test from 'node:test';
import { HotelBlockEmailService } from '../src/modules/itineraries/services/hotel-block-email.service';

test('lifecycle email dispatch always uses the requested test inbox and records intended recipients', async () => {
  const previousEnabled = process.env.HOTEL_BLOCK_EMAIL_ENABLED;
  const previousDemo = process.env.DEMO_HOTEL_EMAIL;
  try {
    process.env.HOTEL_BLOCK_EMAIL_ENABLED = 'true';
    delete process.env.DEMO_HOTEL_EMAIL;
    const service = new HotelBlockEmailService();
    const messages: any[] = [];
    (service as any).getTransporter = () => ({ sendMail: async (message: any) => { messages.push(message); return { messageId: `test-${messages.length}` }; } });
    const recipients = [
      { role: 'Agent' as const, name: 'Selected Agent', email: 'agent@real-domain.example' },
      { role: 'Travel Expert' as const, name: 'Assigned Expert', email: 'expert@real-domain.example' },
    ];
    const request = { hotelName: 'Test Hotel', provider: 'OFFLINE', checkIn: '2026-11-22', checkOut: '2026-11-23', roomType: 'Deluxe', roomCount: 1 };

    const reminder = await service.dispatchReminder({ recipients, quotationReference: 'DVI-TEST', itineraryUrl: 'http://localhost/itinerary', request, remainingTime: '2 hours' });
    const expired = await service.dispatchAgentHoldExpired({ recipients, quotationReference: 'DVI-TEST', itineraryUrl: 'http://localhost/itinerary', request });
    const release = await service.dispatch({ recipient: 'hotel@real-domain.example', quotationReference: 'DVI-TEST', request: { ...request, emailKind: 'RELEASE' } });

    assert.deepEqual(messages.map(({ to }) => to), ['dhisoftai@gmail.com', 'dhisoftai@gmail.com', 'dhisoftai@gmail.com']);
    for (const message of messages.slice(0, 2)) {
      assert.match(message.text, /TEST NOTICE/);
      assert.match(message.text, /Agent: Selected Agent/);
      assert.match(message.text, /Travel Expert: Assigned Expert/);
      assert.match(message.text, /not been contacted/i);
    }
    assert.match(messages[2].text, /TEST NOTICE/);
    assert.match(messages[2].text, /Intended hotelier email: hotel@real-domain\.example/);
    assert.match(messages[2].text, /not been contacted/i);
    assert.equal(reminder.testDelivery, true);
    assert.equal(expired.testDelivery, true);
    assert.equal(release.testDelivery, true);
  } finally {
    if (previousEnabled === undefined) delete process.env.HOTEL_BLOCK_EMAIL_ENABLED;
    else process.env.HOTEL_BLOCK_EMAIL_ENABLED = previousEnabled;
    if (previousDemo === undefined) delete process.env.DEMO_HOTEL_EMAIL;
    else process.env.DEMO_HOTEL_EMAIL = previousDemo;
  }
});
