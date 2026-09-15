import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import * as amqp from 'amqplib';
import { PAYMENT_EVENTS_EXCHANGE, RABBITMQ_CHANNEL } from '../rabbitmq/rabbitmq.module';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RABBITMQ_CHANNEL) private readonly channel: amqp.ConfirmChannel,
  ) {}

  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: string; service: string }> {
    try {
      // checkExchange — настоящий RPC к брокеру (не просто чтение
      // локального свойства): резолвится, только если канал/соединение
      // живы и exchange существует; у amqplib нет отдельного "ping".
      await Promise.all([
        this.prisma.$queryRaw`SELECT 1`,
        this.channel.checkExchange(PAYMENT_EVENTS_EXCHANGE),
      ]);
      return { status: 'ok', service: 'payment' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ServiceUnavailableException({
        status: 'error',
        service: 'payment',
        error: message,
      });
    }
  }
}
