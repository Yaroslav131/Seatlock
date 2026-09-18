import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthenticatedUser } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CreateOrderDto } from './dto/create-order.dto';
import { CreateOrderResponseDto, OrderResponseDto } from './dto/order-response.dto';
import { OrdersService } from './orders.service';

@ApiTags('orders')
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @ApiOperation({
    summary:
      'Создать заказ на место, которое сейчас держит вызывающий (переносит холд booking в персистентный заказ)',
  })
  @ApiBearerAuth()
  @ApiResponse({ status: 201, type: CreateOrderResponseDto })
  @ApiResponse({
    status: 403,
    description: 'Нет активного холда на это место или событие не опубликовано',
  })
  @ApiResponse({ status: 409, description: 'Место уже покупается кем-то другим' })
  @UseGuards(JwtAuthGuard)
  @Post()
  async create(
    @Body() dto: CreateOrderDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<CreateOrderResponseDto> {
    // Пробрасываем ТОТ ЖЕ токен в booking — чтобы booking проверил
    // холд от имени того же самого пользователя своим собственным
    // JwtAuthGuard, а не доверял нашему пересказу user.sub.
    const authorization = req.headers.authorization!;
    const { order, clientSecret } = await this.orders.create(dto, user, authorization);
    return {
      id: order.id,
      eventId: order.eventId,
      seatId: order.seatId,
      amountCents: order.amountCents,
      status: order.status,
      providerIntentId: order.providerIntentId,
      clientSecret,
    };
  }

  @ApiOperation({ summary: 'Заказы события (организатор своего события, админ — любого)' })
  @ApiBearerAuth()
  @ApiResponse({ status: 200, type: [OrderResponseDto] })
  @ApiResponse({ status: 403, description: 'Событие принадлежит другому организатору' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ORGANIZER', 'ADMIN')
  @Get()
  async list(
    @Query('eventId') eventId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrderResponseDto[]> {
    const orders = await this.orders.listByEvent(eventId, user);
    return orders.map((order) => ({
      id: order.id,
      eventId: order.eventId,
      seatId: order.seatId,
      amountCents: order.amountCents,
      status: order.status,
      providerIntentId: order.providerIntentId,
    }));
  }

  @ApiOperation({ summary: 'Вернуть оплаченный заказ (организатор/админ)' })
  @ApiBearerAuth()
  @ApiResponse({ status: 200, type: OrderResponseDto })
  @ApiResponse({ status: 403, description: 'Заказ не в статусе PAID, либо недостаточно прав' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ORGANIZER', 'ADMIN')
  @Patch(':id/refund')
  async refund(@Param('id') id: string): Promise<OrderResponseDto> {
    const order = await this.orders.refund(id);
    return {
      id: order.id,
      eventId: order.eventId,
      seatId: order.seatId,
      amountCents: order.amountCents,
      status: order.status,
      providerIntentId: order.providerIntentId,
    };
  }
}
