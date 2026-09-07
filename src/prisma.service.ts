import { INestApplication, Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

const isEnabled = (value: string | undefined) =>
  ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());

const compactSql = (query: string) => query.replace(/\s+/g, ' ').trim().slice(0, 1000);

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private static instance: PrismaService | null = null;

  constructor() {
    if (PrismaService.instance) {
      return PrismaService.instance;
    }

    const profileQueries = isEnabled(process.env.PRISMA_PROFILE_QUERIES);
    const slowQueryMs = Math.max(0, Number(process.env.PRISMA_SLOW_QUERY_MS || 100));

    super({
      log: [
        { emit: 'stdout', level: 'info' },
        { emit: 'stdout', level: 'warn' },
        { emit: 'stdout', level: 'error' },
        ...(profileQueries ? [{ emit: 'event' as const, level: 'query' as const }] : []),
      ],
    });

    PrismaService.instance = this;

    if (profileQueries) {
      this.$on('query' as never, (event: { duration: number; target: string; query: string }) => {
        if (event.duration < slowQueryMs) return;

        process.stdout.write(`${JSON.stringify({
          marker: 'PRISMA_SLOW_QUERY',
          durationMs: event.duration,
          target: event.target,
          query: compactSql(event.query),
        })}\n`);
      });
    }
  }

  async onModuleInit() {
    await this.$connect();
  }

 /**
   * With Prisma 5 library engine, use Node's process hooks instead of this.$on('beforeExit').
 */
  async enableShutdownHooks(app: INestApplication) {
    const shutdown = async () => {
 // Close Nest app (which will also disconnect Prisma)
      await app.close();
    };

 // Called when Node's event loop is about to exit
    process.on('beforeExit', shutdown);

 // Common termination signals during dev/prod
 process.on('SIGINT', shutdown); // Ctrl+C
 process.on('SIGTERM', shutdown); // kill
    process.on('SIGQUIT', shutdown);
  }
}
