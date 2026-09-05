import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EventStatus } from '../generated/prisma';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../cache/redis.module';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEventDto } from './dto/create-event.dto';
import { EventResponseDto } from './dto/event-response.dto';

const PUBLISHED_LIST_CACHE_KEY = 'catalog:events:published';
const CACHE_TTL_SECONDS = 60;

function eventCacheKey(id: string): string {
  return `catalog:events:${id}`;
}

@Injectable()
export class EventsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async create(dto: CreateEventDto, organizerId: string): Promise<EventResponseDto> {
    const venue = await this.prisma.venue.findUnique({ where: { id: dto.venueId } });
    if (!venue) {
      throw new NotFoundException('Зал не найден');
    }

    return this.prisma.event.create({
      data: {
        venueId: dto.venueId,
        organizerId,
        title: dto.title,
        description: dto.description,
        startsAt: new Date(dto.startsAt),
        basePriceCents: dto.basePriceCents,
      },
    });
  }

  /**
   * ADMIN публикует что угодно, ORGANIZER — только своё. Простая
   * проверка, но без неё любой организатор мог бы опубликовать
   * чужой черновик.
   */
  async publish(id: string, userId: string, userRole: string): Promise<EventResponseDto> {
    const event = await this.prisma.event.findUnique({ where: { id } });
    if (!event) {
      throw new NotFoundException('Событие не найдено');
    }
    if (userRole !== 'ADMIN' && event.organizerId !== userId) {
      throw new ForbiddenException('Публиковать можно только свои события');
    }
    if (event.status !== EventStatus.DRAFT) {
      throw new ForbiddenException('Публиковать можно только черновик');
    }

    const updated = await this.prisma.event.update({
      where: { id },
      data: { status: EventStatus.PUBLISHED },
    });

    // Инвалидация: список и конкретная карточка события могли
    // измениться — старый кэш теперь врёт.
    await this.redis.del(PUBLISHED_LIST_CACHE_KEY, eventCacheKey(id));

    return updated;
  }

  /**
   * Свои события в любом статусе — без этого организатор не увидит
   * собственный черновик нигде, кроме как запомнив id из ответа при
   * создании. Не кэшируем: маленькая, редко запрашиваемая, приватная
   * выборка, свежесть важнее экономии на одном запросе.
   */
  findMine(organizerId: string): Promise<EventResponseDto[]> {
    return this.prisma.event.findMany({
      where: { organizerId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findPublished(): Promise<EventResponseDto[]> {
    const cached = await this.redis.get(PUBLISHED_LIST_CACHE_KEY);
    if (cached) {
      return JSON.parse(cached) as EventResponseDto[];
    }

    const events = await this.prisma.event.findMany({
      where: { status: EventStatus.PUBLISHED },
      orderBy: { startsAt: 'asc' },
    });
    await this.redis.set(PUBLISHED_LIST_CACHE_KEY, JSON.stringify(events), 'EX', CACHE_TTL_SECONDS);
    return events;
  }

  async findOne(id: string): Promise<EventResponseDto> {
    const key = eventCacheKey(id);
    const cached = await this.redis.get(key);
    if (cached) {
      return JSON.parse(cached) as EventResponseDto;
    }

    const event = await this.prisma.event.findUnique({ where: { id } });
    if (!event) {
      throw new NotFoundException('Событие не найдено');
    }
    await this.redis.set(key, JSON.stringify(event), 'EX', CACHE_TTL_SECONDS);
    return event;
  }
}
