import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import * as amqp from 'amqplib';
import { ORDER_PAID_QUEUE, RABBITMQ_CHANNEL } from '../rabbitmq/rabbitmq.module';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RABBITMQ_CHANNEL) private readonly channel: amqp.Channel,
  ) {}

  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: string; service: string }> {
    try {
      // checkQueue — настоящий RPC к брокеру: резолвится, только если
      // канал/соединение живы и очередь реально существует.
      await Promise.all([
        this.prisma.$queryRaw`SELECT 1`,
        this.channel.checkQueue(ORDER_PAID_QUEUE),
      ]);
      return { status: 'ok', service: 'notification' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ServiceUnavailableException({
        status: 'error',
        service: 'notification',
        error: message,
      });
    }
  }
}
