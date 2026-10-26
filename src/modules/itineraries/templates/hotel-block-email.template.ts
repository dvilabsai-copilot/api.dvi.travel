export type HotelBlockEmailTemplateInput = {
  quotationReference: string;
  hotelName: string;
  provider: string;
  checkIn: string;
  checkOut: string;
  roomType: string;
  mealPlan: string;
  roomCount: number;
  responseUrl: string;
  demoMode: boolean;
  intendedRecipient: string;
  emailKind?: 'REQUEST' | 'EXTENSION' | 'CANCELLATION' | 'REMINDER';
  previousCutoffAt?: string;
  cutoffAt?: string;
  itineraryUrl?: string;
  stayDetails?: Array<{
    checkIn: string;
    checkOut: string;
    roomType: string;
    mealPlan: string;
    roomCount: number;
  }>;
};

const escapeHtml = (value: unknown) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

const detailRow = (label: string, value: string) => `
  <tr>
    <th align="left" style="padding:10px;border:1px solid #eadcfb;background:#faf7ff;color:#4a4260;font-size:13px;">${escapeHtml(label)}</th>
    <td style="padding:10px;border:1px solid #eadcfb;color:#342d42;font-size:13px;">${escapeHtml(value)}</td>
  </tr>`;

const stayDetailRow = (detail: NonNullable<HotelBlockEmailTemplateInput['stayDetails']>[number]) => `
  <tr>
    <td style="padding:9px;border:1px solid #eadcfb;color:#342d42;font-size:12px;">${escapeHtml(detail.checkIn)}${detail.checkOut && detail.checkOut !== detail.checkIn ? ` – ${escapeHtml(detail.checkOut)}` : ''}</td>
    <td style="padding:9px;border:1px solid #eadcfb;color:#342d42;font-size:12px;">${escapeHtml(detail.roomType)}</td>
    <td style="padding:9px;border:1px solid #eadcfb;color:#342d42;font-size:12px;">${escapeHtml(detail.mealPlan)}</td>
    <td style="padding:9px;border:1px solid #eadcfb;color:#342d42;font-size:12px;text-align:center;">${escapeHtml(String(detail.roomCount || 0))}</td>
  </tr>`;

