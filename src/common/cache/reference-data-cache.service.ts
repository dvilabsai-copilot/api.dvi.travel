import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * Optional cache for stable hotel reference data. Availability itself is not
 * cached here: supplier rates and bookability must remain live.
 */
@Injectable()
export class ReferenceDataCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(ReferenceDataCacheService.name);
  private readonly enabled = String(process.env.REDIS_ENABLED || 'false').toLowerCase() === 'true';
  private readonly prefix = String(process.env.REDIS_KEY_PREFIX || 'dvi:').trim();
  private readonly ttl = Math.max(Number(process.env.REDIS_REFERENCE_TTL_SECONDS || 3600), 60);
  private readonly redis: Redis | null;

  constructor() {
    this.redis = this.enabled
      ? new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
          connectTimeout: Math.max(Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 250), 50),
          lazyConnect: true,
          maxRetriesPerRequest: 0,
          enableOfflineQueue: false,
        })
      : null;
    this.redis?.on('error', (error) => this.logger.warn(`Redis reference cache unavailable: ${error.message}`));
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.redis) return null;
    try {
      const value = await this.redis.get(this.key(key));
      return value ? JSON.parse(value) as T : null;
    } catch { return null; }
  }

  async set(key: string, value: unknown): Promise<void> {
    if (!this.redis) return;
    try { await this.redis.set(this.key(key), JSON.stringify(value), 'EX', this.ttl); } catch { /* cache is best effort */ }
  }

  async invalidate(): Promise<void> {
    if (!this.redis) return;
    try {
      let cursor = '0';
      const pattern = `${this.prefix}reference:*`;
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = next;
        if (keys.length) await this.redis.del(...keys);
      } while (cursor !== '0');
    } catch { /* invalidation must not break an admin write */ }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) await this.redis.quit().catch(() => undefined);
  }

  private key(key: string): string { return `${this.prefix}reference:${key}`; }
}
