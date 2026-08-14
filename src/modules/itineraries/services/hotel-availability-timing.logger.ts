import * as fs from 'fs';
import * as path from 'path';

export class HotelAvailabilityTimingLogger {
  private static readonly logPath = path.join(
    process.cwd(),
    'tmp',
    'hotel-availability-timing.log',
  );

  static log(event: string, details: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      fs.appendFileSync(
        this.logPath,
        `[${new Date().toISOString()}] ${event} ${JSON.stringify(details)}\n`,
        'utf8',
      );
    } catch {
      // Timing diagnostics must never affect hotel availability behavior.
    }
  }
}
