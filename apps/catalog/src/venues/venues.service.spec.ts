import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { VenuesService } from './venues.service';

function createPrismaMock() {
  return {
    venue: {
      create: jest.fn(),
      findUnique: jest.fn(),
    },
    seat: {
      createMany: jest.fn(),
    },
  };
}

type PrismaMock = ReturnType<typeof createPrismaMock>;

describe('VenuesService', () => {
  let prisma: PrismaMock;
  let service: VenuesService;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new VenuesService(prisma as unknown as PrismaService);
  });

  describe('findOne', () => {
    it('бросает NotFoundException, если зала нет', async () => {
      prisma.venue.findUnique.mockResolvedValue(null);
      await expect(service.findOne('missing')).rejects.toThrow(NotFoundException);
    });

    it('считает количество мест через _count', async () => {
      prisma.venue.findUnique.mockResolvedValue({
        id: 'v1',
        name: 'Зал',
        city: 'СПб',
        address: 'ул. Тестовая',
        _count: { seats: 42 },
      });

      const venue = await service.findOne('v1');
      expect(venue.seatCount).toBe(42);
    });
  });

  describe('generateSeats', () => {
    it('генерирует ровно rows × seatsPerRow мест', async () => {
      prisma.venue.findUnique.mockResolvedValue({
        id: 'v1',
        _count: { seats: 0 },
      });
      prisma.seat.createMany.mockResolvedValue({ count: 15 });

      const result = await service.generateSeats('v1', { rows: 3, seatsPerRow: 5 });

      expect(prisma.seat.createMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          { venueId: 'v1', section: null, row: 1, number: 1 },
          { venueId: 'v1', section: null, row: 3, number: 5 },
        ]),
        skipDuplicates: true,
      });
      const [[{ data }]] = prisma.seat.createMany.mock.calls;
      expect(data).toHaveLength(15);
      expect(result).toEqual({ created: 15 });
    });

    it('падает раньше похода в seat.createMany, если зала нет', async () => {
      prisma.venue.findUnique.mockResolvedValue(null);

      await expect(service.generateSeats('missing', { rows: 2, seatsPerRow: 2 })).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.seat.createMany).not.toHaveBeenCalled();
    });
  });
});
