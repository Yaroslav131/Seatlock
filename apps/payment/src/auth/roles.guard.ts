import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestWithUser, Role } from './jwt-auth.guard';
import { ROLES_KEY } from './roles.decorator';

/**
 * Работает только вместе с JwtAuthGuard (тот кладёт req.user) и должен
 * стоять ПОСЛЕ него в списке @UseGuards — иначе req.user ещё не будет
 * заполнен на момент проверки.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest<RequestWithUser>();
    if (!required.includes(user.role)) {
      throw new ForbiddenException(`Требуется одна из ролей: ${required.join(', ')}`);
    }

    return true;
  }
}
