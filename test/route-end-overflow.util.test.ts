import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateRouteEndOverflowMinutes } from '../src/modules/itineraries/utils/route-end-overflow.util';

const parseTime = (value: any): number | null => {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  if (match[3]?.toUpperCase() === 'AM' && hour === 12) hour = 0;
  if (match[3]?.toUpperCase() === 'PM' && hour !== 12) hour += 12;
  return (hour * 60) + Number(match[2]);
};

const parseStart = (row: any): number | null => parseTime(String(row.timeRange || '').split('-')[0]);
const parseEnd = (row: any): number | null => parseTime(String(row.timeRange || '').split('-')[1]);

const calculate = (timeline: any[], routeEndTime = '11:00 PM') => calculateRouteEndOverflowMinutes({
  timeline,
  routeStartTime: '08:00 AM',
  routeEndTime,
  parseTimeToMinutes: parseTime,
  parseSegmentStartMinutes: parseStart,
  parseSegmentEndMinutes: parseEnd,
});

test('keeps same-day route overflow calculation unchanged', () => {
  assert.equal(calculate([
    { timeRange: '08:00 AM - 09:00 AM' },
    { timeRange: '09:00 AM - 10:00 AM' },
    { timeRange: '10:00 AM - 08:00 PM' },
  ]), 0);
  assert.equal(calculate([{ timeRange: '10:00 PM - 11:20 PM' }]), 20);
});

test('counts overnight timeline rows against the same route-day end', () => {
  assert.equal(calculate([
    { timeRange: '08:00 AM - 09:00 AM' },
    { timeRange: '09:00 PM - 10:00 PM' },
    { timeRange: '10:00 PM - 12:30 AM' },
    { timeRange: '12:30 AM - 04:53 AM' },
  ]), 353);
});
