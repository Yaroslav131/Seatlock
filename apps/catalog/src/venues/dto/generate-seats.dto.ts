import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class GenerateSeatsDto {
  @ApiProperty({ minimum: 1, maximum: 500, example: 20 })
  @IsInt()
  @Min(1)
  @Max(500)
  rows!: number;

  @ApiProperty({ minimum: 1, maximum: 200, example: 30 })
  @IsInt()
  @Min(1)
  @Max(200)
  seatsPerRow!: number;

  @ApiPropertyOptional({ example: 'Партер' })
  @IsOptional()
  @IsString()
  section?: string;
}
