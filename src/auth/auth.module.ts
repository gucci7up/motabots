import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { TelegramAuthService } from './telegram-auth.service';

@Module({
  imports: [UsersModule],
  providers: [TelegramAuthService],
  exports: [TelegramAuthService],
})
export class AuthModule {}
