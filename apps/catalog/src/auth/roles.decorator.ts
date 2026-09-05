import { SetMetadata } from '@nestjs/common';
import { Role } from './jwt-auth.guard';

export const ROLES_KEY = 'roles';

/** Вешается вместе с JwtAuthGuard — сам по себе роль не проверяет. */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
