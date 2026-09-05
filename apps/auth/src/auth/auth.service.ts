import { hash, verify } from '@node-rs/argon2';
import { ConflictException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

interface AccessTokenPayload {
  sub: string;
  email: string;
  role: Role;
}

interface RefreshTokenPayload {
  sub: string;
  jti: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL = '30d';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async register(dto: RegisterDto): Promise<TokenPair> {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      // Не уточняем, что именно не так — иначе email становится
      // способом узнать, зарегистрирован ли человек в системе.
      throw new ConflictException('Пользователь с таким email уже существует');
    }

    const passwordHash = await hash(dto.password);
    const user = await this.prisma.user.create({
      data: { email: dto.email, passwordHash, role: Role.USER },
    });

    return this.issueTokenPair(user.id, user.email, user.role);
  }

  async login(dto: LoginDto): Promise<TokenPair> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    // Один и тот же ответ для «нет такого email» и «неверный пароль» —
    // иначе можно было бы перебором узнавать существующие адреса.
    if (!user || !(await verify(user.passwordHash, dto.password))) {
      throw new UnauthorizedException('Неверный email или пароль');
    }

    return this.issueTokenPair(user.id, user.email, user.role);
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const payload = this.verifyRefreshToken(refreshToken);

    const stored = await this.prisma.refreshToken.findUnique({
      where: { id: payload.jti },
      include: { user: true },
    });

    if (!stored) {
      throw new UnauthorizedException('Сессия не найдена');
    }

    if (stored.revokedAt) {
      // Токен уже был использован для ротации или разлогинен раньше,
      // а его всё равно пытаются предъявить снова — это признак того,
      // что он утёк. Реагируем гашением всех сессий пользователя,
      // а не только этой ветки.
      this.logger.warn(
        `повторное использование отозванного refresh-токена, userId=${stored.userId}`,
      );
      await this.prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Сессия отозвана, войдите заново');
    }

    if (stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Сессия истекла');
    }

    const tokens = await this.issueTokenPair(stored.user.id, stored.user.email, stored.user.role);

    const newJti = this.decodeRefreshJti(tokens.refreshToken);
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date(), replacedById: newJti },
    });

    return tokens;
  }

  async logout(refreshToken: string): Promise<void> {
    const payload = this.verifyRefreshToken(refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { id: payload.jti, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async issueTokenPair(userId: string, email: string, role: Role): Promise<TokenPair> {
    const refreshRow = await this.prisma.refreshToken.create({
      data: {
        userId,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
    });

    const accessPayload: AccessTokenPayload = { sub: userId, email, role };
    const refreshPayload: RefreshTokenPayload = { sub: userId, jti: refreshRow.id };

    return {
      accessToken: jwt.sign(accessPayload, this.config.getOrThrow<string>('JWT_ACCESS_SECRET'), {
        expiresIn: ACCESS_TOKEN_TTL,
      }),
      refreshToken: jwt.sign(refreshPayload, this.config.getOrThrow<string>('JWT_REFRESH_SECRET'), {
        expiresIn: REFRESH_TOKEN_TTL,
      }),
    };
  }

  private verifyRefreshToken(token: string): RefreshTokenPayload {
    try {
      return jwt.verify(
        token,
        this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      ) as RefreshTokenPayload;
    } catch {
      throw new UnauthorizedException('Недействительный refresh-токен');
    }
  }

  private decodeRefreshJti(token: string): string {
    const decoded = jwt.decode(token) as RefreshTokenPayload;
    return decoded.jti;
  }
}
