import { Module } from '@nestjs/common';
import { SeatStatusController } from './seat-status.controller';
import { SeatStatusService } from './seat-status.service';

@Module({
  controllers: [SeatStatusController],
  providers: [SeatStatusService],
})
export class SeatStatusModule {}
