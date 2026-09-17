import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { InternalController } from './internal.controller';

@Module({
  controllers: [AuthController, InternalController],
  providers: [AuthService],
})
export class AuthModule {}
