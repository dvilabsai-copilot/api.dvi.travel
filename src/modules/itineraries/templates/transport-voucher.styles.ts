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
    grid-template-rows: 36mm 18mm 58mm 48mm 80mm 36mm 6mm;
    row-gap: 0.45mm;
  }

  .voucher-header {
    height: 36mm;
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: 3mm;
    padding: 3mm 4mm;
    display: grid;
    grid-template-columns: 1fr 62mm 24mm;
    grid-template-rows: 1fr auto;
    column-gap: 4mm;
    background: linear-gradient(180deg, #ffffff 0%, #fbfaff 100%);
    box-shadow: 0 2px 8px rgba(53, 21, 214, 0.06);
  }

  .brand-block {
    display: flex;
    align-items: center;
    gap: 5mm;
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
    object-fit: contain;
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
    line-height: 1;
    font-weight: 900;
    color: var(--primary-dark);
  }

  .brand-tagline {
    margin-top: 2mm;
    font-size: 11px;
    font-weight: 600;
    color: var(--primary-dark);
  }

  .voucher-meta {
    align-self: start;
  }

  .voucher-title {
    background: var(--primary);
    color: #fff;
    font-size: 15px;
    line-height: 1;
    font-weight: 800;
    padding: 3mm 4mm;
    border-radius: 1.5mm;
    text-align: center;
    margin-bottom: 3mm;
  }

  .meta-row {
    display: grid;
    grid-template-columns: 22mm 1fr;
    font-size: 8.5px;
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
    border: 1px solid var(--border);
    border-radius: 2mm;
    height: 24mm;
    text-align: center;
    font-size: 7px;
    padding: 1mm;
    display: flex;
    flex-direction: column;
    justify-content: center;
    background: rgba(255, 255, 255, 0.96);
  }

  .qr-image {
    width: 20mm;
    height: 20mm;
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
    font-size: 6.5px;
    font-weight: 700;
    color: var(--primary-dark);
  }

  .contact-row {
    grid-column: 1 / 4;
    margin-top: 1.5mm;
    display: flex;
    gap: 7mm;
    font-size: 8.2px;
    font-weight: 700;
    color: var(--primary-dark);
    flex-wrap: wrap;
  }

  .contact-item {
    white-space: nowrap;
  }

  .trust-strip {
    margin-top: 0;
    height: 18mm;
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
    font-size: 5.8px;
    font-weight: 800;
    color: var(--primary);
    background: var(--soft);
    flex: 0 0 auto;
  }

  .trust-icon.success {
    color: var(--success);
  }

  .trust-copy {
    font-size: 7px;
    line-height: 1.2;
    color: var(--muted);
  }

  .trip-summary {
    text-align: center;
    padding: 0 4mm;
  }

  .trip-title {
    font-size: 13px;
    font-weight: 800;
    color: var(--primary-dark);
    line-height: 1.1;
  }

  .trip-range {
    margin-top: 1.5mm;
    font-size: 8px;
    font-weight: 600;
    color: var(--primary);
  }

  .info-grid {
    height: 58mm;
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
    padding: 3.4mm 4mm;
    border-right: 1px solid var(--border);
  }

  .info-card:last-child {
    border-right: 0;
  }

  .section-heading {
    font-size: 11px;
    font-weight: 800;
    color: var(--primary);
    margin-bottom: 2.4mm;
  }

  .detail-row {
    display: grid;
    grid-template-columns: 32mm 3mm 1fr;
    gap: 1mm;
    font-size: 8px;
    line-height: 1.18;
    margin-bottom: 2.4mm;
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
    gap: 2.2mm;
  }

  .flight-box {
    border: 1px solid var(--border);
    border-radius: 2mm;
    padding: 2.6mm 3mm;
    background: var(--soft);
  }

  .flight-title {
    font-size: 7.5px;
    font-weight: 800;
    color: var(--primary-dark);
    margin-bottom: 1.2mm;
    letter-spacing: 0.03em;
  }

  .flight-line {
    font-size: 7.2px;
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
    height: 48mm;
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: 3mm;
    padding: 3mm 4mm;
    background: #fff;
    overflow: hidden;
  }

  .vehicle-heading {
    margin-bottom: 2.5mm;
  }

  .vehicle-list {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 3mm;
  }

  .vehicle-row {
    border: 1px solid var(--border);
    border-radius: 2mm;
    padding: 2mm;
    display: grid;
    grid-template-columns: 28mm 1fr;
    gap: 2mm;
    min-height: 31mm;
    background: #fff;
  }

  .vehicle-row .vehicle-image-panel {
    height: 25mm;
  }

  .vehicle-image-panel {
    height: 24mm;
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
    font-size: 8px;
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
    font-size: 9px;
    font-weight: 900;
    color: var(--primary-dark);
    margin-bottom: 1.5mm;
  }

  .vehicle-mini-line {
    font-size: 6.8px;
    line-height: 1.25;
    margin-bottom: 0.8mm;
    color: var(--primary-dark);
  }

  .vehicle-extra-note {
    margin-top: 1.3mm;
    font-size: 6.8px;
    font-weight: 700;
    color: var(--muted);
  }

  .itinerary-section {
    height: 80mm;
    min-height: 0;
    overflow: hidden;
    position: relative;
    z-index: 1;
  }

  .itinerary-title {
    height: 6mm;
    font-size: 12px;
    font-weight: 800;
    color: var(--primary);
    margin: 0;
  }

  .itinerary-table-wrap {
    height: 74mm;
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
    height: 8mm;
  }

  .itinerary-table tbody tr {
    height: 13.2mm;
  }

  .itinerary-table th {
    background: var(--primary);
    color: #fff;
    font-size: 7.4px;
    font-weight: 800;
    padding: 1.5mm 1mm;
    border: 1px solid var(--border);
  }

  .itinerary-table td {
    font-size: 7.1px;
    line-height: 1.2;
    padding: 1.3mm 1mm;
    border: 1px solid var(--border);
    vertical-align: top;
    overflow: hidden;
  }

  .day-badge {
    width: 11mm;
    height: 10mm;
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
    font-size: 5px;
    line-height: 1;
  }

  .day-number {
    font-size: 7px;
    line-height: 1;
  }

  .date-cell strong {
    display: block;
    font-size: 7.6px;
    margin-bottom: 0.6mm;
  }

  .date-cell span {
    font-size: 6.8px;
    color: var(--muted);
  }

  .route-text {
    max-height: 11mm;
    overflow: hidden;
    word-break: break-word;
  }

  .time-cell {
    text-align: center;
    font-weight: 700;
  }

  .footer-grid {
    height: 36mm;
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
    padding: 3mm;
    overflow: hidden;
    background: #fff;
    box-shadow: 0 2px 6px rgba(53, 21, 214, 0.04);
  }

  .footer-title {
    font-size: 10px;
    font-weight: 800;
    margin-bottom: 2mm;
    color: var(--primary);
  }

  .footer-list {
    margin: 0;
    padding-left: 4mm;
  }

  .footer-list li {
    font-size: 6.9px;
    line-height: 1.25;
    margin-bottom: 1.2mm;
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
    height: 6mm;
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: 2mm;
    background: var(--soft);
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    font-size: 7.4px;
    font-style: italic;
    color: var(--primary-dark);
    position: static !important;
    z-index: 1;
  }
`;
