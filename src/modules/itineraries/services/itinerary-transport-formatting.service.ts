import { Injectable } from '@nestjs/common';

@Injectable()
export class ItineraryTransportFormattingService {
  private formatTimeCallback: (time: Date | null) => string = (time) => {
    if (!time) return 'N/A';
    const date = new Date(time);
    return `${date.getUTCHours().toString().padStart(2, '0')}:${date.getUTCMinutes().toString().padStart(2, '0')}`;
  };

  setFormatTimeCallback(callback: (time: Date | null) => string) {
    this.formatTimeCallback = callback;
  }

  formatTransportVoucherDate(value: Date | string | null | undefined): string {
    if (!value) return '--';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '--';
    return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  buildTransportDateRange(start: Date | string | null | undefined, end: Date | string | null | undefined): string {
    const startLabel = this.formatTransportVoucherDate(start);
    const endLabel = this.formatTransportVoucherDate(end);
    if (startLabel === '--' && endLabel === '--') return '--';
    if (startLabel === '--') return endLabel;
    if (endLabel === '--') return startLabel;
    return `${startLabel} - ${endLabel}`;
  }

  buildPassengerMixLabel(adults: number, children: number, infants: number): string {
    const items = [
      adults > 0 ? `${adults} Adult${adults > 1 ? 's' : ''}` : '',
      children > 0 ? `${children} Child${children > 1 ? 'ren' : ''}` : '',
      infants > 0 ? `${infants} Infant${infants > 1 ? 's' : ''}` : '',
    ].filter(Boolean);
    return items.length > 0 ? items.join(', ') : 'Guests';
  }

  buildTransportVoucherNumber(planId: number, createdOn: Date | string | null | undefined): string {
    const basis = createdOn instanceof Date ? createdOn : createdOn ? new Date(createdOn) : new Date();
    const date = Number.isNaN(basis.getTime()) ? new Date() : basis;
    return `DVI/TV/${String(date.getFullYear()).slice(-2)}${String(date.getMonth() + 1).padStart(2, '0')}/${String(planId).padStart(4, '0')}`;
  }

  formatTransportTime(value: Date | string | null | undefined): string {
    if (!value) return 'Not Provided';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return 'Not Provided';
    return this.formatTimeCallback(date);
  }

  shortTransportLocationName(value: string): string {
    return String(value || '')
      .replace(/Cochin International Airport/gi, 'Cochin Airport')
      .replace(/Cochin Airport Terminal [^,|-]+/gi, 'Cochin Airport')
      .replace(/Cochin International/gi, 'Cochin')
      .replace(/Kochi International Airport/gi, 'Kochi Airport')
      .replace(/\s+/g, ' ')
      .trim();
  }

  decodeTransportHtml(value: string): string {
    return String(value || '').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim();
  }

  parseTransportFlightDetails(raw: unknown, fallbackDateTime?: Date | string | null) {
    const emptyFlight = {
      airline: 'Not Provided', flightNo: 'Not Provided', from: 'Not Provided', to: 'Not Provided',
      date: this.formatTransportVoucherDate(fallbackDateTime),
      time: this.formatTransportTime(fallbackDateTime),
      rawText: typeof raw === 'string' && raw.trim() ? this.decodeTransportHtml(raw.trim()) : 'Not Provided',
    };
    if (!raw) return emptyFlight;
    if (typeof raw === 'object' && raw !== null) {
      const parsed = raw as Record<string, unknown>;
      return {
        airline: this.pickTransportFlightValue(parsed, ['airline', 'airlineName', 'carrier', 'name']) || 'Not Provided',
        flightNo: this.pickTransportFlightValue(parsed, ['flightNo', 'flight_no', 'flightNumber', 'number']) || 'Not Provided',
        from: this.pickTransportFlightValue(parsed, ['from', 'origin', 'departure', 'source']) || 'Not Provided',
        to: this.pickTransportFlightValue(parsed, ['to', 'destination', 'arrival']) || 'Not Provided',
        date: this.pickTransportFlightValue(parsed, ['date', 'travelDate']) || emptyFlight.date,
        time: this.pickTransportFlightValue(parsed, ['time', 'arrivalTime', 'departureTime']) || emptyFlight.time,
        rawText: this.decodeTransportHtml(JSON.stringify(parsed)),
      };
    }
    const text = String(raw || '').trim();
    if (!text) return emptyFlight;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') return this.parseTransportFlightDetails(parsed, fallbackDateTime);
    } catch { /* preserve raw text */ }
    return { ...emptyFlight, rawText: this.decodeTransportHtml(text) };
  }

  private pickTransportFlightValue(parsed: Record<string, unknown>, keys: string[]): string {
    for (const key of keys) {
      const value = parsed[key];
      if (value === null || value === undefined) continue;
      const normalized = String(value).trim();
      if (normalized) return normalized;
    }
    return '';
  }
}
