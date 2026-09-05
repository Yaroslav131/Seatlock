import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateVenueDto } from './dto/create-venue.dto';
import { GenerateSeatsDto } from './dto/generate-seats.dto';
import { VenueResponseDto } from './dto/venue-response.dto';

@Injectable()
export class VenuesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateVenueDto): Promise<VenueResponseDto> {
    const venue = await this.prisma.venue.create({ data: dto });
    return { ...venue, seatCount: 0 };
  }

  /**
   * Залы не принадлежат конкретному организатору (в отличие от
   * событий) — это общая инфраструктура, которую может переиспользовать
   * любой организатор для своих событий. Поэтому список без фильтра.
   */
  async findAll(): Promise<VenueResponseDto[]> {
    const venues = await this.prisma.venue.findMany({
      include: { _count: { select: { seats: true } } },
      orderBy: { createdAt: 'desc' },
    });
    // Деструктурируем _count явно, а не просто ...venue — иначе он
    // утекает в JSON-ответ API как есть, это внутренняя форма запроса
    // Prisma, а не то, что должен видеть клиент.
    return venues.map(({ _count, ...venue }) => ({ ...venue, seatCount: _count.seats }));
  }

  async findOne(id: string): Promise<VenueResponseDto> {
    const venue = await this.prisma.venue.findUnique({
      where: { id },
      include: { _count: { select: { seats: true } } },
    });
    if (!venue) {
      throw new NotFoundException('Зал не найден');
    }
    const { _count, ...rest } = venue;
    return { ...rest, seatCount: _count.seats };
  }

  /**
   * Генерирует прямоугольную сетку мест (ряды × места в ряду).
   * skipDuplicates спасает от повторного вызова на тот же зал/секцию —
   * уникальность (venueId, section, row, number) уже гарантирует база,
   * здесь просто не хотим падать с ошибкой на дублях.
   */
  async generateSeats(venueId: string, dto: GenerateSeatsDto): Promise<{ created: number }> {
    await this.findOne(venueId);

    const seats = Array.from({ length: dto.rows }, (_, rowIndex) =>
      Array.from({ length: dto.seatsPerRow }, (_, seatIndex) => ({
        venueId,
        section: dto.section ?? null,
        row: rowIndex + 1,
        number: seatIndex + 1,
      })),
    ).flat();

    const result = await this.prisma.seat.createMany({ data: seats, skipDuplicates: true });
    return { created: result.count };
  }
}
