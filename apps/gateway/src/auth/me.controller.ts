import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser } from './jwt-auth.guard';
import { CurrentUser } from './current-user.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';

@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
@UseGuards(JwtAuthGuard)
export class MeController {
  @ApiOperation({ summary: 'Данные из access-токена. Проверяет подпись сам, без похода в auth.' })
  @ApiResponse({ status: 200, description: 'Payload токена: sub, email, role, iat, exp' })
  @ApiResponse({ status: 401, description: 'Токен отсутствует или недействителен' })
  @Get()
  me(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }
}
