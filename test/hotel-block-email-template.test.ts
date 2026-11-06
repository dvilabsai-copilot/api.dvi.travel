import assert from 'node:assert/strict';
import test from 'node:test';
import { renderHotelBlockEmailHtml } from '../src/modules/itineraries/templates/hotel-block-email.template';

test('hotel release email requests release and acknowledgement without a hotel response link', () => {
  const html = renderHotelBlockEmailHtml({
    quotationReference: 'DVI-QUOTE-1',
    hotelName: 'Test Hotel',
    provider: 'OFFLINE',
    checkIn: '2026-11-25',
    checkOut: '2026-11-26',
    roomType: 'Deluxe',
    roomCount: 2,
    responseUrl: 'https://example.test/confirm-hotel',
    demoMode: false,
    intendedRecipient: 'hotel@example.test',
    emailKind: 'RELEASE',
    cutoffAt: '2026-11-24 10:00',
    guestName: 'Guest One',
    originalHoldReference: 'HOLD-42',
  });

  assert.match(html, /Request to Release Hotel Hold/);
  assert.match(html, /DVI-QUOTE-1/);
  assert.match(html, /Guest One/);
  assert.match(html, /HOLD-42/);
  assert.match(html, /release the rooms and acknowledge the release/i);
  assert.match(html, /Expired at/);
  assert.doesNotMatch(html, /https:\/\/example\.test\/confirm-hotel/);
});

test('manual cancellation release email reports the release request time instead of an expiry time', () => {
  const html = renderHotelBlockEmailHtml({
    quotationReference: 'DVI-QUOTE-3',
    hotelName: 'Test Hotel',
    provider: 'OFFLINE',
    checkIn: '2026-11-25',
    checkOut: '2026-11-26',
    roomType: 'Deluxe',
    roomCount: 1,
    responseUrl: '',
    demoMode: false,
    intendedRecipient: 'hotel@example.test',
    emailKind: 'RELEASE',
    releaseReason: 'CANCELLED',
    cutoffAt: '2026-11-05 10:00',
  });

  assert.match(html, /Release requested at/);
  assert.doesNotMatch(html, /Expired at/);
});

test('payment reminder displays its actual remaining time', () => {
  const html = renderHotelBlockEmailHtml({
    quotationReference: 'DVI-QUOTE-2',
    hotelName: 'Test Hotel',
    provider: 'OFFLINE',
    checkIn: '2026-11-25',
    checkOut: '2026-11-26',
    roomType: 'Deluxe',
    roomCount: 1,
    responseUrl: '',
    itineraryUrl: 'https://example.test/itinerary',
    demoMode: false,
    intendedRecipient: 'expert@example.test',
    intendedRecipients: ['Agent: Agent Name', 'Travel Expert: Expert Name'],
    emailKind: 'REMINDER',
    cutoffAt: '2026-11-24 10:00',
    remainingTime: '3 hours 12 minutes',
  });

  assert.match(html, /3 hours 12 minutes/);
  assert.match(html, /Agent: Agent Name/);
  assert.match(html, /Travel Expert: Expert Name/);
  assert.doesNotMatch(html, /expires in 24 hours/i);
});

test('test-delivered reminders clearly state the intended Agent and Travel Expert without contacting them', () => {
  const html = renderHotelBlockEmailHtml({
    quotationReference: 'DVI-QUOTE-4', hotelName: 'Test Hotel', provider: 'OFFLINE',
    checkIn: '2026-11-25', checkOut: '2026-11-26', roomType: 'Deluxe', roomCount: 1,
    responseUrl: '', itineraryUrl: 'https://example.test/itinerary', demoMode: true,
    intendedRecipient: 'agent@example.test, expert@example.test',
    intendedRecipients: ['Agent: Agent Name', 'Travel Expert: Expert Name'],
    emailKind: 'REMINDER', cutoffAt: '2026-11-24 10:00', remainingTime: '3 hours', testDelivery: true,
  });

  assert.match(html, /Test delivery/);
  assert.match(html, /Intended recipients: Agent: Agent Name; Travel Expert: Expert Name/);
  assert.match(html, /intended recipient has not been contacted/i);
});
