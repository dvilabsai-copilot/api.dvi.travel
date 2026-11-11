import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { HotelBlockingService } from './hotel-blocking.service';

const POLL_INTERVAL_MS = 60_000;

@Injectable()
export class TboVoucherRetryScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TboVoucherRetryScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly hotelBlocking: HotelBlockingService) {}

  onModuleInit() {
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), POLL_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(now = new Date()) {
    if (this.running) return { processed: 0, skipped: true };
    this.running = true;
    try {
      return await this.hotelBlocking.retryDueTboVouchers(now);
    } catch (error) {
      this.logger.error(`VSR voucher retry scan failed: ${error instanceof Error ? error.message : String(error)}`);
      return { processed: 0, error: true };
    } finally {
      this.running = false;
    }
  }
}
