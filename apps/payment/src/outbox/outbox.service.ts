import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma';

/**
 * Тонкая обёртка на одну строку — существует ради явного имени в
 * коде саги (orders.service.ts/payment-webhook.service.ts), а не ради
 * логики. Принципиально принимает Prisma-транзакцию (tx), а не
 * PrismaService напрямую: строка должна коммититься в ТОЙ ЖЕ
 * транзакции, что и смена статуса заказа — это и есть transactional
 * outbox, без него между "заказ оплачен в БД" и "событие записано"
 * было бы окно для потери события.
 */
@Injectable()
export class OutboxService {
  record(
    tx: Prisma.TransactionClient,
    eventType: string,
    payload: Prisma.InputJsonObject,
  ): Promise<{ id: string }> {
    return tx.outboxEvent.create({ data: { eventType, payload }, select: { id: true } });
  }
}
