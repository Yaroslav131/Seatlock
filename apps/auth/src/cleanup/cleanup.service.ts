import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CleanupService {
  private readonly logger = new Logger(CleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Не отозванные раньше срока — только по-настоящему истёкшие.
  // Отозванная (но ещё не истёкшая) строка всё ещё нужна: если кто-то
  // предъявит этот токен повторно, именно по ней мы поймём, что это
  // кража, а не просто "токен не найден".
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeExpiredRefreshTokens(): Promise<void> {
    const { count } = await this.prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    if (count > 0) {
      this.logger.log(`удалено истёкших refresh-токенов: ${count}`);
    }
  }
}
