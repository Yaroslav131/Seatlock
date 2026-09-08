import { ApiProperty } from '@nestjs/swagger';

export class HeldSeatDto {
  @ApiProperty() seatId!: string;
}
