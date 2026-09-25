#!/usr/bin/env node

import 'dotenv/config';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const root = process.cwd();
const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const value = process.argv[i];
  if (!value.startsWith('--')) continue;
  const [key, inline] = value.slice(2).split('=', 2);
  args.set(key, inline ?? process.argv[i + 1] ?? 'true');
  if (inline === undefined && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) i += 1;
}

const getArg = (key, fallback = '') => String(args.get(key) ?? fallback).trim();
const apply = args.has('apply');
const source = getArg('source-url');
const provider = getArg('provider').toLowerCase();
const code = getArg('code');
const name = getArg('name');
const quoteId = getArg('quote-id');
const manifestPath = getArg('manifest');
const append = args.has('append');

function providerKind(value) {
  const normalized = String(value || '').toLowerCase();
  if (['tbo', 'vsr'].includes(normalized)) return 'tbo';
  if (['axisrooms', 'ax'].includes(normalized)) return 'axisrooms';
  if (normalized === 'offline') return 'offline';
  throw new Error(`Unsupported provider "${value}". Use axisrooms, offline, or tbo/vsr.`);
}

const normalize = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function extensionFor(contentType, url) {
  const mime = String(contentType || '').split(';')[0].toLowerCase();
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return '.jpg';
  const suffix = path.extname(new URL(url).pathname).toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.webp'].includes(suffix)
    ? (suffix === '.jpeg' ? '.jpg' : suffix)
    : '';
}

async function readManifest() {
  if (!manifestPath) return null;
  const file = path.resolve(root, manifestPath);
  const value = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(value?.sources)) throw new Error(`Manifest ${manifestPath} must contain a sources array`);
  return value.sources.flatMap((item) => {
    const sourceUrls = Array.isArray(item.sourceUrls)
      ? item.sourceUrls.map((url) => String(url || '').trim()).filter(Boolean)
      : [String(item.sourceUrl || item.url || '').trim()].filter(Boolean);
    const sourcePages = Array.isArray(item.sourcePages) ? item.sourcePages : [];
    return sourceUrls.map((sourceUrl, index) => ({
      ...item,
      sourceUrl,
      sourcePage: String(sourcePages[index] || item.sourcePage || '').trim(),
    }));
  });
}

async function quoteSources() {
  const plan = await prisma.dvi_itinerary_plan_details.findFirst({
    where: { itinerary_quote_ID: quoteId, deleted: 0 },
    select: { itinerary_plan_ID: true },
  });
  if (!plan) throw new Error(`Quote not found: ${quoteId}`);
  const rows = await prisma.dvi_itinerary_hotel_search_cache.findMany({
    where: { quote_id: quoteId, plan_id: Number(plan.itinerary_plan_ID), status: 1, deleted: 0 },
    select: { provider: true, hotel_code: true, hotel_name: true },
  });
  const unique = new Map();
  for (const row of rows) {
    const key = `${row.provider}|${row.hotel_code}|${row.hotel_name}`;
    if (!unique.has(key)) unique.set(key, { provider: row.provider, code: row.hotel_code, name: row.hotel_name });
  }
  return Array.from(unique.values());
}

async function resolveDviHotel(item) {
  const id = Number(item.code);
  const byId = Number.isInteger(id) && id > 0
    ? await prisma.dvi_hotel.findUnique({ where: { hotel_id: id }, select: { hotel_id: true, hotel_name: true } })
    : null;
  if (byId) return byId;
  const candidates = await prisma.dvi_hotel.findMany({
    where: { OR: [{ hotel_code: String(item.code) }, { hotel_name: item.name }] },
    select: { hotel_id: true, hotel_name: true },
  });
  const exact = candidates.find((row) => normalize(row.hotel_name) === normalize(item.name));
  if (exact) return exact;
  throw new Error(`DVI hotel not found for ${item.provider}:${item.code} ${item.name}`);
}

async function resolveItem(item) {
  const kind = providerKind(item.provider);
  const imageUrl = String(item.sourceUrl || item.url || '').trim();
  if (!imageUrl) throw new Error(`No sourceUrl for ${kind}:${item.code} ${item.name}`);
  new URL(imageUrl);
  if (kind === 'tbo') {
    const master = await prisma.tbo_hotel_master.findUnique({
      where: { tbo_hotel_code: String(item.code) },
      select: { tbo_hotel_code: true, hotel_name: true },
    });
    if (!master) throw new Error(`TBO master not found for ${item.code} ${item.name}`);
    return { ...item, kind, key: String(master.tbo_hotel_code), resolvedName: master.hotel_name, imageUrl };
  }
  const hotel = await resolveDviHotel(item);
  return { ...item, kind, key: Number(hotel.hotel_id), resolvedName: hotel.hotel_name, imageUrl };
}

