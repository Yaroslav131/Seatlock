import { ApiProperty } from '@nestjs/swagger';

export class SoldSeatDto {
  @ApiProperty() seatId!: string;
}
