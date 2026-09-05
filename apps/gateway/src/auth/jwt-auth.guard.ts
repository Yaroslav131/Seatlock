import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import * as jwt from 'jsonwebtoken';

export interface AuthenticatedUser {
  sub: string;
  email: string;
  role: 'USER' | 'ORGANIZER' | 'ADMIN';
}

export interface RequestWithUser extends Request {
  user: AuthenticatedUser;
}

/**
 * Проверяет access-токен по той же подписи, которой его выдал auth.
 * Никакого похода в базу или в сам auth-сервис — в этом весь смысл
 * JWT: подпись проверяется локально и мгновенно.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Отсутствует access-токен');
    }

    const token = header.slice('Bearer '.length);

    try {
      const payload = jwt.verify(
        token,
        this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      ) as AuthenticatedUser;
      (req as RequestWithUser).user = payload;
      return true;
    } catch {
      throw new UnauthorizedException('Недействительный access-токен');
    }
  }
}
