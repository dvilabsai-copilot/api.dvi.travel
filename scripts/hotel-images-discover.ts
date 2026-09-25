import { chromium } from 'playwright';
import { PrismaClient } from '@prisma/client';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

type Candidate = { imageUrl: string; sourceUrl: string; title: string; source: string };

const args = new Set(process.argv.slice(2));
const valueOf = (name: string, fallback = '') => {
  const token = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return token ? token.slice(name.length + 3) : fallback;
};
const hotelId = Number(valueOf('hotelId', '433'));
const limit = Math.max(1, Math.min(12, Number(valueOf('limit', '8'))));
const apply = args.has('--apply');
const manifestDir = path.resolve(process.cwd(), 'hotel-image-manifests');
const prisma = new PrismaClient();

async function discover(): Promise<Candidate[]> {
  const hotel = await prisma.dvi_hotel.findFirst({
    where: { hotel_id: hotelId },
    select: { hotel_id: true, hotel_name: true, hotel_city: true, hotel_state: true },
  });
  if (!hotel) throw new Error(`Hotel ${hotelId} was not found`);
  const query = [hotel.hotel_name, hotel.hotel_city, hotel.hotel_state, 'hotel'].filter(Boolean).join(' ');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ userAgent: 'DVI-Hotel-Image-Discovery/1.0' });
    await page.goto(`https://www.bing.com/images/search?q=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const candidates = await page.$$eval('a.iusc', (links) => links.map((link) => {
      try {
        const metadata = JSON.parse(link.getAttribute('m') || '{}');
        return {
          imageUrl: String(metadata.murl || ''),
          sourceUrl: String(metadata.purl || ''),
          title: String(metadata.t || ''),
          source: 'bing-images',
        };
      } catch {
        return null;
      }
    }).filter((candidate): candidate is Candidate => Boolean(candidate?.imageUrl && candidate?.sourceUrl)));
    return Array.from(new Map(candidates.map((candidate) => [candidate.imageUrl, candidate])).values()).slice(0, limit);
  } finally {
    await browser.close();
  }
}

async function applyCandidates(candidates: Candidate[]) {
  const directory = path.resolve(process.cwd(), 'public', 'uploads', 'hotel_gallery', String(hotelId));
  await fs.mkdir(directory, { recursive: true });
  const existing = await prisma.dvi_hotel_gallery_details.findMany({
    where: { hotel_id: hotelId, status: 1, deleted: 0 },
    select: { is_primary: true, sort_order: true },
    orderBy: { sort_order: 'desc' },
  });
  let nextSort = Number(existing[0]?.sort_order || 0) + 1;
  let hasPrimary = existing.some((row) => Number(row.is_primary) === 1);
  const applied: Candidate[] = [];
  for (const candidate of candidates) {
    const response = await fetch(candidate.imageUrl, { redirect: 'follow' });
    const contentType = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) continue;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) continue;
    const extension = contentType === 'image/png' ? '.png' : contentType === 'image/webp' ? '.webp' : '.jpg';
    const fileName = `hotel-${hotelId}-${randomUUID()}${extension}`;
    await fs.writeFile(path.join(directory, fileName), bytes);
    await prisma.dvi_hotel_gallery_details.create({
      data: {
        hotel_id: hotelId,
        hotel_gallery_name: fileName,
        is_primary: hasPrimary ? 0 : 1,
        sort_order: nextSort++,
        source: candidate.source,
        source_url: candidate.sourceUrl,
        createdby: 0,
        createdon: new Date(),
        status: 1,
        deleted: 0,
      },
    });
    hasPrimary = true;
    applied.push(candidate);
  }
  return applied;
}

async function main() {
  if (!Number.isInteger(hotelId) || hotelId <= 0) throw new Error('--hotelId must be a positive integer');
  const candidates = await discover();
  const manifest = {
    hotelId,
    generatedAt: new Date().toISOString(),
    query: valueOf('query', ''),
    applyRequested: apply,
    rightsReviewRequired: true,
    candidates,
  };
  await fs.mkdir(manifestDir, { recursive: true });
  await fs.writeFile(path.join(manifestDir, `hotel-${hotelId}.json`), JSON.stringify(manifest, null, 2));
  if (apply) {
    const applied = await applyCandidates(candidates);
    console.log(`Applied ${applied.length} candidate images for hotel ${hotelId}. Review source URLs in ${manifestDir}.`);
  } else {
    console.log(`Discovered ${candidates.length} candidates for hotel ${hotelId}; no database/filesystem changes made.`);
  }
  await prisma.$disconnect();
}

main().catch(async (error) => {
  await prisma.$disconnect();
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
