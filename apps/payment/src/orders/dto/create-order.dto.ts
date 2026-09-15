import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class CreateOrderDto {
  @ApiProperty({ description: 'id события (catalog)' })
  @IsUUID()
  eventId!: string;

  @ApiProperty({ description: 'id места (catalog), которое сейчас держит вызывающий' })
  @IsUUID()
  seatId!: string;
}