async function downloadImage(item) {
  const requestUrl = String(item.imageUrl).replace(/([?&]img=)([^&]*)/i, (_match, prefix, value) => `${prefix}${encodeURIComponent(decodeURIComponent(value).replace(/ /g, '+'))}`);
  const isTboImage = /(?:^|\.)tboholidays\.com$/i.test(new URL(requestUrl).hostname);
  const response = await fetch(requestUrl, {
    headers: {
      'user-agent': 'DVI-Travel-HotelGallerySync/1.0',
      ...(isTboImage ? { referer: 'https://www.tboholidays.com/' } : {}),
    },
    signal: AbortSignal.timeout(20_000),
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${item.imageUrl}`);
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = extensionFor(contentType, item.imageUrl);
  if (!extension || !contentType.startsWith('image/')) throw new Error(`Source is not a supported image (${contentType || 'unknown'}): ${item.imageUrl}`);
  if (buffer.length < 1024 || buffer.length > 10 * 1024 * 1024) throw new Error(`Image size out of range (${buffer.length} bytes): ${item.imageUrl}`);
  return { buffer, extension, hash: createHash('sha256').update(buffer).digest('hex').slice(0, 12) };
}

async function syncItem(raw) {
  const item = await resolveItem(raw);
  const existing = item.kind === 'tbo'
    ? await prisma.tbo_hotel_gallery_details.findMany({ where: { tbo_hotel_code: item.key, status: 1, deleted: 0 }, orderBy: [{ sort_order: 'asc' }, { tbo_hotel_gallery_details_id: 'asc' }] })
    : await prisma.dvi_hotel_gallery_details.findMany({ where: { hotel_id: item.key, status: 1, deleted: 0 }, orderBy: [{ sort_order: 'asc' }, { hotel_gallery_details_id: 'asc' }] });
  if (existing.some((row) => String(row.source_url || '').trim() === item.imageUrl)) {
    return { ...item, status: 'skipped-existing-source', imageCount: existing.length };
  }
  if (existing.length > 0 && !append) return { ...item, status: 'skipped-existing', imageCount: existing.length };
  if (!apply) return { ...item, status: 'ready', imageCount: 0 };

  const image = await downloadImage(item);
  const folder = item.kind === 'tbo'
    ? path.resolve(root, 'public', 'uploads', 'tbo_hotel_gallery', String(item.key))
    : path.resolve(root, 'public', 'uploads', 'hotel_gallery', String(item.key));
  await mkdir(folder, { recursive: true });
  const fileName = `web-${String(item.key).replace(/[^a-zA-Z0-9_-]/g, '_')}-${image.hash}${image.extension}`;
  const target = path.join(folder, fileName);
  const temp = `${target}.part`;
  await writeFile(temp, image.buffer);
  await rename(temp, target);
  const isPrimary = existing.some((row) => Number(row.is_primary) === 1) ? 0 : 1;
  try {
    const nextSort = existing.reduce((max, row) => Math.max(max, Number(row.sort_order || 0)), 0) + 1;
    if (item.kind === 'tbo') {
      await prisma.tbo_hotel_gallery_details.create({
        data: { tbo_hotel_code: item.key, tbo_hotel_gallery_name: fileName, is_primary: isPrimary, sort_order: nextSort, source: String(item.source || 'web-search'), source_url: item.imageUrl, createdby: 0, createdon: new Date(), status: 1, deleted: 0 },
      });
    } else {
      await prisma.dvi_hotel_gallery_details.create({
        data: { hotel_id: item.key, hotel_gallery_name: fileName, is_primary: isPrimary, sort_order: nextSort, source: String(item.source || 'web-search'), source_url: item.imageUrl, createdby: 0, createdon: new Date(), status: 1, deleted: 0 },
      });
    }
  } catch (error) {
    await rm(target, { force: true });
    throw error;
  }
  const fileStat = await stat(target);
  return { ...item, status: 'created', imageCount: existing.length + 1, isPrimary, file: path.relative(root, target), bytes: fileStat.size };
}

async function main() {
  if (!manifestPath && !quoteId && !(provider && code && name && source)) {
    throw new Error('Use --manifest path, --quote-id QUOTE, or --provider PROVIDER --code CODE --name NAME --source-url URL. Add --apply to write files and DB rows; without it the command is a dry run. Add --append only when adding verified extra images to an existing gallery.');
  }
  const manifest = await readManifest();
  const sources = manifest || (quoteId ? await quoteSources() : [{ provider, code, name, sourceUrl: source }]);
  const results = [];
  for (const item of sources) {
    try { results.push(await syncItem(item)); }
    catch (error) { results.push({ provider: item.provider, code: item.code, name: item.name, status: 'error', error: error instanceof Error ? error.message : String(error) }); }
  }
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', total: results.length, counts: results.reduce((acc, row) => { acc[row.status] = (acc[row.status] || 0) + 1; return acc; }, {}), results }, null, 2));
  if (results.some((row) => row.status === 'error')) process.exitCode = 1;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
