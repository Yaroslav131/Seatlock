import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class CreateVenueDto {
  @ApiProperty({ example: 'Дворец спорта "Юбилейный"' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ example: 'Санкт-Петербург' })
  @IsString()
  @MinLength(2)
  city!: string;

  @ApiProperty({ example: 'пр. Добролюбова, 18' })
  @IsString()
  @MinLength(2)
  address!: string;
}
