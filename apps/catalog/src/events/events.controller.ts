import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CreateEventDto } from './dto/create-event.dto';
import { EventResponseDto } from './dto/event-response.dto';
import { EventsService } from './events.service';

@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @ApiOperation({ summary: 'Создать событие-черновик (организатор/админ)' })
  @ApiBearerAuth()
  @ApiResponse({ status: 201, type: EventResponseDto })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ORGANIZER', 'ADMIN')
  @Post()
  create(
    @Body() dto: CreateEventDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<EventResponseDto> {
    return this.events.create(dto, user.sub);
  }

  @ApiOperation({ summary: 'Опубликовать своё событие (организатор) или любое (админ)' })
  @ApiBearerAuth()
  @ApiResponse({ status: 200, type: EventResponseDto })
  @ApiResponse({ status: 403, description: 'Не своё событие или уже не черновик' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ORGANIZER', 'ADMIN')
  @Patch(':id/publish')
  publish(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<EventResponseDto> {
    return this.events.publish(id, user.sub, user.role);
  }

  @ApiOperation({ summary: 'Список опубликованных событий — публично, с кэшем' })
  @ApiResponse({ status: 200, type: [EventResponseDto] })
  @Get()
  findPublished(): Promise<EventResponseDto[]> {
    return this.events.findPublished();
  }

  @ApiOperation({ summary: 'Событие по id — публично, с кэшем' })
  @ApiResponse({ status: 200, type: EventResponseDto })
  @ApiResponse({ status: 404, description: 'Событие не найдено' })
  @Get(':id')
  findOne(@Param('id') id: string): Promise<EventResponseDto> {
    return this.events.findOne(id);
  }
}
