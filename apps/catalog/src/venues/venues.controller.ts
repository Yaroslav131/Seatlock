import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CreateVenueDto } from './dto/create-venue.dto';
import { GenerateSeatsDto } from './dto/generate-seats.dto';
import { VenueResponseDto } from './dto/venue-response.dto';
import { VenuesService } from './venues.service';

@ApiTags('venues')
@Controller('venues')
export class VenuesController {
  constructor(private readonly venues: VenuesService) {}

  @ApiOperation({ summary: 'Создать зал (организатор/админ)' })
  @ApiBearerAuth()
  @ApiResponse({ status: 201, type: VenueResponseDto })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ORGANIZER', 'ADMIN')
  @Post()
  create(@Body() dto: CreateVenueDto): Promise<VenueResponseDto> {
    return this.venues.create(dto);
  }

  @ApiOperation({ summary: 'Зал по id — публично' })
  @ApiResponse({ status: 200, type: VenueResponseDto })
  @ApiResponse({ status: 404, description: 'Зал не найден' })
  @Get(':id')
  findOne(@Param('id') id: string): Promise<VenueResponseDto> {
    return this.venues.findOne(id);
  }

  @ApiOperation({ summary: 'Сгенерировать сетку мест ряды × места (организатор/админ)' })
  @ApiBearerAuth()
  @ApiResponse({ status: 201, description: 'Сколько мест реально создано' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ORGANIZER', 'ADMIN')
  @HttpCode(HttpStatus.CREATED)
  @Post(':id/seats/generate')
  generateSeats(
    @Param('id') id: string,
    @Body() dto: GenerateSeatsDto,
  ): Promise<{ created: number }> {
    return this.venues.generateSeats(id, dto);
  }
}
