import { Controller, Get, Param, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { SeatStatus, SeatStatusService } from './seat-status.service';

@ApiTags('seat-status')
@Controller('events/:eventId/seat-status')
export class SeatStatusController {
  constructor(private readonly seatStatus: SeatStatusService) {}

  @ApiOperation({
    summary:
      'Состояние карты мест одним запросом: занятые, проданные и (с токеном) свой холд. ' +
      'Заменяет три отдельных запроса, которые карта делала при каждом опросе.',
  })
  @ApiResponse({ status: 200, description: '{ held: [{seatId}], sold: [{seatId}], myHold }' })
  @Get()
  get(@Param('eventId') eventId: string, @Req() req: Request): Promise<SeatStatus> {
    return this.seatStatus.get(eventId, {
      authorization: req.headers.authorization,
      requestId: req.headers['x-request-id'] as string | undefined,
    });
  }
}
