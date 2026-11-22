import assert from 'node:assert/strict';
import test from 'node:test';
import nodemailer from 'nodemailer';
import { HotelBlockEmailService } from '../src/modules/itineraries/services/hotel-block-email.service';

test('offline voucher From header includes the configured sender name or the legacy default', async () => {
  const originalAddress = process.env.SMTP_FROM;
  const originalName = process.env.SMTP_FROM_NAME;
  try {
    process.env.SMTP_FROM = 'sales@example.com';
    const service = new HotelBlockEmailService({
      dvi_global_settings: { findFirst: async () => null },
    } as any);
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
    let header = '';
    (service as any).getTransporter = () => ({
      sendMail: async (message: nodemailer.SendMailOptions) => {
        const sent = await transport.sendMail(message);
        header = sent.message.toString().split('\r\n').find((line) => line.startsWith('From:')) ?? '';
        return sent;
      },
    });
    const voucher = { subject: 'Hotel Voucher', text: 'Voucher', html: '<p>Voucher</p>' };
    process.env.SMTP_FROM_NAME = 'Reservations Team';
    await service.dispatchOfflineVoucher(['hotel@example.com'], voucher);
    assert.equal(header, 'From: Reservations Team <sales@example.com>');
    delete process.env.SMTP_FROM_NAME;
    await service.dispatchOfflineVoucher(['hotel@example.com'], voucher);
    assert.equal(header, 'From: Do View Holidays <sales@example.com>');
  } finally {
    if (originalAddress === undefined) delete process.env.SMTP_FROM;
    else process.env.SMTP_FROM = originalAddress;
    if (originalName === undefined) delete process.env.SMTP_FROM_NAME;
    else process.env.SMTP_FROM_NAME = originalName;
  }
});

test('lifecycle email dispatch always uses the requested test inbox and records intended recipients', async () => {
  const previousEnabled = process.env.HOTEL_BLOCK_EMAIL_ENABLED;
  const previousDemo = process.env.DEMO_HOTEL_EMAIL;
  const previousDemoRecipient = process.env.DEMO_HOTEL_EMAIL_RECIPIENT;
  try {
    process.env.HOTEL_BLOCK_EMAIL_ENABLED = 'true';
    process.env.DEMO_HOTEL_EMAIL = 'true';
    const service = new HotelBlockEmailService({
      dvi_global_settings: { findFirst: async () => ({ cc_email_id: 'sales@dvi.co.in' }) },
    } as any);
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
    const holdNotice = await service.dispatch({ recipient: 'hotel@real-domain.example', quotationReference: 'DVI-TEST', request: { ...request, emailKind: 'HOLD_NOTICE' } });
    const holdCreated = await service.dispatchAgentHoldCreated({ recipients, quotationReference: 'DVI-TEST', itineraryUrl: 'https://staging.dvi.travel/itinerary-details/DVI-TEST', request });

    assert.deepEqual(messages.map(({ to }) => to), Array(5).fill('dhisoftai@gmail.com'));
    for (const message of messages.slice(0, 2)) {
      assert.match(message.text, /TEST NOTICE/);
      assert.match(message.text, /Agent: Selected Agent/);
      assert.match(message.text, /Travel Expert: Assigned Expert/);
      assert.match(message.text, /not been contacted/i);
    }
    assert.match(messages[2].text, /TEST NOTICE/);
    assert.match(messages[2].text, /Intended hotelier email: hotel@real-domain\.example/);
    assert.match(messages[2].text, /not been contacted/i);
    assert.match(messages[3].text, /TEST NOTICE/);
    assert.match(messages[3].text, /Intended hotelier email: hotel@real-domain\.example/);
    assert.match(messages[3].text, /not been contacted/i);
    assert.match(messages[4].text, /TEST NOTICE/);
    assert.match(messages[4].text, /Travel Expert: Assigned Expert \(expert@real-domain\.example\)/);
    assert.doesNotMatch(messages[4].text, /Agent: Selected Agent|agent@real-domain\.example/);
    assert.deepEqual(messages[4].cc, ['sales@dvi.co.in']);
    assert.match(messages[4].text, /not been contacted/i);
    assert.equal(reminder.testDelivery, true);
    assert.equal(expired.testDelivery, true);
    assert.equal(release.testDelivery, true);
    assert.equal(holdNotice.testDelivery, true);
    assert.equal(holdCreated.testDelivery, true);
  } finally {
    if (previousEnabled === undefined) delete process.env.HOTEL_BLOCK_EMAIL_ENABLED;
    else process.env.HOTEL_BLOCK_EMAIL_ENABLED = previousEnabled;
    if (previousDemo === undefined) delete process.env.DEMO_HOTEL_EMAIL;
    else process.env.DEMO_HOTEL_EMAIL = previousDemo;
    if (previousDemoRecipient === undefined) delete process.env.DEMO_HOTEL_EMAIL_RECIPIENT;
    else process.env.DEMO_HOTEL_EMAIL_RECIPIENT = previousDemoRecipient;
  }
});

test('pending-payment hold-created email is addressed only to the Travel Expert when live delivery is enabled', async () => {
  const previousEnabled = process.env.HOTEL_BLOCK_EMAIL_ENABLED;
  const previousDemo = process.env.DEMO_HOTEL_EMAIL;
  try {
    process.env.HOTEL_BLOCK_EMAIL_ENABLED = 'true';
    process.env.DEMO_HOTEL_EMAIL = 'false';
    const service = new HotelBlockEmailService({
      dvi_global_settings: { findFirst: async () => ({ cc_email_id: 'sales@dvi.co.in' }) },
    } as any);
    let sentMessage: any;
    (service as any).getTransporter = () => ({
      sendMail: async (message: any) => { sentMessage = message; return { messageId: 'live-test' }; },
    });

    const result = await service.dispatchAgentHoldCreated({
      recipients: [
        { role: 'Agent', name: 'Selected Agent', email: 'agent@real-domain.example' },
        { role: 'Travel Expert', name: 'Assigned Expert', email: 'expert@real-domain.example' },
      ],
      quotationReference: 'DVI-TEST',
      itineraryUrl: 'https://staging.dvi.travel/itinerary-details/DVI-TEST',
      request: { hotelName: 'Test Hotel', provider: 'OFFLINE', checkIn: '2026-11-22', checkOut: '2026-11-23', roomType: 'Deluxe', roomCount: 1 },
    });

    assert.equal(sentMessage.to, 'expert@real-domain.example');
    assert.deepEqual(sentMessage.cc, ['sales@dvi.co.in']);
    assert.doesNotMatch(sentMessage.to, /agent@real-domain\.example/);
    assert.equal(result.testDelivery, false);
  } finally {
    if (previousEnabled === undefined) delete process.env.HOTEL_BLOCK_EMAIL_ENABLED;
    else process.env.HOTEL_BLOCK_EMAIL_ENABLED = previousEnabled;
    if (previousDemo === undefined) delete process.env.DEMO_HOTEL_EMAIL;
    else process.env.DEMO_HOTEL_EMAIL = previousDemo;
  }
});
