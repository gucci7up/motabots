import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';
import { TelegramUpdateService } from './telegram-update.service';

/**
 * Capa de transporte del bot. Depende de los módulos de dominio, nunca al revés:
 * la lógica de negocio no debe saber que Telegram existe.
 */
@Module({
  imports: [AuthModule, UsersModule],
  controllers: [TelegramController],
  providers: [TelegramService, TelegramUpdateService],
  exports: [TelegramService],
})
export class TelegramModule {}
