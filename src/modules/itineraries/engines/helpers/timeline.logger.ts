import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';

export class TimelineLogger {
  private static readonly logger = new Logger('Timeline');
  private static readonly logPath = path.join(process.cwd(), 'tmp', 'engine_debug.log');
  private static readonly fileLoggingEnabled = TimelineLogger.isEnabled(
    process.env.ENABLE_FILE_LOG ?? process.env.ENABLE_LOG,
  );

  private static isEnabled(value: string | undefined): boolean {
    return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
  }

  private static formatValue(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.stack || value.message;
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';

    try {
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
    } catch {
      return '[unserializable value]';
    }
  }

  static log(message: string, ...args: any[]) {
    const timestamp = new Date().toISOString();
    const renderedMessage = [message, ...args].map((value) => this.formatValue(value)).join(' ');
    const formattedMessage = `[${timestamp}] ${renderedMessage}\n`;

    // Nest controls whether debug output is emitted according to LOG_LEVELS.
    this.logger.debug(renderedMessage);

    if (this.fileLoggingEnabled) {
      try {
        const dir = path.dirname(this.logPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.appendFileSync(this.logPath, formattedMessage);
      } catch (err) {
        this.logger.error(`Failed to write to log file: ${this.formatValue(err)}`);
      }
    }
  }

  static clear() {
    if (this.fileLoggingEnabled && fs.existsSync(this.logPath)) {
      try {
        fs.writeFileSync(this.logPath, '');
      } catch (err) {
        this.logger.error(`Failed to clear log file: ${this.formatValue(err)}`);
      }
    }
  }
}
