import { TransportVoucherDetails } from '../dto/transport-voucher-details.dto';
import { TRANSPORT_VOUCHER_STYLES } from './transport-voucher.styles';

type TransportVoucherRenderAssets = {
  logoDataUri?: string | null;
  vehicleImageDataUri?: string | null;
  qrDataUri?: string | null;
};

function decodeHtmlEntities(value: unknown): string {
  return String(value ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&ndash;/g, '-')
    .replace(/&mdash;/g, '-');
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function safeText(value: unknown): string {
  return escapeHtml(decodeHtmlEntities(value));
}

function truncateWithEllipsis(value: unknown, maxLength: number): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '--';
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...` : text;
}

function shortLocationName(value: unknown): string {
  return String(value ?? '')
    .replace(/Cochin International Airport/gi, 'Cochin Airport')
    .replace(/Kochi International Airport/gi, 'Kochi Airport')
    .replace(/Cochin Airport Terminal [^,|-]+/gi, 'Cochin Airport')
    .replace(/\s+/g, ' ')
    .trim();
}

function renderDetailRow(label: string, value: unknown): string {
  return `
    <div class="detail-row">
      <span class="detail-label">${safeText(label)}</span>
      <span class="detail-colon">:</span>
      <span class="detail-value">${safeText(value || '--')}</span>
    </div>
  `;
}

function renderFlightSection(label: string, flight: TransportVoucherDetails['flight']['arrival']): string {
  const notProvided =
    (!flight.airline || flight.airline === 'Not Provided')
    && (!flight.flightNo || flight.flightNo === 'Not Provided')
    && (!flight.rawText || flight.rawText === 'Not Provided');

  const content = notProvided
    ? `<div class="flight-line muted">Flight details not provided</div>`
    : [
        truncateWithEllipsis(`${flight.airline || 'Not Provided'} | ${flight.flightNo || 'Not Provided'}`, 72),
        truncateWithEllipsis(`${flight.from || 'Not Provided'} | ${flight.to || 'Not Provided'}`, 72),
        truncateWithEllipsis(`${flight.date || '--'} | ${flight.time || 'Not Provided'}`, 72),
      ]
        .map((line) => `<div class="flight-line">${safeText(line)}</div>`)
        .join('');

  return `
    <div class="flight-box">
      <div class="flight-title">${safeText(label)}</div>
      ${content}
    </div>
  `;
}

export function renderTransportVoucherHtml(
  data: TransportVoucherDetails,
  assets: TransportVoucherRenderAssets = {},
): string {
  const brandTitle = 'DVI Holidays';
  const brandTagline = 'Travel Beyond Expectations';
  const companyPhone = data.company.phone || '+91 8921 77 66 88';
  const companyEmail = data.company.email || 'partner.support@dviholidays.com';
  const companyWebsite = data.company.website || 'www.dviholidays.com';
  const vehicleType = truncateWithEllipsis(data.vehicle.type || 'Vehicle', 44);
 const compactTravelRegion = shortLocationName(data.trip.travelRegion).replace(/\s*-\s*/g, ' - ');
  const vehicles = Array.isArray(data.vehicles) && data.vehicles.length
    ? data.vehicles
    : [data.vehicle].filter(Boolean);
  const visibleVehicles = vehicles.slice(0, 2);
  const extraVehicleCount = Math.max(0, vehicles.length - visibleVehicles.length);

  const tableRows = data.days
    .map((day) => `
      <tr>
        <td>
          <div class="day-badge">
            <span class="day-label">DAY</span>
            <span class="day-number">${safeText(day.dayNo)}</span>
          </div>
        </td>
        <td class="date-cell">
          <strong>${safeText(day.date)}</strong>
          <span>(${safeText(day.weekday)})</span>
        </td>
        <td><div class="route-text">${safeText(truncateWithEllipsis(day.routeAndPlaces, 145))}</div></td>
        <td><div class="route-text">${safeText(truncateWithEllipsis(shortLocationName(day.travelRoute), 95))}</div></td>
        <td class="time-cell">${safeText(day.startTime || '--')}</td>
        <td class="time-cell">${safeText(day.endTime || '--')}</td>
      </tr>
    `)
    .join('');

  const renderFooterList = (items: string[]) =>
    items
      .map((item) => `<li>${safeText(truncateWithEllipsis(item, 62))}</li>`)
      .join('');

  const renderVehicleCard = (vehicle: TransportVoucherDetails['vehicles'][number]) => `
    <div class="vehicle-row">
      <div class="vehicle-image-panel">
        ${
          assets.vehicleImageDataUri
            ? `<img src="${assets.vehicleImageDataUri}" alt="${safeText(vehicle.type || 'Vehicle')}">`
            : `<div class="vehicle-image-fallback"><div class="fallback-car-shape"></div><div class="vehicle-placeholder-subtitle">${safeText(truncateWithEllipsis(vehicle.type || vehicleType, 30))}</div></div>`
        }
      </div>
      <div class="vehicle-summary-grid">
        <div class="vehicle-summary">
          <div class="vehicle-name">${safeText(truncateWithEllipsis(vehicle.type, 28))}</div>
          <div class="vehicle-mini-line">Vehicle No.: ${safeText(truncateWithEllipsis(vehicle.vehicleNo, 24))}</div>
          <div class="vehicle-mini-line">Seating: ${safeText(truncateWithEllipsis(vehicle.seatingCapacity, 22))}</div>
          ${vehicle.vendorName ? `<div class="vehicle-mini-line">Vendor: ${safeText(truncateWithEllipsis(vehicle.vendorName, 26))}</div>` : ''}
        </div>
        <div class="vehicle-summary">
          <div class="vehicle-mini-line">AC: ${safeText(truncateWithEllipsis(vehicle.ac, 12))}</div>
          <div class="vehicle-mini-line">Luggage: ${safeText(truncateWithEllipsis(vehicle.luggageSpace, 18))}</div>
          <div class="vehicle-mini-line">Insurance: ${safeText(truncateWithEllipsis(vehicle.insurance, 24))}</div>
          ${vehicle.qty && vehicle.qty > 1 ? `<div class="vehicle-mini-line">Qty: ${safeText(vehicle.qty)}</div>` : ''}
        </div>
      </div>
    </div>
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Transport Voucher - DVI Holidays</title>
  <style>${TRANSPORT_VOUCHER_STYLES}</style>
</head>
<body>
  <div class="voucher-page">
    <header class="voucher-header">
      <div class="brand-block">
        <div class="logo-area">
        ${
          assets.logoDataUri
            ? `<img src="${assets.logoDataUri}" alt="DVI Holidays Logo">`
            : `<div class="dvi-logo-fallback"><div class="dvi-mark">D V i</div><div class="dvi-sub">holidays</div></div>`
        }
        </div>
        <div class="brand-text">
          <div class="brand-title">${brandTitle}</div>
          <div class="brand-tagline">${brandTagline}</div>
        </div>
      </div>

      <div class="voucher-meta">
        <div class="voucher-title">TRANSPORT VOUCHER</div>
        <div class="meta-row"><span>Voucher No.</span><b>${safeText(data.voucher.voucherNo || '--')}</b></div>
        <div class="meta-row"><span>Date</span><b>${safeText(data.voucher.date || '--')}</b></div>
      </div>

      <div class="qr-box">
        ${
          assets.qrDataUri
            ? `<img class="qr-image" src="${assets.qrDataUri}" alt="QR Code">`
            : `<div class="qr-placeholder"></div>`
        }
        <div class="qr-caption">Scan for Assistance</div>
      </div>
      <div class="contact-row">
        <span class="contact-item">&#9742; ${safeText(companyPhone)}</span>
        <span class="contact-item">&#9993; ${safeText(companyEmail)}</span>
        <span class="contact-item">&#127760; ${safeText(companyWebsite)}</span>
      </div>
    </header>

    <section class="trust-strip">
      <div class="trust-block">
        <div class="trust-icon">SAFE</div>
        <div class="trust-copy">This voucher is valid only for the booking and travel dates mentioned.</div>
      </div>
      <div class="trip-summary">
        <div class="trip-title">${safeText(data.voucher.title || 'Trip')}</div>
        <div class="trip-range">${safeText(data.voucher.dateRange || '--')}</div>
      </div>
      <div class="trust-block align-right">
        <div class="trust-icon success">OK</div>
        <div class="trust-copy"><strong>Verified &amp; Trusted</strong><br>Thank you for choosing DVI Holidays</div>
      </div>
    </section>

    <section class="info-grid">
      <div class="info-card">
        <div class="section-heading">Guest Details</div>
        ${renderDetailRow('Guest Name', truncateWithEllipsis(data.guest.name, 72))}
        ${renderDetailRow('No. of Pax', truncateWithEllipsis(data.guest.pax, 40))}
        ${renderDetailRow('Contact Number', truncateWithEllipsis(data.guest.contactNo, 50))}
        ${renderDetailRow('Email ID', truncateWithEllipsis(data.guest.email, 50))}
        ${renderDetailRow('Pickup Location', truncateWithEllipsis(shortLocationName(data.guest.pickupLocation), 60))}
        ${renderDetailRow('Drop Location', truncateWithEllipsis(shortLocationName(data.guest.dropLocation), 60))}
      </div>

      <div class="info-card">
        <div class="section-heading">Trip Details</div>
        ${renderDetailRow('Tour Type', truncateWithEllipsis(data.trip.tourType, 34))}
        ${renderDetailRow('Travel Region', truncateWithEllipsis(compactTravelRegion, 55))}
        ${renderDetailRow('Check-in Date', truncateWithEllipsis(data.trip.checkInDate, 30))}
        ${renderDetailRow('Check-out Date', truncateWithEllipsis(data.trip.checkOutDate, 30))}
        ${renderDetailRow('Total Duration', truncateWithEllipsis(data.trip.duration, 34))}
        ${data.trip.earlyArrivalPreferenceMessage ? renderDetailRow('Early arrival', truncateWithEllipsis(data.trip.earlyArrivalPreferenceMessage, 34)) : ''}
      </div>

      <div class="info-card flight-card">
        <div class="section-heading">Flight Details</div>
        <div class="flight-stack">
          ${renderFlightSection('Arrival Flight', data.flight.arrival)}
          ${renderFlightSection('Departure Flight', data.flight.departure)}
        </div>
      </div>
    </section>

    <section class="vehicle-section">
      <div class="section-heading vehicle-heading">Vehicle Details</div>
      <div class="vehicle-list">
        ${visibleVehicles.map(renderVehicleCard).join('')}
      </div>
      ${extraVehicleCount > 0 ? `<div class="vehicle-extra-note">+${safeText(extraVehicleCount)} more vehicle confirmed</div>` : ''}
    </section>

    <section class="itinerary-section">
      <div class="itinerary-title">Day-wise Transport Itinerary</div>
      <div class="itinerary-table-wrap">
        <table class="itinerary-table">
          <colgroup>
            <col style="width: 9%">
            <col style="width: 13%">
            <col style="width: 35%">
            <col style="width: 25%">
            <col style="width: 10%">
            <col style="width: 8%">
          </colgroup>
          <thead>
            <tr>
              <th>Day</th>
              <th>Date</th>
              <th>Route &amp; Places to Visit</th>
              <th>Travel Route</th>
              <th>Start Time</th>
              <th>End Time</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>
      </div>
    </section>

    <section class="footer-grid">
      <div class="footer-card footer-inclusions">
        <div class="footer-title">&#10003; Inclusions</div>
        <ul class="footer-list">${renderFooterList(data.footer.inclusions || [])}</ul>
      </div>
      <div class="footer-card footer-notes">
        <div class="footer-title">&#9432; Important Notes</div>
        <ul class="footer-list">${renderFooterList(data.footer.notes || [])}</ul>
      </div>
      <div class="footer-card footer-emergency">
        <div class="footer-title">&#9742; Emergency Contact</div>
        <ul class="footer-list">
          <li>${safeText(`Customer Support: ${data.footer.emergencyPhone || '--'}`)}</li>
          <li>${safeText(`Email: ${data.footer.emergencyEmail || '--'}`)}</li>
        </ul>
      </div>
    </section>

    <div class="thank-you">Thank you for choosing DVI Holidays. We wish you a safe &amp; memorable journey!</div>
  </div>
</body>
</html>`;
}
