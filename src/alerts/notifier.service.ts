import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { PermissionCode } from '../roles/permissions';
import { TelegramService } from '../telegram/telegram.service';

/**
 * Envío de notificaciones a los usuarios del sistema.
 *
 * Los mensajes se mandan en texto plano, sin MarkdownV2: una alerta se construye con
 * nombres de productos y clientes que pueden contener cualquier carácter, y un escape
 * mal hecho haría fallar el envío justo cuando más importa que llegue.
 */
@Injectable()
export class NotifierService {
  private readonly logger = new Logger(NotifierService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
  ) {}

  /** Envía a todos los usuarios activos que tengan el permiso indicado. */
  async broadcast(message: string, permission: PermissionCode): Promise<number> {
    const users = await this.prisma.user.findMany({
      where: {
        isActive: true,
        role: { permissions: { some: { permission: { code: permission } } } },
      },
      select: { id: true, telegramUserId: true },
    });

    let delivered = 0;

    for (const user of users) {
      const sent = await this.send(user.telegramUserId, message);
      if (sent) {
        delivered++;
      }
    }

    this.logger.log(`Notificación entregada a ${delivered}/${users.length} usuarios`);
    return delivered;
  }

  /**
   * Envía a un usuario concreto. Un fallo no interrumpe el resto del envío: si un usuario
   * bloqueó el bot, los demás deben recibir su alerta igual.
   */
  async send(telegramUserId: bigint, message: string): Promise<boolean> {
    try {
      await this.telegram.sendMessage(telegramUserId, message);
      return true;
    } catch (error) {
      this.logger.warn(
        { err: error, telegramUserId: telegramUserId.toString() },
        'No se pudo entregar la notificación',
      );
      return false;
    }
  }
}
