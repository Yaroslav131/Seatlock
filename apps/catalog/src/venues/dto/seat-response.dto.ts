import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SeatResponseDto {
  @ApiProperty() id!: string;
  @ApiPropertyOptional({ nullable: true }) section!: string | null;
  @ApiProperty() row!: number;
  @ApiProperty() number!: number;
}
