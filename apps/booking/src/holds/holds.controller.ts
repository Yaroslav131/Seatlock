import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { HeldSeatDto } from './dto/held-seat.dto';
import { HoldResponseDto } from './dto/hold-response.dto';
import { HoldSeatDto } from './dto/hold-seat.dto';
import { HoldsService } from './holds.service';

// booking НЕ проверяет через HTTP, что eventId/seatId реально существуют
// в catalog — такого паттерна (сервис → сервис) в проекте пока нет вообще,
// только gateway → сервис проксирование. В отличие от RequireRole.tsx на
// фронте, где UX-гейт дублирует РЕАЛЬНУЮ серверную проверку (RolesGuard на
// catalog), здесь дублировать нечего: серверной проверки существования
// события/места нет вообще никакой. Осознанный трейд-офф для этой
// итерации — холд на несуществующий eventId просто создаёт "призрачный"
// Redis-ключ, который сам исчезнет по TTL; денег на этом этапе ещё нет,
// цена ошибки низкая. Единственный барьер — фронтенд, который показывает
// карту мест только для событий, уже полученных из catalog со статусом
// PUBLISHED.
@ApiTags('holds')
@Controller('events/:eventId')
export class HoldsController {
  constructor(private readonly holds: HoldsService) {}

  @ApiOperation({ summary: 'Занятые места события — публично, для карты зала' })
  @ApiResponse({ status: 200, type: [HeldSeatDto] })
  @Get('holds')
  async listHeld(@Param('eventId') eventId: string): Promise<HeldSeatDto[]> {
    const seatIds = await this.holds.getHeldSeats(eventId);
    return seatIds.map((seatId) => ({ seatId }));
  }

  @ApiOperation({ summary: 'Мой активный холд на это событие' })
  @ApiBearerAuth()
  @ApiResponse({ status: 200, type: HoldResponseDto })
  @UseGuards(JwtAuthGuard)
  @Get('my-hold')
  getMyHold(
    @Param('eventId') eventId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ seatId: string; expiresAt: string } | null> {
    return this.holds.getMyHold(eventId, user.sub);
  }

  @ApiOperation({
    summary: 'Занять место (переносит предыдущий холд юзера в этом событии, если был)',
  })
  @ApiBearerAuth()
  @ApiResponse({ status: 201, type: HoldResponseDto })
  @ApiResponse({ status: 409, description: 'Место уже занято другим пользователем' })
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  @Post('holds')
  async createHold(
    @Param('eventId') eventId: string,
    @Body() dto: HoldSeatDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<HoldResponseDto> {
    const result = await this.holds.createHold(eventId, dto.seatId, user.sub);
    if (result.type === 'TAKEN') {
      throw new ConflictException('Место уже занято');
    }
    return { seatId: result.seatId, expiresAt: result.expiresAt };
  }

  @ApiOperation({ summary: 'Отпустить свой холд на это событие (no-op, если холда нет)' })
  @ApiBearerAuth()
  @ApiResponse({ status: 204 })
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('holds')
  async releaseHold(
    @Param('eventId') eventId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.holds.releaseHold(eventId, user.sub);
  }
}
