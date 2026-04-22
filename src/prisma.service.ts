import { INestApplication, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly sqlLogger = new Logger('PrismaSQL');

  constructor() {
    super({
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'stdout', level: 'info' },
        { emit: 'stdout', level: 'warn' },
        { emit: 'stdout', level: 'error' },
      ],
    });
    (this as any).$on('query', (e: any) => {
      this.sqlLogger.debug(
        `QUERY: ${e.query} | PARAMS: ${e.params} | DURATION: ${e.duration}ms`,
      );
    });
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
    process.on('SIGINT', shutdown);   // Ctrl+C
    process.on('SIGTERM', shutdown);  // kill
    process.on('SIGQUIT', shutdown);
  }
}
