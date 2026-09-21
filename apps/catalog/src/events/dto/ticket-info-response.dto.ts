import { ApiProperty } from '@nestjs/swagger';

export class TicketInfoResponseDto {
  @ApiProperty() eventTitle!: string;
  @ApiProperty({ description: 'ISO 8601' }) startsAt!: string;
  @ApiProperty() venueName!: string;
  @ApiProperty() venueCity!: string;
  @ApiProperty() venueAddress!: string;
  @ApiProperty({ nullable: true, type: String }) seatSection!: string | null;
  @ApiProperty() seatRow!: number;
  @ApiProperty() seatNumber!: number;
}
