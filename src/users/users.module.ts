import { Module } from '@nestjs/common';
import { RolesModule } from '../roles/roles.module';
import { UsersService } from './users.service';

/**
 * Sin controlador REST todavía: exponer administración de usuarios por HTTP antes de tener
 * autenticación del dashboard sería un endpoint abierto para crear administradores.
 * La gestión se hace desde Telegram, donde la identidad sí está verificada.
 */
@Module({
  imports: [RolesModule],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
