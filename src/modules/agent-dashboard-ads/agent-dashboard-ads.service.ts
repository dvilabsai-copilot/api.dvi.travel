import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { randomBytes } from 'crypto';
import { basename, dirname, join, resolve } from 'path';
import { SaveAgentDashboardAdDto } from './dto/agent-dashboard-ad.dto';

type AdRecord = {
  id: number;
  title: string;
  imagePath: string;
  targetUrl: string | null;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

/** Locate package root under both ts-node-dev and compiled dist/ runs. */
function backendRoot(): string {
  let dir = __dirname;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

/** Metadata is PRIVATE. Only /public/uploads is exposed by src/main.ts. */
const ROOT = backendRoot();
const INDEX_FILE = resolve(
  process.env.DVI_AGENT_ADS_STORE_FILE ||
  join(ROOT, 'public', 'private', 'agent_dashboard_ads', 'index.json'),
);
const UPLOAD_DIR = join(ROOT, 'public', 'uploads', 'agent_dashboard_ads');
const IMAGE_PREFIX = '/uploads/agent_dashboard_ads/';

function checkImageType(buffer: Buffer): string {
  if (buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return '.png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return '';
}

@Injectable()
export class AgentDashboardAdsService {
  /** Serialize writes to avoid losing changes from simultaneous admin requests. */
  private pendingWrite: Promise<unknown> = Promise.resolve();

  private async read(): Promise<AdRecord[]> {
    let raw: string;
    try {
      raw = await fs.readFile(INDEX_FILE, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new InternalServerErrorException('Advertisement storage is not readable');
    }
    try {
      const rows: unknown = JSON.parse(raw);
      if (!Array.isArray(rows) || rows.some((r) =>
        !r || typeof r !== 'object' ||
        !Number.isSafeInteger(r.id) || r.id <= 0 ||
        typeof r.title !== 'string' ||
        typeof r.imagePath !== 'string' ||
        typeof r.enabled !== 'boolean' ||
        !Number.isInteger(r.sortOrder))) {
        throw new Error('Invalid advertisement storage schema');
      }
      return rows as AdRecord[];
    } catch {
      // Never silently replace a corrupted file with an empty list.
      throw new InternalServerErrorException('Advertisement storage is invalid; restore its backup');
    }
  }

  private async write(rows: AdRecord[]): Promise<void> {
    await fs.mkdir(dirname(INDEX_FILE), { recursive: true });
    const tmp = `${INDEX_FILE}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(rows, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await fs.rename(tmp, INDEX_FILE);
    } catch (error) {
      await fs.unlink(tmp).catch(() => undefined);
      throw error;
    }
  }

  private mutate<T>(change: (rows: AdRecord[]) => Promise<T> | T): Promise<T> {
    const operation = this.pendingWrite.then(async () => {
      const rows = await this.read();
      const output = await change(rows);
      await this.write(rows);
      return output;
    });
    this.pendingWrite = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private sorted(rows: AdRecord[]): AdRecord[] {
    return rows.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  }

  private async validated(dto: SaveAgentDashboardAdDto) {
    const title = String(dto?.title || '').trim();
    if (!title || title.length > 120) throw new BadRequestException('Title is required (max 120 characters)');
    const imagePath = String(dto?.imagePath || '').trim();
    if (!/^\/uploads\/agent_dashboard_ads\/[A-Za-z0-9._-]+$/.test(imagePath)) {
      throw new BadRequestException('Upload a banner through the advertisement form');
    }
    const file = join(UPLOAD_DIR, basename(imagePath));
    try {
      const status = await fs.stat(file);
      if (!status.isFile()) throw new Error('not a file');
    } catch {
      throw new BadRequestException('Uploaded banner image not found');
    }
    const rawLink = String(dto?.targetUrl || '').trim();
    if (rawLink) {
      try {
        const target = new URL(rawLink);
        if (target.protocol !== 'https:') throw new Error('HTTPS required');
      } catch {
        throw new BadRequestException('Advertisement link must use HTTPS');
      }
    }
    const sortOrder = dto?.sortOrder ?? 0;
    if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 9999) {
      throw new BadRequestException('Display order must be between 0 and 9999');
    }
    if (dto?.enabled !== undefined && typeof dto.enabled !== 'boolean') {
      throw new BadRequestException('Published must be true or false');
    }
    return {
      title,
      imagePath,
      targetUrl: rawLink || null,
      enabled: dto.enabled ?? false,
      sortOrder,
    };
  }

  async list(): Promise<AdRecord[]> {
    return this.sorted(await this.read());
  }

  async active(): Promise<AdRecord[]> {
    return this.sorted((await this.read()).filter((ad) => ad.enabled));
  }

  async create(dto: SaveAgentDashboardAdDto): Promise<AdRecord> {
    const validated = await this.validated(dto);
    return this.mutate((rows) => {
      const id = rows.reduce((max, row) => Math.max(max, row.id), 0) + 1;
      const timestamp = new Date().toISOString();
      const ad: AdRecord = { id, ...validated, createdAt: timestamp, updatedAt: timestamp };
      rows.push(ad);
      return ad;
    });
  }

  async update(id: number, dto: SaveAgentDashboardAdDto): Promise<AdRecord> {
    const validated = await this.validated(dto);
    return this.mutate((rows) => {
      const row = rows.find((ad) => ad.id === id);
      if (!row) throw new NotFoundException('Advertisement not found');
      Object.assign(row, validated, { updatedAt: new Date().toISOString() });
      return { ...row };
    });
  }

  async setEnabled(id: number, enabled: boolean): Promise<AdRecord> {
    if (typeof enabled !== 'boolean') throw new BadRequestException('Published must be true or false');
    return this.mutate((rows) => {
      const row = rows.find((ad) => ad.id === id);
      if (!row) throw new NotFoundException('Advertisement not found');
      row.enabled = enabled;
      row.updatedAt = new Date().toISOString();
      return { ...row };
    });
  }

  async remove(id: number): Promise<{ success: true }> {
    return this.mutate((rows) => {
      const index = rows.findIndex((ad) => ad.id === id);
      if (index < 0) throw new NotFoundException('Advertisement not found');
      rows.splice(index, 1);
      return { success: true };
    });
  }

  async upload(file?: Express.Multer.File): Promise<{ imagePath: string }> {
    if (!file?.buffer?.length || file.buffer.length > 5 * 1024 * 1024) {
      throw new BadRequestException('Select a banner image under 5 MB');
    }
    const ext = checkImageType(file.buffer);
    if (!ext) throw new BadRequestException('Only PNG, JPEG or WebP images are supported');
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    const name = `${Date.now()}-${randomBytes(12).toString('hex')}${ext}`;
    await fs.writeFile(join(UPLOAD_DIR, name), file.buffer, { flag: 'wx' });
    return { imagePath: `${IMAGE_PREFIX}${name}` };
  }
}
