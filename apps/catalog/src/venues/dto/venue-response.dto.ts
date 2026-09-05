import { ApiProperty } from '@nestjs/swagger';

export class VenueResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() city!: string;
  @ApiProperty() address!: string;
  @ApiProperty({ description: 'Сколько мест уже сгенерировано в этом зале' })
  seatCount!: number;
}
