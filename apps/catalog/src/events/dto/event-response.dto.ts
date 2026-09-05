import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class EventResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() venueId!: string;
  @ApiProperty() organizerId!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional() description!: string | null;
  @ApiProperty() startsAt!: Date;
  @ApiProperty() basePriceCents!: number;
  @ApiProperty({ enum: ['DRAFT', 'PUBLISHED', 'CANCELLED'] }) status!: string;
}
