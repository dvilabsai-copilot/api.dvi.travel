export const TRANSPORT_VOUCHER_STYLES = `
  @page {
    size: A4;
    margin: 0;
  }

  :root {
    --primary: #3515d6;
    --primary-dark: #08005d;
    --border: #e4ddff;
    --soft: #faf9ff;
    --muted: #5f5a91;
    --success: #20a85a;
    --danger: #e53935;
  }

  * {
    box-sizing: border-box;
  }

  html, body {
    margin: 0;
    padding: 0;
    background: #fff;
    font-family: Arial, Helvetica, sans-serif;
    color: #08005d;
  }

  .voucher-page {
    width: 210mm;
    height: 297mm;
    padding: 5mm;
    box-sizing: border-box;
    background: #fff;
    overflow: hidden;
    display: grid;
    grid-template-rows: 36mm 17mm 56mm 46mm 77mm 34mm 5mm;
    row-gap: 0.45mm;
  }

  .voucher-header {
    height: 36mm;
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: 3mm;
    padding: 3mm 4mm;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 62mm 24mm;
    grid-template-rows: 1fr auto;
    column-gap: 4mm;
    background: linear-gradient(180deg, #ffffff 0%, #fbfaff 100%);
    box-shadow: 0 2px 8px rgba(53, 21, 214, 0.06);
  }

  .brand-block {
    display: flex;
    align-items: center;
    gap: 5mm;
    min-width: 0;
    overflow: hidden;
  }

  .brand-text {
    min-width: 0;
    flex: 1 1 auto;
    overflow: hidden;
  }

  .logo-area {
    width: 30mm;
    height: 20mm;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
  }

  .logo-area img {
    width: 100%;
    height: 100%;
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    object-position: center;
    display: block;
  }

  .dvi-logo-fallback {
    width: 100%;
    height: 100%;
    border-radius: 2mm;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, #ffffff 0%, #f3efff 100%);
    border: 1px solid var(--border);
  }

  .dvi-mark {
    font-size: 13px;
    letter-spacing: 0.2em;
    font-weight: 800;
    color: var(--primary);
    line-height: 1;
  }

  .dvi-sub {
    margin-top: 2mm;
    font-size: 8px;
    text-transform: lowercase;
    font-weight: 700;
    color: var(--primary-dark);
  }

  .brand-title {
    font-size: 25px;
    line-height: 1.02;
    font-weight: 900;
    color: var(--primary-dark);

    /*
      DVI's short title remains visually the same.

      Longer Agent company names can wrap to two lines
      instead of expanding the CSS grid and pushing the
      Transport Voucher / QR block outside the A4 page.
    */
    white-space: normal;
    overflow-wrap: break-word;
    word-break: normal;

    max-width: 100%;
    max-height: 46px;
    overflow: hidden;
  }

  .brand-tagline {
    margin-top: 2mm;
    font-size: 13px;
    font-weight: 600;
    color: var(--primary-dark);
  }

  .voucher-meta {
    align-self: start;
    min-width: 0;
    width: 100%;
    overflow: hidden;
  }

  .voucher-title {
    background: var(--primary);
    color: #fff;
    font-size: 15px;
    line-height: 1;
    font-weight: 800;
    padding: 2.8mm 4mm;
    border-radius: 1.5mm;
    text-align: center;
    margin-bottom: 3mm;
    white-space: nowrap;
  }

  .meta-row {
    display: grid;
    grid-template-columns: 22mm 1fr;
    font-size: 9.5px;
    margin-bottom: 1.5mm;
    color: var(--primary-dark);
    column-gap: 2mm;
  }

  .meta-row span {
    font-weight: 700;
  }

  .meta-row b {
    font-weight: 800;
    word-break: break-word;
  }

  .qr-box {
    min-width: 0;
    width: 100%;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 2mm;
    height: 26mm;
    text-align: center;
    font-size: 7px;
    padding: 1mm;
    display: flex;
    flex-direction: column;
    justify-content: center;
    background: rgba(255, 255, 255, 0.96);
  }

  .qr-image {
    width: 19mm;
    height: 19mm;
    margin: 0 auto 1mm;
    object-fit: contain;
  }

  .qr-placeholder {
    width: 19mm;
    height: 19mm;
    margin: 0 auto 1mm;
    border: 1px solid var(--border);
    border-radius: 1.5mm;
    background:
      radial-gradient(circle at 25% 25%, #111 0 1.2px, transparent 1.3px),
      radial-gradient(circle at 60% 45%, #111 0 1px, transparent 1.1px),
      radial-gradient(circle at 40% 70%, #111 0 1px, transparent 1.1px),
      #fff;
    background-size: 4px 4px;
  }

  .qr-caption {
    font-size: 8px;
    font-weight: 700;
    color: var(--primary-dark);
  }

  .contact-row {
    grid-column: 1 / 4;
    margin-top: 1.5mm;
    display: flex;
    gap: 5.5mm;
    font-size: 9.5px;
    font-weight: 700;
    color: var(--primary-dark);
    flex-wrap: wrap;

    min-width: 0;
    max-width: 100%;
    overflow: hidden;
  }

  .contact-item {
    white-space: nowrap;
  }

  .trust-strip {
    margin-top: 0;
    height: 17mm;
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: 2mm;
    display: grid;
    grid-template-columns: 1fr 1.4fr 1fr;
    align-items: center;
    padding: 0 4mm;
    background: #fff;
  }

  .trust-block {
    display: flex;
    align-items: center;
    gap: 3mm;
  }

  .align-right {
    justify-content: flex-end;
    text-align: right;
  }

  .trust-icon {
    width: 8mm;
    height: 8mm;
    border-radius: 50%;
    border: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 7px;
    font-weight: 800;
    color: var(--primary);
    background: var(--soft);
    flex: 0 0 auto;
  }

  .trust-icon.success {
    color: var(--success);
  }

  .trust-copy {
    font-size: 8.6px;
    line-height: 1.2;
    color: var(--muted);
  }

  .trip-summary {
    text-align: center;
    padding: 0 4mm;
  }

  .trip-title {
    font-size: 15px;
    font-weight: 800;
    color: var(--primary-dark);
    line-height: 1.1;
  }

  .trip-range {
    margin-top: 1.5mm;
    font-size: 9.5px;
    font-weight: 600;
    color: var(--primary);
  }

  .info-grid {
    height: 56mm;
    min-height: 0;
    display: grid;
    grid-template-columns: 1.15fr 1fr 0.9fr;
    gap: 0;
    border: 1px solid var(--border);
    border-radius: 3mm;
    overflow: hidden;
    background: #fff;
  }

  .info-card {
    padding: 3mm 3.8mm;
    border-right: 1px solid var(--border);
  }

  .info-card:last-child {
    border-right: 0;
  }

  .section-heading {
    font-size: 13px;
    font-weight: 800;
    color: var(--primary);
    margin-bottom: 2mm;
  }

  .detail-row {
    display: grid;
    grid-template-columns: 32mm 3mm 1fr;
    gap: 1mm;
    font-size: 10px;
    line-height: 1.15;
    margin-bottom: 2mm;
  }

  .detail-label {
    color: var(--primary-dark);
    font-weight: 800;
  }

  .detail-colon {
    font-weight: 700;
    text-align: center;
  }

  .detail-value {
    color: var(--primary-dark);
    font-weight: 700;
    word-break: break-word;
  }

  .flight-card .detail-row {
    grid-template-columns: 1fr;
  }

  .flight-stack {
    display: grid;
    gap: 1.8mm;
  }

  .flight-box {
    border: 1px solid var(--border);
    border-radius: 2mm;
    padding: 2.2mm 2.8mm;
    background: var(--soft);
  }

  .flight-title {
    font-size: 9.5px;
    font-weight: 800;
    color: var(--primary-dark);
    margin-bottom: 1.2mm;
    letter-spacing: 0.03em;
  }

  .flight-line {
    font-size: 8.8px;
    line-height: 1.2;
    color: var(--primary-dark);
    margin-bottom: 0.8mm;
  }

  .flight-line:last-child {
    margin-bottom: 0;
  }

  .flight-line.muted {
    color: var(--muted);
  }

  .vehicle-section {
    height: 46mm;
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: 3mm;
    padding: 3mm 4mm;
    background: #fff;
    overflow: hidden;
  }

  .vehicle-heading {
    margin-bottom: 2.1mm;
  }

  .vehicle-list {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2.4mm;
  }

  .vehicle-row {
    border: 1px solid var(--border);
    border-radius: 2mm;
    padding: 1.8mm;
    display: grid;
    grid-template-columns: 28mm 1fr;
    gap: 1.8mm;
    min-height: 29mm;
    background: #fff;
  }

  .vehicle-row .vehicle-image-panel {
    height: 23mm;
  }

  .vehicle-image-panel {
    height: 23mm;
    border: 1px solid var(--border);
    border-radius: 2.5mm;
    overflow: hidden;
    background: linear-gradient(135deg, #ffffff 0%, #f5f2ff 100%);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .vehicle-image-panel img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .vehicle-image-fallback {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--primary-dark);
  }

  .fallback-car-shape {
    width: 42mm;
    height: 10mm;
    border: 2px solid var(--primary);
    border-top-left-radius: 6mm;
    border-top-right-radius: 8mm;
    border-bottom-left-radius: 3mm;
    border-bottom-right-radius: 3mm;
    position: relative;
    background: rgba(53, 21, 214, 0.06);
    opacity: 0.75;
  }

  .fallback-car-shape::before,
  .fallback-car-shape::after {
    content: '';
    position: absolute;
    bottom: -4mm;
    width: 7mm;
    height: 7mm;
    border-radius: 50%;
    background: var(--primary-dark);
  }

  .fallback-car-shape::before {
    left: 5mm;
  }

  .fallback-car-shape::after {
    right: 5mm;
  }

  .vehicle-placeholder-subtitle {
    margin-top: 4mm;
    font-size: 9.5px;
    font-weight: 700;
    color: var(--muted);
  }

  .vehicle-summary-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2mm;
    align-content: start;
  }

  .vehicle-name {
    font-size: 11px;
    font-weight: 900;
    color: var(--primary-dark);
    margin-bottom: 1.5mm;
  }

  .vehicle-mini-line {
    font-size: 8.8px;
    line-height: 1.2;
    margin-bottom: 0.7mm;
    color: var(--primary-dark);
  }

  .vehicle-extra-note {
    margin-top: 1mm;
    font-size: 8px;
    font-weight: 700;
    color: var(--muted);
  }

  .itinerary-section {
    height: 77mm;
    min-height: 0;
    overflow: hidden;
    position: relative;
    z-index: 1;
  }

  .itinerary-title {
    height: 5.5mm;
    font-size: 13.5px;
    font-weight: 800;
    color: var(--primary);
    margin: 0;
  }

  .itinerary-table-wrap {
    height: 71.5mm;
    overflow: hidden;
  }

  .itinerary-table {
    width: 100%;
    height: 74mm;
    border-collapse: collapse;
    table-layout: fixed;
    border: 1px solid var(--border);
    border-radius: 2mm;
    overflow: hidden;
  }

  .itinerary-table thead {
    height: 7.2mm;
  }

  .itinerary-table tbody tr {
    height: 12.2mm;
  }

  .itinerary-table th {
    background: var(--primary);
    color: #fff;
    font-size: 9.2px;
    font-weight: 800;
    padding: 1.2mm 1mm;
    border: 1px solid var(--border);
  }

  .itinerary-table td {
    font-size: 9px;
    line-height: 1.15;
    padding: 1mm 1mm;
    border: 1px solid var(--border);
    vertical-align: top;
    overflow: hidden;
  }

  .day-badge {
    width: 10mm;
    height: 9mm;
    background: var(--primary);
    color: #fff;
    border-radius: 1.6mm;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    font-weight: 800;
    margin: auto;
  }

  .day-label {
    font-size: 5.8px;
    line-height: 1;
  }

  .day-number {
    font-size: 7.8px;
    line-height: 1;
  }

  .date-cell strong {
    display: block;
    font-size: 9px;
    margin-bottom: 0.45mm;
  }

  .date-cell span {
    font-size: 8px;
    color: var(--muted);
  }

  .route-text {
    max-height: 10mm;
    overflow: hidden;
    word-break: break-word;
  }

  .time-cell {
    text-align: center;
    font-weight: 700;
  }

  .footer-grid {
    height: 34mm;
    min-height: 0;
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 3mm;
    position: static !important;
    left: auto !important;
    right: auto !important;
    bottom: auto !important;
    z-index: 1;
  }

  .footer-card {
    border: 1px solid var(--border);
    border-radius: 2.5mm;
    padding: 2.5mm;
    overflow: hidden;
    background: #fff;
    box-shadow: 0 2px 6px rgba(53, 21, 214, 0.04);
  }

  .footer-title {
    font-size: 11px;
    font-weight: 800;
    margin-bottom: 1.6mm;
    color: var(--primary);
  }

  .footer-list {
    margin: 0;
    padding-left: 4mm;
  }

  .footer-list li {
    font-size: 8.4px;
    line-height: 1.18;
    margin-bottom: 1mm;
    color: var(--primary-dark);
  }

  .footer-list li:last-child {
    margin-bottom: 0;
  }

  .footer-inclusions {
    background: #f8fff9;
  }

  .footer-inclusions .footer-title {
    color: var(--success);
  }

  .footer-notes {
    background: var(--soft);
  }

  .footer-emergency {
    background: #fff7f7;
  }

  .footer-emergency .footer-title {
    color: var(--danger);
  }

  .thank-you {
    height: 5mm;
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: 2mm;
    background: var(--soft);
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    font-size: 8.8px;
    font-style: italic;
    color: var(--primary-dark);
    position: static !important;
    z-index: 1;
  }


  /*
    TRANSPORT_VOUCHER_READABLE_TEXT_V2

    Final readability pass.
    Keep existing A4 layout and section dimensions,
    but make printed text substantially easier to read.
  */

  .brand-title {
    font-size: 25px !important;
    line-height: 1.02 !important;
  }

  .brand-tagline {
    font-size: 13px !important;
    line-height: 1.15 !important;
  }

  .voucher-title {
    font-size: 15px !important;
  }

  .meta-row {
    font-size: 10px !important;
    line-height: 1.2 !important;
  }

  .qr-caption {
    font-size: 8px !important;
  }

  .contact-row {
    font-size: 10px !important;
    line-height: 1.2 !important;
  }

  .trust-icon {
    font-size: 7px !important;
  }

  .trust-copy {
    font-size: 8.8px !important;
    line-height: 1.25 !important;
  }

  .trip-title {
    font-size: 15px !important;
    line-height: 1.12 !important;
  }

  .trip-range {
    font-size: 9.5px !important;
  }

  .section-heading {
    font-size: 13.5px !important;
    line-height: 1.15 !important;
  }

  .detail-row {
    font-size: 10.5px !important;
    line-height: 1.18 !important;
    margin-bottom: 1.7mm !important;
  }

  .detail-label,
  .detail-value,
  .detail-colon {
    font-size: 10.5px !important;
  }

  .flight-title {
    font-size: 10px !important;
  }

  .flight-line {
    font-size: 9px !important;
    line-height: 1.25 !important;
  }

  .vehicle-name {
    font-size: 11.5px !important;
    line-height: 1.1 !important;
  }

  .vehicle-mini-line {
    font-size: 9px !important;
    line-height: 1.22 !important;
  }

  .vehicle-extra-note {
    font-size: 8.5px !important;
  }

  .itinerary-title {
    font-size: 14px !important;
    line-height: 1.1 !important;
  }

  .itinerary-table th {
    font-size: 9px !important;
    line-height: 1.15 !important;
  }

  .itinerary-table td {
    font-size: 8.8px !important;
    line-height: 1.18 !important;
  }

  .date-cell strong {
    font-size: 9px !important;
  }

  .date-cell span {
    font-size: 8px !important;
  }

  .day-label {
    font-size: 5.5px !important;
  }

  .day-number {
    font-size: 8px !important;
  }

  .footer-title {
    font-size: 11.5px !important;
    line-height: 1.1 !important;
  }

  .footer-list li {
    font-size: 8.5px !important;
    line-height: 1.25 !important;
    margin-bottom: 0.8mm !important;
  }

  .thank-you {
    font-size: 9px !important;
    line-height: 1.15 !important;
  }


  /*
   * TRANSPORT_VOUCHER_REFERENCE_UI_V3
   *
   * Final approved Transport Voucher presentation:
   * - proper logo
   * - readable bold typography
   * - full-width single vehicle card
   * - same A4 structure
   */

  html,
  body {
    font-weight: 600;
  }


  /* ========================================================
     HEADER
     ======================================================== */

  .voucher-header {
    grid-template-columns:
      minmax(0, 1fr)
      62mm
      24mm !important;

    column-gap: 3mm !important;
  }

  .brand-block {
    min-width: 0 !important;
    overflow: hidden !important;
    gap: 4mm !important;
  }

  .logo-area {
    width: 31mm !important;
    height: 23mm !important;
    min-width: 31mm !important;
    flex: 0 0 31mm !important;
  }

  .logo-area img {
    width: 100% !important;
    height: 100% !important;
    max-width: 100% !important;
    max-height: 100% !important;

    object-fit: contain !important;
    object-position: center !important;

    display: block !important;
  }

  .brand-text {
    min-width: 0 !important;
    flex: 1 1 auto !important;
    overflow: hidden !important;
  }

  .brand-title {
    font-size: 22px !important;
    line-height: 1.02 !important;
    font-weight: 900 !important;

    white-space: normal !important;
    overflow-wrap: normal !important;
    word-break: normal !important;

    max-width: 100% !important;
    max-height: 64px !important;
    overflow: hidden !important;
  }

  .brand-tagline {
    margin-top: 1.2mm !important;
    font-size: 12px !important;
    line-height: 1.1 !important;
    font-weight: 800 !important;
  }

  .voucher-title {
    font-size: 15px !important;
    font-weight: 900 !important;
  }

  .meta-row {
    font-size: 10px !important;
    line-height: 1.2 !important;
    font-weight: 700 !important;
  }

  .meta-row span,
  .meta-row b {
    font-weight: 800 !important;
  }

  .qr-caption {
    font-size: 8px !important;
    font-weight: 800 !important;
  }

  .contact-row {
    font-size: 10px !important;
    line-height: 1.15 !important;
    font-weight: 800 !important;

    max-width: 100% !important;
    overflow: hidden !important;
  }


  /* ========================================================
     CONFIRMED / TRUST BAR
     ======================================================== */

  .trust-icon {
    font-size: 7px !important;
    font-weight: 900 !important;
  }

  .trust-copy {
    font-size: 9px !important;
    line-height: 1.18 !important;
    font-weight: 700 !important;
  }

  .trust-copy strong {
    font-weight: 900 !important;
  }

  .trip-title {
    font-size: 15px !important;
    line-height: 1.05 !important;
    font-weight: 900 !important;
  }

  .trip-range {
    font-size: 9.5px !important;
    line-height: 1.1 !important;
    font-weight: 800 !important;
  }


  /* ========================================================
     GUEST / TRIP / FLIGHT
     ======================================================== */

  .section-heading {
    font-size: 14px !important;
    line-height: 1.1 !important;
    font-weight: 900 !important;
    margin-bottom: 2.2mm !important;
  }

  .info-card {
    padding:
      3mm
      3.5mm !important;
  }

  .detail-row {
    grid-template-columns:
      31mm
      3mm
      minmax(0, 1fr) !important;

    font-size: 11px !important;
    line-height: 1.12 !important;

    margin-bottom: 1.55mm !important;
  }

  .detail-label {
    font-size: 11px !important;
    font-weight: 900 !important;
  }

  .detail-colon {
    font-size: 11px !important;
    font-weight: 900 !important;
  }

  .detail-value {
    font-size: 11px !important;
    line-height: 1.12 !important;
    font-weight: 800 !important;
  }

  .flight-box {
    padding:
      2.3mm
      2.8mm !important;
  }

  .flight-title {
    font-size: 10.5px !important;
    line-height: 1.1 !important;
    font-weight: 900 !important;
  }

  .flight-line {
    font-size: 9.5px !important;
    line-height: 1.2 !important;
    font-weight: 700 !important;
  }


  /* ========================================================
     VEHICLE DETAILS
     ======================================================== */

  .vehicle-section {
    padding:
      3mm
      4mm !important;
  }

  .vehicle-heading {
    margin-bottom: 2mm !important;
  }

  /*
   * One vehicle must use the entire available width,
   * matching the approved reference.
   *
   * If there are two vehicles they can still sit side-by-side.
   */
  .vehicle-list {
    grid-template-columns:
      repeat(2, minmax(0, 1fr)) !important;

    gap: 2.5mm !important;
  }

  .vehicle-list > .vehicle-row:only-child {
    grid-column:
      1 / -1 !important;
  }

  /*
   * Template has no vehicle image cell here.
   * Remove the old 28mm phantom column which was squeezing
   * all vehicle information into the tiny marked area.
   */
  .vehicle-row {
    display: grid !important;

    grid-template-columns:
      minmax(0, 1fr) !important;

    width: 100% !important;

    padding:
      2.5mm
      3mm !important;

    min-height: 29mm !important;
  }

  .vehicle-summary-grid {
    display: grid !important;

    grid-template-columns:
      minmax(0, 1fr)
      minmax(0, 1fr) !important;

    gap:
      1.5mm
      8mm !important;

    width: 100% !important;
    max-width: 100% !important;
  }

  .vehicle-summary {
    min-width: 0 !important;
  }

  .vehicle-name {
    font-size: 12.5px !important;
    line-height: 1.05 !important;
    font-weight: 900 !important;

    margin-bottom:
      1.5mm !important;
  }

  .vehicle-mini-line {
    font-size: 10.2px !important;
    line-height: 1.15 !important;
    font-weight: 700 !important;

    margin-bottom:
      0.75mm !important;
  }

  .vehicle-extra-note {
    font-size: 9px !important;
    font-weight: 800 !important;
  }


  /* ========================================================
     DAY-WISE TRANSPORT ITINERARY
     ======================================================== */

  .itinerary-title {
    font-size: 14.5px !important;
    line-height: 1.05 !important;
    font-weight: 900 !important;
  }

  .itinerary-table th {
    font-size: 9.8px !important;
    line-height: 1.1 !important;
    font-weight: 900 !important;

    padding:
      1mm
      0.8mm !important;
  }

  .itinerary-table td {
    font-size: 9.3px !important;
    line-height: 1.12 !important;
    font-weight: 700 !important;

    padding:
      0.9mm
      0.9mm !important;
  }

  .day-label {
    font-size: 5.8px !important;
    font-weight: 900 !important;
  }

  .day-number {
    font-size: 8px !important;
    font-weight: 900 !important;
  }

  .date-cell strong {
    font-size: 9.7px !important;
    line-height: 1.05 !important;
    font-weight: 900 !important;
  }

  .date-cell span {
    font-size: 8.2px !important;
    line-height: 1.05 !important;
    font-weight: 700 !important;
  }

  .route-text {
    font-size: 9.3px !important;
    line-height: 1.12 !important;

    max-height: 10.8mm !important;
  }

  .time-cell {
    font-size: 9.5px !important;
    font-weight: 900 !important;
  }


  /* ========================================================
     FOOTER CARDS
     ======================================================== */

  .footer-card {
    padding:
      2.4mm
      2.7mm !important;
  }

  .footer-title {
    font-size: 11.5px !important;
    line-height: 1.05 !important;
    font-weight: 900 !important;
  }

  .footer-list li {
    font-size: 9px !important;
    line-height: 1.16 !important;
    font-weight: 700 !important;

    margin-bottom:
      0.65mm !important;
  }

  .thank-you {
    font-size: 9.5px !important;
    line-height: 1.1 !important;
    font-weight: 800 !important;
  }

`;
