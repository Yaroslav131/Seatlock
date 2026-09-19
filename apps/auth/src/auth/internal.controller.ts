import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { PrismaService } from '../prisma/prisma.service';

// Внутренний server-to-server эндпоинт: notification асинхронно
// обрабатывает order.paid из RabbitMQ и не может достать email
// покупателя из JWT (в отличие от payment→booking/catalog, здесь
// нет исходного HTTP-запроса с токеном, который можно было бы
// переслать). Без гварда — как Postgres/Redis/RabbitMQ в этом
// проекте, граница доверия сетевая: gateway не проксирует
// /api/internal/*, порт auth наружу не публикуется (см.
// docker-compose.prod.yml), снаружи этот путь недостижим.
// Без @SkipThrottle общий лимит auth (20 запросов/мин на IP, см. app.module.ts)
// считал бы и этот эндпоинт: notification вызывает его на каждое оплаченное
// место с одного и того же адреса, и после 20 билетов в минуту auth отвечал
// бы 429, а билеты уходили в DLQ (нашли нагрузочным тестом). Лимит защищает
// публичные login/register от перебора, а здесь вызывающий — свой сервис.
@SkipThrottle()
@Controller('internal/users')
export class InternalController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':id')
  async findEmail(@Param('id') id: string): Promise<{ id: string; email: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true },
    });
    if (!user) {
      throw new NotFoundException('Пользователь не найден');
    }
    return user;
  }
}
