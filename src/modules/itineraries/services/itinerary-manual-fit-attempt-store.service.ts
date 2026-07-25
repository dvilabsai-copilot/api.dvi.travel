import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';

/** Owns the manual-fit preview attempt table and its bounded in-memory cache. */
@Injectable()
export class ItineraryManualFitAttemptStoreService {
  private readonly cache = new Map<string, any>();
  private tableEnsured = false;

  constructor(private readonly prisma: PrismaService) {}

  async ensureTable(): Promise<void> {
    if (this.tableEnsured) return;

    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS dvi_manual_fit_preview_attempts (
        id BIGINT NOT NULL AUTO_INCREMENT,
        attempt_id VARCHAR(64) NOT NULL,
        itinerary_plan_id INT NOT NULL,
        itinerary_route_id INT NOT NULL,
        selected_hotspot_id INT NOT NULL,
        payload_json LONGTEXT NOT NULL,
        expires_at DATETIME NOT NULL,
        created_on DATETIME NOT NULL,
        updated_on DATETIME NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_manual_fit_preview_attempt (attempt_id),
        KEY idx_manual_fit_preview_expires_at (expires_at),
        KEY idx_manual_fit_preview_plan_route (itinerary_plan_id, itinerary_route_id)
      )
    `);

    this.tableEnsured = true;
  }

  private parseEntry(value: any): any | null {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object') return null;

    const attemptId = String(parsed?.attemptId || '').trim();
    const planId = Number(parsed?.planId || 0);
    const routeId = Number(parsed?.routeId || 0);
    const selectedHotspotId = Number(parsed?.selectedHotspotId || 0);
    const expiresAt = String(parsed?.expiresAt || '').trim();
    if (!attemptId || !(planId > 0) || !(routeId > 0) || !(selectedHotspotId > 0) || !expiresAt) return null;
    return parsed;
  }

  async save(entry: any): Promise<void> {
    const attemptId = String(entry?.attemptId || '').trim();
    if (!attemptId) return;

    await this.ensureTable();
    const now = new Date();
    const expiresAt = new Date(entry.expiresAt);
    await this.prisma.$executeRawUnsafe(
      `
        INSERT INTO dvi_manual_fit_preview_attempts (
          attempt_id,
          itinerary_plan_id,
          itinerary_route_id,
          selected_hotspot_id,
          payload_json,
          expires_at,
          created_on,
          updated_on
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          itinerary_plan_id = VALUES(itinerary_plan_id),
          itinerary_route_id = VALUES(itinerary_route_id),
          selected_hotspot_id = VALUES(selected_hotspot_id),
          payload_json = VALUES(payload_json),
          expires_at = VALUES(expires_at),
          updated_on = VALUES(updated_on)
      `,
      attemptId,
      Number(entry.planId || 0),
      Number(entry.routeId || 0),
      Number(entry.selectedHotspotId || 0),
      JSON.stringify(entry),
      Number.isFinite(expiresAt.getTime()) ? expiresAt : new Date(Date.now() + 10 * 60 * 1000),
      now,
      now,
    );
    this.cache.set(attemptId, entry);
  }

  async load(attemptId: string): Promise<any | null> {
    const normalizedAttemptId = String(attemptId || '').trim();
    if (!normalizedAttemptId) return null;
    const cached = this.cache.get(normalizedAttemptId);
    if (cached) return cached;

    await this.ensureTable();
    const rows = await this.prisma.$queryRawUnsafe<Array<{ payload_json: string }>>(
      `
        SELECT payload_json
        FROM dvi_manual_fit_preview_attempts
        WHERE attempt_id = ?
        LIMIT 1
      `,
      normalizedAttemptId,
    );
    const payloadText = String(rows?.[0]?.payload_json || '').trim();
    if (!payloadText) return null;

    try {
      const parsed = this.parseEntry(payloadText);
      if (!parsed) return null;
      this.cache.set(normalizedAttemptId, parsed);
      return parsed;
    } catch (error) {
 console.warn('[FitHere][attempt_store_parse_failed]', {
        attemptId: normalizedAttemptId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async delete(attemptId: string): Promise<void> {
    const normalizedAttemptId = String(attemptId || '').trim();
    if (!normalizedAttemptId) return;
    this.cache.delete(normalizedAttemptId);
    await this.ensureTable();
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM dvi_manual_fit_preview_attempts WHERE attempt_id = ?`,
      normalizedAttemptId,
    );
  }
}
