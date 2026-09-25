#!/usr/bin/env node

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const root = process.cwd();
const month = String(process.argv.find((value) => value.startsWith('--month=')) || '--month=2026-09').slice('--month='.length);
const outputPath = String(process.argv.find((value) => value.startsWith('--output=')) || `--output=hotel-image-manifests/${month}-offline-axisrooms-bing.json`).slice('--output='.length);
const start = new Date(`${month}-01T00:00:00+05:30`);
const end = new Date(start);
end.setUTCMonth(end.getUTCMonth() + 1);
const stopWords = new Set(['the', 'hotel', 'resort', 'resorts', 'inn', 'by', 'and', 'of', 'a', 'an', 'spa', 'private', 'limited', 'pvt', 'ltd']);

function tokens(value) {
  return String(value || '').toLowerCase().replace(/&amp;/g, ' and ').replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter((token) => token.length >= 3 && !stopWords.has(token));
}

function norm(value) {
  return String(value || '').toLowerCase().replace(/&amp;/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function hasToken(value, token) {
  return new RegExp(`(?:^|\\s)${token}(?:\\s|$)`, 'i').test(String(value || ''));
}

function decode(value) {
  return String(value || '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function parseBingImages(html) {
  const result = [];
  const regex = /\bm="([^"]+)"/gi;
  let match;
  while ((match = regex.exec(html))) {
    try {
      const value = JSON.parse(decode(match[1]));
      if (value?.murl) result.push({ imageUrl: String(value.murl), sourcePage: String(value.purl || '') , title: String(value.t || '') });
    } catch {
      // Bing occasionally emits a partially escaped card; skip only that card.
    }
  }
  return result;
}

function score(candidate, name, city) {
  const haystack = norm(`${candidate.title} ${candidate.sourcePage} ${candidate.imageUrl}`);
  const wanted = tokens(name);
  const anchors = wanted.filter((token) => token.length >= 5);
  const matches = wanted.filter((token) => hasToken(haystack, token)).length;
  const cityMatches = tokens(city).filter((token) => hasToken(haystack, token)).length;
  if (anchors.length >= 2 && anchors.filter((token) => hasToken(haystack, token)).length < anchors.length) return -1;
  if (wanted.length >= 2 && matches < Math.max(2, Math.ceil(wanted.length * 0.75))) return -1;
  if (wanted.length === 1 && matches < 1) return -1;
  return matches * 10 + Math.min(cityMatches, 3);
}

async function discover(item) {
  const query = `"${item.name}" "${item.city}" hotel photos`;
  const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36' } });
  if (!response.ok) throw new Error(`Bing HTTP ${response.status}`);
  const html = await response.text();
  const parsed = parseBingImages(html);
  const candidates = parsed
    .map((candidate) => ({ ...candidate, score: score(candidate, item.name, item.city) }))
    .filter((candidate) => candidate.score >= 0)
    .sort((a, b) => b.score - a.score);
  const sourceUrls = [];
  const sourcePages = [];
  for (const candidate of candidates) {
    if ((item.existingUrls || []).includes(candidate.imageUrl)) continue;
    if (sourceUrls.includes(candidate.imageUrl)) continue;
    sourceUrls.push(candidate.imageUrl);
    sourcePages.push(candidate.sourcePage);
    if (sourceUrls.length >= Math.max(0, 3 - item.existingCount)) break;
  }
  return { ...item, source: 'bing-image-search', sourcePage: sourcePages[0] || '', sourceUrls, sourcePages, candidateCount: candidates.length, query };
}

async function main() {
  const plans = await prisma.dvi_itinerary_plan_details.findMany({
    where: { createdon: { gte: start, lt: end }, status: 1, deleted: 0 },
    select: { itinerary_plan_ID: true },
  });
  const planIds = plans.map((row) => Number(row.itinerary_plan_ID)).filter(Boolean);
  const rows = planIds.length === 0 ? [] : await prisma.dvi_itinerary_plan_hotel_details.findMany({
    where: { itinerary_plan_id: { in: planIds }, hotel_provider: { in: ['offline', 'axisrooms'] }, status: 1, deleted: 0 },
    select: { hotel_id: true, hotel_code: true, hotel_provider: true },
  });
  const ids = Array.from(new Set(rows.map((row) => Number(row.hotel_id || row.hotel_code)).filter((value) => Number.isInteger(value) && value > 0)));
  const hotels = await prisma.dvi_hotel.findMany({
    where: { hotel_id: { in: ids }, deleted: false },
    select: { hotel_id: true, hotel_name: true, hotel_place: true, hotel_city: true, hotel_address: true },
  });
  const hotelById = new Map(hotels.map((row) => [Number(row.hotel_id), row]));
  const unique = new Map();
  for (const row of rows) {
    const id = Number(row.hotel_id || row.hotel_code);
    const hotel = hotelById.get(id);
    if (!hotel) continue;
    const key = `${row.hotel_provider}|${id}`;
    if (!unique.has(key)) unique.set(key, { provider: String(row.hotel_provider), code: String(id), name: String(hotel.hotel_name || '').trim(), city: String(hotel.hotel_place || hotel.hotel_city || hotel.hotel_address || '').trim() });
  }
  const codes = Array.from(unique.values()).map((item) => Number(item.code));
  const galleryRows = await prisma.dvi_hotel_gallery_details.findMany({ where: { hotel_id: { in: codes }, status: 1, deleted: 0 }, select: { hotel_id: true, source_url: true } });
  const existingById = new Map();
  for (const row of galleryRows) existingById.set(Number(row.hotel_id), [...(existingById.get(Number(row.hotel_id)) || []), String(row.source_url || '').trim()]);
  const ready = [];
  const short = [];
  for (const base of unique.values()) {
    const existingCount = (existingById.get(Number(base.code)) || []).length;
    if (existingCount >= 3) continue;
    try {
      const result = await discover({ ...base, existingCount, existingUrls: existingById.get(Number(base.code)) || [] });
      if (result.sourceUrls.length < 3 - existingCount) short.push(result);
      else ready.push(result);
    } catch (error) {
      short.push({ ...base, existingCount, sourceUrls: [], sourcePages: [], error: error instanceof Error ? error.message : String(error) });
    }
    if ((ready.length + short.length) % 10 === 0) console.log(`Bing discovery ${ready.length + short.length}/${unique.size}`);
  }
  const output = path.resolve(root, outputPath);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify({ generatedAt: new Date().toISOString(), month, targetImagesPerHotel: 3, sources: ready, short }, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ month, selectedRows: rows.length, uniqueHotels: unique.size, ready: ready.length, short: short.length, manifest: path.relative(root, output) }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
