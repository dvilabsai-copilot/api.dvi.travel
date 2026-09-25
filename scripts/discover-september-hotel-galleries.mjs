#!/usr/bin/env node

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const root = process.cwd();
const month = String(process.argv.find((value) => value.startsWith('--month=')) || '--month=2026-09').slice('--month='.length);
const providerFilter = String(process.argv.find((value) => value.startsWith('--provider=')) || '--provider=tbo').slice('--provider='.length).toLowerCase();
const outputPath = String(process.argv.find((value) => value.startsWith('--output=')) || `--output=hotel-image-manifests/${month}-${providerFilter}-details.json`).slice('--output='.length);
const start = new Date(`${month}-01T00:00:00+05:30`);
const end = new Date(start);
end.setUTCMonth(end.getUTCMonth() + 1);

function normalizeProvider(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['tbo', 'vsr'].includes(normalized)) return 'tbo';
  if (['axisrooms', 'ax'].includes(normalized)) return 'axisrooms';
  if (normalized === 'offline') return 'offline';
  return normalized;
}

async function postTboDetails(codes) {
  // TBO's HotelDetails endpoint is served by the Holidays API host. The
  // normal search credentials/host in .env can be a different TekTravel
  // account, so gallery discovery has its own explicit override.
  const username = process.env.TBO_GALLERY_USERNAME || 'IXMD112';
  const password = process.env.TBO_GALLERY_PASSWORD || 'api-11#M$new';
  const base = process.env.TBO_GALLERY_API_URL || 'https://affiliate.travelboutiqueonline.com/HotelAPI';
  const auth = Buffer.from(`${username}:${password}`).toString('base64');
  const response = await fetch(`${base}/HotelDetails`, {
    method: 'POST',
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
    body: JSON.stringify({ HotelCodes: codes.join(','), Language: 'EN' }),
  });
  if (!response.ok) throw new Error(`TBO HotelDetails HTTP ${response.status}`);
  const payload = await response.json();
  const statusCode = Number(payload?.Status?.Code || 0);
  if (statusCode !== 200) throw new Error(`TBO HotelDetails ${payload?.Status?.Description || 'failed'}`);
  return Array.isArray(payload?.HotelDetails) ? payload.HotelDetails : [];
}

async function main() {
  if (providerFilter !== 'tbo') throw new Error('This discovery source supports provider=tbo only. Use the web-search manifest for AX/Offline records.');

  const plans = await prisma.dvi_itinerary_plan_details.findMany({
    where: { createdon: { gte: start, lt: end }, status: 1, deleted: 0 },
    select: { itinerary_quote_ID: true },
  });
  const planQuotes = new Set(plans.map((row) => String(row.itinerary_quote_ID || '').trim()).filter(Boolean));
  const planRows = await prisma.dvi_itinerary_plan_details.findMany({
    where: { createdon: { gte: start, lt: end }, status: 1, deleted: 0 },
    select: { itinerary_plan_ID: true },
  });
  const planIds = planRows.map((row) => Number(row.itinerary_plan_ID)).filter(Boolean);
  const rows = planIds.length === 0 ? [] : await prisma.dvi_itinerary_plan_hotel_details.findMany({
    where: { itinerary_plan_id: { in: planIds }, hotel_provider: 'tbo', status: 1, deleted: 0 },
    select: { hotel_code: true },
  });
  const masterRows = await prisma.tbo_hotel_master.findMany({
    where: { tbo_hotel_code: { in: Array.from(new Set(rows.map((row) => String(row.hotel_code || '').trim()).filter(Boolean))) }, status: 1 },
    select: { tbo_hotel_code: true, hotel_name: true, city_name: true },
  });
  const masterByCode = new Map(masterRows.map((row) => [String(row.tbo_hotel_code), row]));
  const candidates = new Map();
  for (const row of rows) {
    const code = String(row.hotel_code || '').trim();
    if (!code) continue;
    const key = `tbo|${code}`;
    const master = masterByCode.get(code);
    if (!candidates.has(key)) candidates.set(key, { provider: 'tbo', code, name: String(master?.hotel_name || '').trim(), city: String(master?.city_name || '').trim() });
  }

  const codes = Array.from(candidates.values()).map((item) => item.code);
  const existing = await prisma.tbo_hotel_gallery_details.findMany({
    where: { tbo_hotel_code: { in: codes }, status: 1, deleted: 0 },
    select: { tbo_hotel_code: true, source_url: true },
    orderBy: [{ tbo_hotel_code: 'asc' }, { sort_order: 'asc' }],
  });
  const existingByCode = new Map();
  for (const row of existing) {
    const list = existingByCode.get(String(row.tbo_hotel_code)) || [];
    list.push(String(row.source_url || '').trim());
    existingByCode.set(String(row.tbo_hotel_code), list);
  }

  const detailsByCode = new Map();
  for (let index = 0; index < codes.length; index += 40) {
    const batch = codes.slice(index, index + 40);
    const details = await postTboDetails(batch);
    for (const detail of details) detailsByCode.set(String(detail?.HotelCode || '').trim(), detail);
    console.log(`TBO HotelDetails ${Math.min(index + batch.length, codes.length)}/${codes.length}`);
  }

  const sources = [];
  const short = [];
  for (const item of candidates.values()) {
    const current = existingByCode.get(item.code) || [];
    const detail = detailsByCode.get(item.code);
    const imageUrls = Array.from(new Set([detail?.Image, ...(Array.isArray(detail?.Images) ? detail.Images : [])].map((value) => String(value || '').trim()).filter(Boolean)));
    const sourceUrls = imageUrls.filter((url) => !current.includes(url)).slice(0, Math.max(0, 3 - current.length));
    if (sourceUrls.length < Math.max(0, 3 - current.length)) {
      short.push({ ...item, existingCount: current.length, availableCount: imageUrls.length });
      continue;
    }
    sources.push({
      ...item,
      source: 'tbo-hotel-details',
      sourcePage: `${baseUrl(process.env.TBO_GALLERY_API_URL || 'https://affiliate.travelboutiqueonline.com/HotelAPI')}/HotelDetails`,
      sourceUrls,
      sourcePages: sourceUrls.map(() => `${baseUrl(process.env.TBO_GALLERY_API_URL || 'https://affiliate.travelboutiqueonline.com/HotelAPI')}/HotelDetails`),
      existingCount: current.length,
    });
  }

  const output = path.resolve(root, outputPath);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify({ generatedAt: new Date().toISOString(), month, provider: providerFilter, targetImagesPerHotel: 3, source: 'TBO HotelDetails', sources, short }, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ month, provider: providerFilter, activePlans: planQuotes.size, savedRows: rows.length, uniqueHotels: candidates.size, manifest: path.relative(root, output), ready: sources.length, short: short.length }, null, 2));
}

function baseUrl(value) {
  return String(value).replace(/\/$/, '');
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
