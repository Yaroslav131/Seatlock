import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class HoldSeatDto {
  @ApiProperty({ description: 'id места из каталога (Seat.id)' })
  @IsUUID()
  seatId!: string;
}
