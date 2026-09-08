import { ApiProperty } from '@nestjs/swagger';

export class HoldResponseDto {
  @ApiProperty() seatId!: string;
  @ApiProperty({ description: 'ISO-момент истечения холда' }) expiresAt!: string;
}
