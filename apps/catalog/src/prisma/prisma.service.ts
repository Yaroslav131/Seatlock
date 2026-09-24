import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma';
import { prismaOptions } from './database-url';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    // Размер пула соединений задаётся явно (DB_POOL_SIZE), см. database-url.ts.
    super(prismaOptions(process.env.CATALOG_DATABASE_URL));
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('закрываю соединение с базой');
    await this.$disconnect();
  }
}
