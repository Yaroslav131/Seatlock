import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventStatus } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { EventsService } from './events.service';

function createPrismaMock() {
  return {
    venue: { findUnique: jest.fn() },
    event: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
    },
  };
}

function createRedisMock() {
  return { get: jest.fn(), set: jest.fn(), del: jest.fn() };
}

type PrismaMock = ReturnType<typeof createPrismaMock>;
type RedisMock = ReturnType<typeof createRedisMock>;

describe('EventsService', () => {
  let prisma: PrismaMock;
  let redis: RedisMock;
  let service: EventsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    redis = createRedisMock();
    service = new EventsService(prisma as unknown as PrismaService, redis as never);
  });

  describe('create', () => {
    it('бросает NotFoundException, если зала нет', async () => {
      prisma.venue.findUnique.mockResolvedValue(null);

      await expect(
        service.create(
          {
            venueId: 'missing',
            title: 'T',
            startsAt: '2026-01-01T00:00:00.000Z',
            basePriceCents: 100,
          },
          'organizer-1',
        ),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.event.create).not.toHaveBeenCalled();
    });
  });

  describe('publish', () => {
    const draftEvent = {
      id: 'e1',
      organizerId: 'organizer-1',
      status: EventStatus.DRAFT,
    };

    it('организатор может опубликовать своё событие', async () => {
      prisma.event.findUnique.mockResolvedValue(draftEvent);
      prisma.event.update.mockResolvedValue({ ...draftEvent, status: EventStatus.PUBLISHED });

      await service.publish('e1', 'organizer-1', 'ORGANIZER');

      expect(prisma.event.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: { status: EventStatus.PUBLISHED },
      });
    });

    it('организатор НЕ может опубликовать чужое событие', async () => {
      prisma.event.findUnique.mockResolvedValue(draftEvent);

      await expect(service.publish('e1', 'someone-else', 'ORGANIZER')).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.event.update).not.toHaveBeenCalled();
    });

    it('админ может опубликовать чужое событие', async () => {
      prisma.event.findUnique.mockResolvedValue(draftEvent);
      prisma.event.update.mockResolvedValue({ ...draftEvent, status: EventStatus.PUBLISHED });

      await service.publish('e1', 'some-admin', 'ADMIN');

      expect(prisma.event.update).toHaveBeenCalled();
    });

    it('нельзя опубликовать уже не черновик', async () => {
      prisma.event.findUnique.mockResolvedValue({ ...draftEvent, status: EventStatus.PUBLISHED });

      await expect(service.publish('e1', 'organizer-1', 'ORGANIZER')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('после публикации чистит и список, и карточку события в кэше', async () => {
      prisma.event.findUnique.mockResolvedValue(draftEvent);
      prisma.event.update.mockResolvedValue({ ...draftEvent, status: EventStatus.PUBLISHED });

      await service.publish('e1', 'organizer-1', 'ORGANIZER');

      expect(redis.del).toHaveBeenCalledWith('catalog:events:published', 'catalog:events:e1');
    });
  });

  describe('findMine', () => {
    it('фильтрует по organizerId, а не отдаёт вообще всё', async () => {
      prisma.event.findMany.mockResolvedValue([{ id: 'e1', organizerId: 'organizer-1' }]);

      const events = await service.findMine('organizer-1');

      expect(prisma.event.findMany).toHaveBeenCalledWith({
        where: { organizerId: 'organizer-1' },
        orderBy: { createdAt: 'desc' },
      });
      expect(events).toEqual([{ id: 'e1', organizerId: 'organizer-1' }]);
    });
  });

  describe('findPublished', () => {
    it('отдаёт из кэша, не трогая базу, если кэш есть', async () => {
      redis.get.mockResolvedValue(JSON.stringify([{ id: 'e1' }]));

      const events = await service.findPublished();

      expect(events).toEqual([{ id: 'e1' }]);
      expect(prisma.event.findMany).not.toHaveBeenCalled();
    });

    it('идёт в базу и заполняет кэш при промахе', async () => {
      redis.get.mockResolvedValue(null);
      prisma.event.findMany.mockResolvedValue([{ id: 'e1' }]);

      const events = await service.findPublished();

      expect(events).toEqual([{ id: 'e1' }]);
      expect(redis.set).toHaveBeenCalledWith(
        'catalog:events:published',
        JSON.stringify([{ id: 'e1' }]),
        'EX',
        60,
      );
    });
  });
});
