import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthenticatedUser } from './jwt-auth.guard';
import { CurrentUser } from './current-user.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';

@Controller('me')
@UseGuards(JwtAuthGuard)
export class MeController {
  @Get()
  me(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }
}
