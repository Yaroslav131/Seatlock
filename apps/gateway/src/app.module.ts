import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { InfraModule } from './infra/infra.module';

@Module({
  imports: [
    // .env лежит в корне монорепозитория и общий для всех сервисов.
    // Локальный apps/gateway/.env, если появится, перекроет корневой.
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    InfraModule,
    HealthModule,
    AuthModule,
  ],
})
export class AppModule {}
