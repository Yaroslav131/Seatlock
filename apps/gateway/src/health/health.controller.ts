import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { HealthReport, HealthService } from './health.service';

/**
 * Два разных эндпоинта, и это не дублирование:
 *
 *   GET /health       — liveness. «Процесс жив». Если он ответит 500,
 *                       оркестратор перезапустит контейнер.
 *   GET /health/ready — readiness. «Готов принимать трафик».
 *                       Если база недоступна — 503, и балансировщик
 *                       перестанет слать сюда запросы, но контейнер
 *                       НЕ перезапустит: перезапуск базу не починит.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<HealthReport> {
    const report = await this.health.check();

    // Отдаём 503 с полным отчётом внутри — видно, какая именно
    // зависимость легла, без похода в логи.
    if (report.status !== 'ok') {
      throw new ServiceUnavailableException(report);
    }

    return report;
  }
}
