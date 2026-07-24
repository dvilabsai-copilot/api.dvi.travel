import * as fs from 'fs';
import * as path from 'path';

export class TimelineLogger {
  private static logPath = path.join(process.cwd(), 'tmp', 'engine_debug.log');
  private static enabled = process.env.ENABLE_LOG === '1' || process.env.ENABLE_LOG === 'true';

  static log(message: string, ...args: any[]) {
    const timestamp = new Date().toISOString();
    const formattedMessage = `[${timestamp}] ${message} ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}\n`;

 // Always log to console for visibility in terminal
 console.log(message, ...args);

    if (this.enabled) {
      try {
 // Ensure tmp directory exists
        const dir = path.dirname(this.logPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.appendFileSync(this.logPath, formattedMessage);
      } catch (err) {
 console.error('Failed to write to log file:', err);
      }
    }
  }

  static clear() {
    if (this.enabled && fs.existsSync(this.logPath)) {
      try {
        fs.writeFileSync(this.logPath, '');
      } catch (err) {
 console.error('Failed to clear log file:', err);
      }
    }
  }
}
