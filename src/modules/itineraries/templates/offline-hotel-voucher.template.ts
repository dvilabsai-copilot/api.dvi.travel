import type { OfflineHotelBookingDetailsDto, OfflineVoucherStayDto } from '../dto/offline-hotel-booking.dto';
import { offlineHotelBookingStatusLabels } from '../utils/offline-hotel-booking-status';

const escapeHtml = (value: string | number) => String(value).replace(/[&<>"']/g, (character) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
);
const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const moneyFormat = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
const date = (value: string) => dateFormat.format(new Date(value));

export function renderOfflineHotelVoucher(
  { quote, siteTitle, customerName }: { quote: string; siteTitle: string; customerName?: string },
  stay: OfflineVoucherStayDto,
  details: OfflineHotelBookingDetailsDto,
  confirmationUrl?: string,
) {
  const status = offlineHotelBookingStatusLabels[details.status];
  const title = `Hotel Voucher - ${status}`;
  const linkLabel = details.status === 'pending' ? 'Confirm Book' : 'View Voucher';
  const roomHeaders = ['Room category', 'Rooms', 'Rate per night', 'Extra beds', 'Extra bed rate', 'Children without bed', 'Child rate'];
  const rooms = details.rooms.map((room) => [
    room.category, room.quantity, moneyFormat.format(room.rate), room.extraBeds, moneyFormat.format(room.extraBedRate),
    room.childrenWithoutBed, moneyFormat.format(room.childWithoutBedRate),
  ]);
  const policies = details.cancellationPolicies.map((policy) => [date(policy.beforeDate), `${policy.percentage}%`]);
  const fields = [
    ['Quotation', quote], ['Hotel', stay.hotelName], ['Location', stay.destination],
    ['Check-in', date(stay.checkIn)], ['Check-out', date(stay.checkOut)], ['Status', status],
    ['Confirmed by', details.confirmedBy], ['Hotel phone', details.phone],
  ].filter(([, value]) => value);
  const table = (headings: string[], rows: Array<Array<string | number>>) => rows.length
    ? `<table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr>${headings.map((value) =>
        `<th scope="col" style="text-align:left;background:#f3e9fc;padding:8px;border:1px solid #e6dfee">${escapeHtml(value)}</th>`,
      ).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value) =>
        `<td style="padding:8px;border:1px solid #e6dfee">${escapeHtml(value)}</td>`,
      ).join('')}</tr>`).join('')}</tbody></table>`
    : '<p style="color:#5c5569">No details recorded.</p>';
  const policyHeaders = ['Before date', 'Cancellation charge'];
  const subject = `${siteTitle} - Hotel Voucher of Itinerary #${quote}${customerName ? ` (${customerName})` : ''}`
    .replace(/[\r\n]+/g, ' ');
  return {
    subject,
    text: [
      title, '', ...fields.map(([label, value]) => `${label}: ${value}`),
      ...(confirmationUrl ? ['', linkLabel + ': ' + confirmationUrl,
        'For payment or billing questions, please reply to this email.'] : []),
      '', 'Room category details', ...rooms.map((row) => roomHeaders.map((label, i) => `${label}: ${row[i]}`).join(' · ')),
      '', 'Cancellation policy', ...policies.map((row) => row.join(' · ')), '', 'DVi Travel',
    ].join('\n'),
    html: `<!doctype html><html lang="en"><meta charset="utf-8"><body style="margin:0;background:#f8f2fd;color:#1e1632;font:14px Arial,sans-serif">
      <main style="box-sizing:border-box;max-width:840px;margin:16px auto;background:white;border:1px solid #e6dfee;padding:24px">
      <p style="margin:0;color:#5f129e;font-weight:bold">DVi Travel</p>
      <h1 style="margin:8px 0 16px;font-size:24px">${title}</h1>
      ${table(['Booking details', ''], fields)}
      ${confirmationUrl ? `<p><a href="${escapeHtml(confirmationUrl)}">${linkLabel}</a>.
        For payment or billing questions, please reply to this email.</p>` : ''}
      <h2 style="color:#5f129e;font-size:16px">Room Category Details</h2>${table(roomHeaders, rooms)}
      <h2 style="color:#5f129e;font-size:16px">Cancellation Policy</h2>${table(policyHeaders, policies)}
      </main></body></html>`,
  };
}
