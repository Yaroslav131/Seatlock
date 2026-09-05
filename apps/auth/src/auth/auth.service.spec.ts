import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role } from '../generated/prisma';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';

const SECRETS: Record<string, string> = {
  JWT_ACCESS_SECRET: 'test-access-secret',
  JWT_REFRESH_SECRET: 'test-refresh-secret',
};

// Не поднимаем реальный ConfigModule — AuthService трогает только
// getOrThrow, этого мока достаточно и не тянет за собой DI-контейнер.
const config = {
  getOrThrow: jest.fn((key: string) => SECRETS[key]),
} as unknown as ConfigService;

function createPrismaMock() {
  return {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    refreshToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  };
}

type PrismaMock = ReturnType<typeof createPrismaMock>;

async function hashForTest(password: string): Promise<string> {
  const { hash } = await import('@node-rs/argon2');
  return hash(password);
}

describe('AuthService', () => {
  let prisma: PrismaMock;
  let service: AuthService;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new AuthService(prisma as unknown as PrismaService, config);
  });

  describe('register', () => {
    it('отклоняет повторную регистрацию по тому же email', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com' });

      await expect(
        service.register({ email: 'a@b.com', password: 'supersecret123' }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('хэширует пароль перед сохранением — не хранит его как есть', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({
        id: 'u1',
        email: 'a@b.com',
        role: Role.USER,
      });
      prisma.refreshToken.create.mockResolvedValue({ id: 'rt1' });

      await service.register({ email: 'a@b.com', password: 'supersecret123' });

      const savedHash = prisma.user.create.mock.calls[0][0].data.passwordHash;
      expect(savedHash).not.toBe('supersecret123');
      expect(savedHash.length).toBeGreaterThan(20);
    });

    it('возвращает access- и refresh-токен новому пользователю', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ id: 'u1', email: 'a@b.com', role: Role.USER });
      prisma.refreshToken.create.mockResolvedValue({ id: 'rt1' });

      const tokens = await service.register({ email: 'a@b.com', password: 'supersecret123' });

      expect(jwt.verify(tokens.accessToken, SECRETS.JWT_ACCESS_SECRET)).toMatchObject({
        sub: 'u1',
        email: 'a@b.com',
        role: 'USER',
      });
      expect(jwt.verify(tokens.refreshToken, SECRETS.JWT_REFRESH_SECRET)).toMatchObject({
        sub: 'u1',
        jti: 'rt1',
      });
    });
  });

  describe('login', () => {
    it('отклоняет несуществующий email тем же сообщением, что и неверный пароль', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.login({ email: 'ghost@b.com', password: 'whatever1' })).rejects.toThrow(
        'Неверный email или пароль',
      );
    });

    it('отклоняет неверный пароль тем же сообщением, что и несуществующий email', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'a@b.com',
        // Реальный argon2-хэш от совсем другого пароля.
        passwordHash: await hashForTest('correct-password'),
        role: Role.USER,
      });

      await expect(service.login({ email: 'a@b.com', password: 'wrong-password' })).rejects.toThrow(
        'Неверный email или пароль',
      );
    });

    it('пускает с верным паролем', async () => {
      const passwordHash = await hashForTest('supersecret123');
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'a@b.com',
        passwordHash,
        role: Role.USER,
      });
      prisma.refreshToken.create.mockResolvedValue({ id: 'rt1' });

      const tokens = await service.login({ email: 'a@b.com', password: 'supersecret123' });

      expect(jwt.verify(tokens.accessToken, SECRETS.JWT_ACCESS_SECRET)).toMatchObject({
        sub: 'u1',
      });
    });
  });

  describe('refresh', () => {
    function issueRefreshToken(jti: string): string {
      return jwt.sign({ sub: 'u1', jti }, SECRETS.JWT_REFRESH_SECRET, { expiresIn: '30d' });
    }

    it('ротирует: старая запись гасится, выдаётся новая пара', async () => {
      const oldToken = issueRefreshToken('rt-old');
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-old',
        userId: 'u1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 1000 * 60),
        user: { id: 'u1', email: 'a@b.com', role: Role.USER },
      });
      prisma.refreshToken.create.mockResolvedValue({ id: 'rt-new' });

      const tokens = await service.refresh(oldToken);

      expect(prisma.refreshToken.update).toHaveBeenCalledWith({
        where: { id: 'rt-old' },
        data: { revokedAt: expect.any(Date), replacedById: 'rt-new' },
      });
      expect(jwt.verify(tokens.refreshToken, SECRETS.JWT_REFRESH_SECRET)).toMatchObject({
        jti: 'rt-new',
      });
    });

    it('повторное использование уже заменённого токена гасит ВСЕ сессии пользователя', async () => {
      const stolenToken = issueRefreshToken('rt-already-used');
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-already-used',
        userId: 'u1',
        revokedAt: new Date(), // уже был использован раньше
        expiresAt: new Date(Date.now() + 1000 * 60),
        user: { id: 'u1', email: 'a@b.com', role: Role.USER },
      });

      await expect(service.refresh(stolenToken)).rejects.toThrow('Сессия отозвана, войдите заново');

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      // Ключевая проверка: это не точечный отзыв одного токена,
      // а массовый — по всем живым сессиям пользователя разом.
      expect(prisma.refreshToken.update).not.toHaveBeenCalled();
    });

    it('отклоняет истёкший токен без массового отзыва — это не кража, а естественный конец жизни', async () => {
      const expiredToken = issueRefreshToken('rt-expired');
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-expired',
        userId: 'u1',
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1000),
        user: { id: 'u1', email: 'a@b.com', role: Role.USER },
      });

      await expect(service.refresh(expiredToken)).rejects.toThrow('Сессия истекла');
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it('отклоняет токен с неверной подписью, даже не заглядывая в базу', async () => {
      const forged = jwt.sign({ sub: 'u1', jti: 'rt-x' }, 'not-the-real-secret');

      await expect(service.refresh(forged)).rejects.toThrow('Недействительный refresh-токен');
      expect(prisma.refreshToken.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('гасит ровно одну сессию по jti из токена', async () => {
      const token = jwt.sign({ sub: 'u1', jti: 'rt-1' }, SECRETS.JWT_REFRESH_SECRET);

      await service.logout(token);

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { id: 'rt-1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });
  });
});
