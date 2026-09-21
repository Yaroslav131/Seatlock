import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TtlCache } from '../cache/ttl-cache';
import { isTimeoutError } from '../http/errors';
import { gatewayCacheTotal, gatewayUpstreamErrorsTotal } from '../metrics/metrics';

export interface SeatStatus {
  held: { seatId: string }[];
  sold: { seatId: string }[];
  myHold: { seatId: string; expiresAt: string } | null;
}

// Публичная часть (занятые и проданные места) не персональна и одинакова для всех
// зрителей события, поэтому её достаточно запрашивать у сервисов раз в секунду.
// Секунда — потому что карта опрашивает раз в 7 с, и отставание в секунду не видно,
// а на горячем событии сотни зрителей не превращаются в сотни запросов в booking/payment.
const PUBLIC_PART_TTL_MS = 1_000;

// Идентификатор попадает в URL сервиса, поэтому не пускаем ничего кроме безопасных символов.
const EVENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Один запрос вместо трёх для карты мест: занятые места (booking), проданные (payment)
 * и собственный холд пользователя (booking, только с токеном).
 */
@Injectable()
export class SeatStatusService {
  private readonly cache = new TtlCache<{ seatId: string }[]>();
  private readonly bookingUrl: string;
  private readonly paymentUrl: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.bookingUrl = config.get<string>('BOOKING_SERVICE_URL', 'http://localhost:3003');
    this.paymentUrl = config.get<string>('PAYMENT_SERVICE_URL', 'http://localhost:3004');
    this.timeoutMs = Number(config.get<string>('UPSTREAM_TIMEOUT_MS', '15000'));
  }

  async get(
    eventId: string,
    headers: { authorization?: string; requestId?: string; fresh?: boolean },
  ): Promise<SeatStatus> {
    if (!EVENT_ID.test(eventId)) {
      throw new BadRequestException('Некорректный идентификатор события');
    }

    // fresh: пользователь только что сам занял или отпустил место и должен увидеть
    // результат, а не секундную давность (иначе отпущенное им место до следующего
    // опроса показывалось бы «занятым»). Только с токеном: анонимный запрос
    // не может обойти кеш и создать лавину запросов к сервисам.
    if (headers.fresh && headers.authorization) {
      this.cache.delete(`held:${eventId}`);
      this.cache.delete(`sold:${eventId}`);
    }

    const [held, sold, myHold] = await Promise.all([
      this.publicPart(
        'booking',
        `held:${eventId}`,
        `${this.bookingUrl}/api/booking/events/${eventId}/holds`,
        headers.requestId,
      ),
      this.publicPart(
        'payment',
        `sold:${eventId}`,
        `${this.paymentUrl}/api/payment/events/${eventId}/sold-seats`,
        headers.requestId,
      ),
      headers.authorization ? this.myHold(eventId, headers.authorization, headers.requestId) : null,
    ]);
    return { held, sold, myHold };
  }

  private async publicPart(
    service: 'booking' | 'payment',
    key: string,
    url: string,
    requestId?: string,
  ): Promise<{ seatId: string }[]> {
    const { value, source } = await this.cache.get(key, PUBLIC_PART_TTL_MS, async () => {
      const response = await this.fetchUpstream(service, url, { requestId });
      if (!response.ok) {
        // Ошибку не кешируем и не маскируем под пустой список: карта показала бы
        // все места свободными.
        throw new BadGatewayException('Сервис временно недоступен');
      }
      return { value: (await response.json()) as { seatId: string }[], cacheable: true };
    });
    gatewayCacheTotal.inc({ result: source });
    return value;
  }

  private async myHold(
    eventId: string,
    authorization: string,
    requestId?: string,
  ): Promise<SeatStatus['myHold']> {
    const response = await this.fetchUpstream(
      'booking',
      `${this.bookingUrl}/api/booking/events/${eventId}/my-hold`,
      { authorization, requestId },
    );
    if (response.status === 401 || response.status === 403) {
      // Просроченный токен возвращаем как есть: клиент по 401 обновит токен и повторит
      // запрос, как для любого другого защищённого маршрута.
      throw new HttpException(await response.text(), response.status);
    }
    if (!response.ok) {
      throw new BadGatewayException('Сервис временно недоступен');
    }
    // «Холда нет» booking отдаёт пустым телом, а не литералом null.
    const text = await response.text();
    return text ? (JSON.parse(text) as SeatStatus['myHold']) : null;
  }

  private async fetchUpstream(
    service: 'booking' | 'payment',
    url: string,
    headers: { authorization?: string; requestId?: string },
  ): Promise<Response> {
    try {
      return await fetch(url, {
        headers: {
          ...(headers.authorization ? { authorization: headers.authorization } : {}),
          ...(headers.requestId ? { 'x-request-id': headers.requestId } : {}),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = isTimeoutError(error);
      gatewayUpstreamErrorsTotal.inc({ service, kind: timedOut ? 'timeout' : 'unreachable' });
      throw timedOut
        ? new GatewayTimeoutException('Сервис не ответил вовремя')
        : new BadGatewayException('Сервис временно недоступен');
    }
  }
}
