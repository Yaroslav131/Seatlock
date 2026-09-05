import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsInt, IsOptional, IsString, IsUUID, Min, MinLength } from 'class-validator';

export class CreateEventDto {
  @ApiProperty({ description: 'id зала' })
  @IsUUID()
  venueId!: string;

  @ApiProperty({ example: 'Концерт группы «Аврора»' })
  @IsString()
  @MinLength(2)
  title!: string;

  @ApiPropertyOptional({ example: 'Большой сольный концерт' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: '2026-12-20T19:00:00.000Z' })
  @IsISO8601()
  startsAt!: string;

  @ApiProperty({ description: 'Базовая цена в копейках', example: 250000, minimum: 0 })
  @IsInt()
  @Min(0)
  basePriceCents!: number;
}
