import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class OrderResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() eventId!: string;
  @ApiProperty() seatId!: string;
  @ApiProperty() amountCents!: number;
  @ApiProperty({ enum: ['PENDING', 'PAID', 'CANCELLED', 'REFUNDED'] }) status!: string;
  @ApiPropertyOptional() providerIntentId!: string | null;
}

export class CreateOrderResponseDto extends OrderResponseDto {
  @ApiProperty({
    description:
      'Нужен фронту, чтобы подтвердить оплату через SDK провайдера (форма вне скоупа этой фазы)',
  })
  clientSecret!: string;
}
