import { Module } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { MeController } from './me.controller';

@Module({
  controllers: [MeController],
  providers: [JwtAuthGuard],
  exports: [JwtAuthGuard],
})
export class AuthModule {}