export function renderHotelBlockEmailHtml(input: HotelBlockEmailTemplateInput) {
  const isExtension = input.emailKind === 'EXTENSION';
  const isCancellation = input.emailKind === 'CANCELLATION';
  const isReminder = input.emailKind === 'REMINDER';
  const stayDetails = input.stayDetails || [];
  const demoNotice = input.demoMode
    ? `
      <div style="margin:0 0 20px;padding:14px 16px;border:1px solid #f4c46b;border-radius:10px;background:#fff8e8;color:#795400;font-size:13px;line-height:1.6;">
        <strong>Demo delivery</strong><br>
        This email is being delivered to the configured demo inbox instead of the ${isReminder ? 'intended recipient' : 'hotelier'}.<br>
        Intended ${isReminder ? 'recipient' : 'hotelier email'}: <a href="mailto:${escapeHtml(input.intendedRecipient)}" style="color:#5c24e5;">${escapeHtml(input.intendedRecipient)}</a><br>
        The intended ${isReminder ? 'recipient' : 'hotelier'} has not been contacted while demo mode is enabled.
      </div>`
    : '';

  const responseAction = input.responseUrl && !isCancellation && !isReminder
    ? `
      <div style="margin:24px 0 4px;text-align:center;">
        <a href="${escapeHtml(input.responseUrl)}" style="display:inline-block;padding:12px 22px;border-radius:8px;background:#5c24e5;color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;">
          ${isExtension ? 'Review Updated Hold' : 'Review &amp; Respond to Hotel Request'}
        </a>
      </div>
      <p style="margin:12px 0 0;text-align:center;font-size:12px;color:#888888;line-height:1.5;">
        Use the secure link above to confirm availability, cutoff and booking status.
      </p>`
    : '';

  const itineraryAction = input.itineraryUrl && isReminder
    ? `
      <div style="margin:24px 0 4px;text-align:center;">
        <a href="${escapeHtml(input.itineraryUrl)}" style="display:inline-block;padding:12px 22px;border-radius:8px;background:#5c24e5;color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;">
          Open Itinerary &amp; Confirm Hotel
        </a>
      </div>
      <p style="margin:12px 0 0;text-align:center;font-size:12px;color:#888888;line-height:1.5;">
        The itinerary opens the hotel confirmation window.
      </p>`
    : '';

  const heading = isReminder
    ? 'Hotel Hold Expires in 24 Hours'
    : isCancellation
      ? 'Hotel Hold No Longer Required'
      : isExtension
        ? 'Hotel Hold Extended'
        : 'Hotel Blocking Request';
  const intro = isReminder
    ? 'This blocked hotel hold will expire in 24 hours. Please review the itinerary and confirm the hotel before the cutoff.'
    : isCancellation
      ? 'The hotel selection for this quotation has changed. Please release or ignore any rooms associated with the previous hold; no further blocking action is required for this request.'
      : isExtension
        ? 'The hotel hold has been extended. Please retain the rooms until the updated hold time below.'
        : 'Please review the requested stay and confirm whether the rooms can be blocked.';

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px 12px;background:#f5f3ff;font-family:Arial,sans-serif;color:#342d42;">
    <div style="max-width:720px;margin:0 auto;">
      <div style="padding:10px 4px 18px;text-align:center;color:#5c24e5;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">
        DVi Travel · Holidays for Everyone
      </div>
      <div style="padding:26px;border:1px solid #eadcfb;border-radius:16px;background:#ffffff;box-shadow:0 4px 14px rgba(92,36,229,.08);">
        <h1 style="margin:0 0 8px;color:#1e1b4b;font-size:22px;">${heading}</h1>
        <p style="margin:0 0 22px;color:#6c6c6c;font-size:14px;line-height:1.6;">
          ${intro}
        </p>
        ${demoNotice}
        <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin-bottom:22px;">
          ${detailRow('Quotation Number', input.quotationReference)}
          ${detailRow('Hotel', input.hotelName)}
          ${detailRow('Provider', input.provider)}
          ${detailRow('Check-in', input.checkIn)}
          ${detailRow('Check-out', input.checkOut)}
          ${detailRow('Rooms', String(input.roomCount || 0))}
          ${detailRow('Room category', input.roomType)}
          ${detailRow('Meal plan', input.mealPlan)}
          ${isExtension ? detailRow('Previous hold until', input.previousCutoffAt || '--') : ''}
          ${isExtension ? detailRow('New hold until', input.cutoffAt || '--') : ''}
          ${isReminder ? detailRow('Hold expires', input.cutoffAt || '--') : ''}
        </table>
        ${stayDetails.length > 1 ? `
          <h2 style="margin:0 0 10px;color:#1e1b4b;font-size:15px;">Nightly stay details</h2>
          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin-bottom:22px;">
            <tr>
              <th align="left" style="padding:9px;border:1px solid #eadcfb;background:#faf7ff;color:#4a4260;font-size:12px;">Stay dates</th>
              <th align="left" style="padding:9px;border:1px solid #eadcfb;background:#faf7ff;color:#4a4260;font-size:12px;">Room category</th>
              <th align="left" style="padding:9px;border:1px solid #eadcfb;background:#faf7ff;color:#4a4260;font-size:12px;">Meal plan</th>
              <th align="center" style="padding:9px;border:1px solid #eadcfb;background:#faf7ff;color:#4a4260;font-size:12px;">Rooms</th>
            </tr>
            ${stayDetails.map(stayDetailRow).join('')}
          </table>` : ''}
        ${responseAction}
        ${itineraryAction}
        <div style="margin-top:26px;padding-top:16px;border-top:1px solid #eee6fa;color:#777;font-size:12px;line-height:1.6;">
          Regards,<br>
          <strong style="color:#4a4260;">DVi Travel Operations</strong><br>
          ${isReminder ? 'This is an automated hotel hold expiry reminder.' : isCancellation ? 'This is an automated hotel hold cancellation notice.' : 'This is an automated hotel blocking request.'}
        </div>
      </div>
    </div>
  </body>
</html>`;
}
