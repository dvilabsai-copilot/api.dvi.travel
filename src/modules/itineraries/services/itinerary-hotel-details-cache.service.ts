import { Injectable, Logger } from '@nestjs/common';

type CacheEntry<T> = { data: T; timestamp: number };

@Injectable()
export class ItineraryHotelDetailsCacheService {
  private readonly logger = new Logger(ItineraryHotelDetailsCacheService.name);
  private readonly ttlMs = 5 * 60 * 1000;
  private readonly maxEntries = 200;
  private readonly hotelDetailsCache = new Map<string, CacheEntry<any>>();
  private readonly roomDetailsCache = new Map<string, CacheEntry<any>>();

  private cacheKey(quoteId: string, routeId?: number): string {
    return routeId ? `${quoteId}:${routeId}` : quoteId;
  }

  private isExpired(timestamp: number): boolean {
    return Date.now() - timestamp > this.ttlMs;
  }

  private evictOldestIfNeeded<T extends { timestamp: number }>(cache: Map<string, T>): void {
    if (cache.size < this.maxEntries) return;
    let oldestKey: string | null = null;
    let oldestTimestamp = Number.MAX_SAFE_INTEGER;
    cache.forEach((entry, key) => {
      if (entry.timestamp < oldestTimestamp) {
        oldestTimestamp = entry.timestamp;
        oldestKey = key;
      }
    });
    if (oldestKey) cache.delete(oldestKey);
  }

  getRoomDetails(quoteId: string, routeId?: number): any | null {
    const key = this.cacheKey(quoteId, routeId);
    const cached = this.roomDetailsCache.get(key);
    if (!cached) return null;
    if (this.isExpired(cached.timestamp)) {
      this.roomDetailsCache.delete(key);
      this.logger.debug(`[CACHE EXPIRED] Removed stale room cache for ${key}`);
      return null;
    }
    this.logger.log(`[CACHE HIT] Using cached data for ${key}`);
    return cached.data;
  }

  setRoomDetails(quoteId: string, data: any, routeId?: number): void {
    const key = this.cacheKey(quoteId, routeId);
    this.evictOldestIfNeeded(this.roomDetailsCache);
    this.roomDetailsCache.set(key, { data, timestamp: Date.now() });
    this.logger.log(`[CACHE SET] Cached data for ${key}`);
  }

  getHotelDetails(quoteId: string): any | null {
    const cached = this.hotelDetailsCache.get(quoteId);
    if (!cached) return null;
    if (this.isExpired(cached.timestamp)) {
      this.hotelDetailsCache.delete(quoteId);
      this.logger.debug(`[CACHE EXPIRED] Removed stale hotel details cache for ${quoteId}`);
      return null;
    }
    this.logger.log(`[CACHE HIT] Hotel details from cache for ${quoteId}`);
    return cached.data;
  }

  setHotelDetails(quoteId: string, data: any): void {
    this.evictOldestIfNeeded(this.hotelDetailsCache);
    this.hotelDetailsCache.set(quoteId, { data, timestamp: Date.now() });
    this.logger.log(`[CACHE SET] Hotel details cached for ${quoteId}`);
  }

  clearForQuote(quoteId: string): void {
    const keysToDelete: string[] = [];
    this.hotelDetailsCache.delete(quoteId);
    for (const key of this.roomDetailsCache.keys()) {
      if (key.startsWith(`${quoteId}:`)) keysToDelete.push(key);
    }
    keysToDelete.push(quoteId);
    for (const key of keysToDelete) {
      this.roomDetailsCache.delete(key);
      this.logger.log(`[CACHE CLEARED] Removed cache for ${key}`);
    }
  }

  getStats(): { size: number; entries: string[] } {
    const detailEntries = Array.from(this.hotelDetailsCache.keys()).map((key) => `details:${key}`);
    const roomEntries = Array.from(this.roomDetailsCache.keys()).map((key) => `rooms:${key}`);
    return {
      size: this.hotelDetailsCache.size + this.roomDetailsCache.size,
      entries: [...detailEntries, ...roomEntries],
    };
  }
}
