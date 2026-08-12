import { Injectable, Logger } from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AuthenticatedUser, UsersService } from '../users/users.service';

export interface TelegramIdentity {
  telegramUserId: bigint;
  username?: string;
  firstName?: string;
  lastName?: string;
}

/**
 * Autenticación del bot: la identidad es la posesión de la cuenta de Telegram.
 * No hay contraseñas; el control de acceso es la tabla `users` más el flag `isActive`.
 */
@Injectable()
export class TelegramAuthService {
  private readonly logger = new Logger(TelegramAuthService.name);

  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  /** Devuelve el usuario autorizado, o null si no tiene acceso. */
  async authenticate(identity: TelegramIdentity): Promise<AuthenticatedUser | null> {
    const user = await this.users.findByTelegramId(identity.telegramUserId);

    if (!user) {
      // Se registra el intento: saber quién trató de entrar es parte de la auditoría.
      await this.audit.record({
        action: AuditAction.LOGIN_DENIED,
        entity: 'User',
        metadata: {
          telegramUserId: identity.telegramUserId.toString(),
          username: identity.username ?? null,
        },
      });
      this.logger.warn(
        { telegramUserId: identity.telegramUserId.toString() },
        'Acceso denegado: usuario no registrado o inactivo',
      );
      return null;
    }

    // El perfil de Telegram cambia con el tiempo (nombre, username): se mantiene al día.
    return this.users.syncTelegramProfile(user, {
      username: identity.username,
      firstName: identity.firstName,
      lastName: identity.lastName,
    });
  }

  /**
   * Registra el inicio de sesión. Se llama en /start, no en cada mensaje: un audit log por
   * pulsación de botón sería ruido que oculta los eventos que importan.
   */
  async registerLogin(user: AuthenticatedUser, identity: TelegramIdentity): Promise<void> {
    await this.users.markLogin(user.id);
    await this.audit.record({
      userId: user.id,
      action: AuditAction.LOGIN,
      entity: 'User',
      entityId: user.id,
      metadata: {
        telegramUserId: identity.telegramUserId.toString(),
        username: identity.username ?? null,
        role: user.roleName,
      },
    });
  }
}
