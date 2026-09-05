import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { TokenResponseDto } from './dto/token-response.dto';

const REFRESH_COOKIE_NAME = 'refreshToken';
// Кука едет только на /api/auth/* — остальным маршрутам gateway
// незачем даже видеть, что она существует.
const REFRESH_COOKIE_PATH = '/api/auth';
const REFRESH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

@ApiTags('auth')
@ApiTooManyRequestsResponse({ description: 'Превышен лимит запросов' })
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  // Строже общего лимита: перебор паролей и спам-регистрации — это
  // именно эти два маршрута, а не /refresh или /logout.
  @ApiOperation({ summary: 'Регистрация. Кладёт refresh-токен в httpOnly-cookie.' })
  @ApiResponse({ status: 201, type: TokenResponseDto })
  @ApiResponse({ status: 409, description: 'Email уже занят' })
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenResponseDto> {
    const tokens = await this.auth.register(dto);
    this.setRefreshCookie(res, tokens.refreshToken);
    return { accessToken: tokens.accessToken };
  }

  @ApiOperation({ summary: 'Вход. Кладёт refresh-токен в httpOnly-cookie.' })
  @ApiResponse({ status: 200, type: TokenResponseDto })
  @ApiResponse({ status: 401, description: 'Неверный email или пароль' })
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenResponseDto> {
    const tokens = await this.auth.login(dto);
    this.setRefreshCookie(res, tokens.refreshToken);
    return { accessToken: tokens.accessToken };
  }

  @ApiOperation({
    summary: 'Обменивает refresh-токен из cookie на новую пару. Токен одноразовый (ротация).',
  })
  @ApiCookieAuth()
  @ApiResponse({ status: 200, type: TokenResponseDto })
  @ApiResponse({ status: 401, description: 'Токен отсутствует, истёк или уже был использован' })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenResponseDto> {
    const refreshToken = this.readRefreshCookie(req);
    const tokens = await this.auth.refresh(refreshToken);
    this.setRefreshCookie(res, tokens.refreshToken);
    return { accessToken: tokens.accessToken };
  }

  @ApiOperation({ summary: 'Отзывает текущую сессию и чистит cookie.' })
  @ApiCookieAuth()
  @ApiResponse({ status: 204 })
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
    if (refreshToken) {
      await this.auth.logout(refreshToken);
    }
    res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
  }

  private readRefreshCookie(req: Request): string {
    const token = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
    if (!token) {
      throw new UnauthorizedException('Refresh-токен отсутствует');
    }
    return token;
  }

  private setRefreshCookie(res: Response, token: string): void {
    res.cookie(REFRESH_COOKIE_NAME, token, {
      httpOnly: true,
      // В деве без HTTPS браузер обязан отклонить Secure-куку —
      // поэтому включаем её только в проде.
      secure: this.config.get<string>('NODE_ENV') === 'production',
      sameSite: 'lax',
      path: REFRESH_COOKIE_PATH,
      maxAge: REFRESH_COOKIE_MAX_AGE_MS,
    });
  }
}
