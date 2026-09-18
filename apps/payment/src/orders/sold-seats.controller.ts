import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SoldSeatDto } from './dto/sold-seat.dto';
import { OrdersService } from './orders.service';

// Отдельный контроллер, не метод в OrdersController — другой базовый путь
// (events/:eventId, не orders) и другая граница доверия: публично, без
// гварда, тем же принципом, что и HoldsController.listHeld в booking
// ("занятые места — публично, для карты зала").
@ApiTags('orders')
@Controller('events/:eventId')
export class SoldSeatsController {
  constructor(private readonly orders: OrdersService) {}

  @ApiOperation({ summary: 'Проданные (PAID) места события — публично, для карты зала' })
  @ApiResponse({ status: 200, type: [SoldSeatDto] })
  @Get('sold-seats')
  async listSold(@Param('eventId') eventId: string): Promise<SoldSeatDto[]> {
    const seatIds = await this.orders.listSoldSeatIds(eventId);
    return seatIds.map((seatId) => ({ seatId }));
  }
}
