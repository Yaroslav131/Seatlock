import { ApiProperty } from '@nestjs/swagger';

export class TokenResponseDto {
  @ApiProperty({ description: 'JWT, живёт 15 минут' })
  accessToken!: string;
}
