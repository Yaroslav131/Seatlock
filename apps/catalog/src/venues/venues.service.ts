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

  async findOne(id: string): Promise<VenueResponseDto> {
    const venue = await this.prisma.venue.findUnique({
      where: { id },
      include: { _count: { select: { seats: true } } },
    });
    if (!venue) {
      throw new NotFoundException('Зал не найден');
    }
    return { ...venue, seatCount: venue._count.seats };
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
