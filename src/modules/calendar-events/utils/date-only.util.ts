import { BadRequestException } from '@nestjs/common';

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
export const MAX_CALENDAR_RANGE_DAYS = 366;

export function parseDateOnly(value: string, fieldName = 'date'): Date {
  const match = DATE_ONLY_PATTERN.exec(String(value ?? '').trim());
  if (!match) throw new BadRequestException(`${fieldName} must use strict YYYY-MM-DD format`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new BadRequestException(`${fieldName} must be a valid calendar date`);
  }
  return date;
}

export function validateDateRange(fromValue: string, toValue: string): { from: Date; to: Date } {
  const from = parseDateOnly(fromValue, 'from');
  const to = parseDateOnly(toValue, 'to');
  const days = Math.floor((to.getTime() - from.getTime()) / DAY_MS) + 1;
  if (days < 1) throw new BadRequestException('from must be on or before to');
  if (days > MAX_CALENDAR_RANGE_DAYS) throw new BadRequestException(`Calendar range cannot exceed ${MAX_CALENDAR_RANGE_DAYS} days`);
  return { from, to };
}

export function formatDateOnly(value: Date | string, fieldName = 'date'): string {
  if (typeof value === 'string' && DATE_ONLY_PATTERN.test(value.trim())) {
    parseDateOnly(value, fieldName);
    return value.trim();
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new BadRequestException(`${fieldName} is invalid`);
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
    .map((part, index) => index === 0 ? String(part).padStart(4, '0') : String(part).padStart(2, '0'))
    .join('-');
}

export function rangesOverlapInclusive(eventStart: string, eventEnd: string, requestedFrom: string, requestedTo: string): boolean {
  return eventStart <= requestedTo && eventEnd >= requestedFrom;
}
