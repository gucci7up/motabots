import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditAction, AuditService } from '../audit/audit.service';
import { DomainErrorCode, DomainException } from '../common/exceptions/domain.exception';
import { PaginatedResult, paginate } from '../common/dto/pagination.dto';
import { PrismaService } from '../database/prisma.service';
import { PermissionCode } from '../roles/permissions';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

/** Usuario resuelto con sus permisos efectivos, tal como lo usan guards y handlers. */
export interface AuthenticatedUser {
  id: string;
  telegramUserId: bigint;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  roleId: string;
  roleName: string;
  isActive: boolean;
  permissions: PermissionCode[];
}

const USER_WITH_ROLE = {
  role: { include: { permissions: { include: { permission: true } } } },
} satisfies Prisma.UserInclude;

type UserWithRole = Prisma.UserGetPayload<{ include: typeof USER_WITH_ROLE }>;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Resuelve la identidad de Telegram. Devuelve null si el usuario no existe o está inactivo:
   * ambos casos se tratan igual hacia afuera para no revelar quién está registrado.
   */
  async findByTelegramId(telegramUserId: bigint): Promise<AuthenticatedUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { telegramUserId },
      include: USER_WITH_ROLE,
    });

    if (!user || !user.isActive) {
      return null;
    }

    return this.toAuthenticatedUser(user);
  }

  async findById(id: string): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUnique({ where: { id }, include: USER_WITH_ROLE });
    if (!user) {
      throw DomainException.notFound('el usuario', id);
    }
    return this.toAuthenticatedUser(user);
  }

  async findAll(page: number, pageSize: number): Promise<PaginatedResult<AuthenticatedUser>> {
    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        include: USER_WITH_ROLE,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.user.count(),
    ]);

    return paginate(
      users.map((user) => this.toAuthenticatedUser(user)),
      total,
      page,
      pageSize,
    );
  }

  async create(dto: CreateUserDto, actorId: string | null): Promise<AuthenticatedUser> {
    const telegramUserId = this.parseTelegramId(dto.telegramUserId);

    const existing = await this.prisma.user.findUnique({ where: { telegramUserId } });
    if (existing) {
      throw new DomainException(
        DomainErrorCode.CONFLICT,
        'Ya existe un usuario con ese ID de Telegram.',
        { telegramUserId: telegramUserId.toString() },
      );
    }

    const role = await this.prisma.role.findUnique({ where: { name: dto.roleName } });
    if (!role) {
      throw DomainException.notFound('el rol', dto.roleName);
    }

    const user = await this.prisma.user.create({
      data: {
        telegramUserId,
        username: dto.username ?? null,
        firstName: dto.firstName ?? null,
        lastName: dto.lastName ?? null,
        roleId: role.id,
      },
      include: USER_WITH_ROLE,
    });

    await this.audit.record({
      userId: actorId,
      action: AuditAction.USER_CREATED,
      entity: 'User',
      entityId: user.id,
      after: { telegramUserId: telegramUserId.toString(), role: role.name },
    });

    return this.toAuthenticatedUser(user);
  }

  async update(id: string, dto: UpdateUserDto, actorId: string | null): Promise<AuthenticatedUser> {
    const before = await this.prisma.user.findUnique({ where: { id }, include: USER_WITH_ROLE });
    if (!before) {
      throw DomainException.notFound('el usuario', id);
    }

    let roleId = before.roleId;
    if (dto.roleName) {
      const role = await this.prisma.role.findUnique({ where: { name: dto.roleName } });
      if (!role) {
        throw DomainException.notFound('el rol', dto.roleName);
      }
      roleId = role.id;
    }

    // Sin un ADMIN activo el sistema queda inaccesible para siempre: se bloquea antes de guardar.
    const losesAdmin =
      before.role.name === 'ADMIN' &&
      ((dto.roleName !== undefined && dto.roleName !== 'ADMIN') || dto.isActive === false);
    if (losesAdmin) {
      await this.assertNotLastAdmin(before.id);
    }

    const user = await this.prisma.user.update({
      where: { id },
      data: {
        roleId,
        username: dto.username ?? before.username,
        firstName: dto.firstName ?? before.firstName,
        lastName: dto.lastName ?? before.lastName,
        isActive: dto.isActive ?? before.isActive,
      },
      include: USER_WITH_ROLE,
    });

    await this.audit.record({
      userId: actorId,
      action: dto.isActive === false ? AuditAction.USER_DEACTIVATED : AuditAction.USER_UPDATED,
      entity: 'User',
      entityId: user.id,
      before: { role: before.role.name, isActive: before.isActive },
      after: { role: user.role.name, isActive: user.isActive },
    });

    return this.toAuthenticatedUser(user);
  }

  /**
   * Sincroniza nombre y username desde Telegram cuando cambian. Los usuarios creados desde
   * TELEGRAM_ADMIN_IDS nacen sin nombre; sin esto el bot los saludaría por su ID para siempre.
   * Devuelve el usuario actualizado, o el mismo si no había nada que cambiar.
   */
  async syncTelegramProfile(
    user: AuthenticatedUser,
    profile: { username?: string; firstName?: string; lastName?: string },
  ): Promise<AuthenticatedUser> {
    const username = profile.username ?? null;
    const firstName = profile.firstName ?? null;
    const lastName = profile.lastName ?? null;

    const unchanged =
      user.username === username && user.firstName === firstName && user.lastName === lastName;

    if (unchanged) {
      return user;
    }

    try {
      const updated = await this.prisma.user.update({
        where: { id: user.id },
        data: { username, firstName, lastName },
        include: USER_WITH_ROLE,
      });
      return this.toAuthenticatedUser(updated);
    } catch (error) {
      // Un fallo aquí no debe impedir usar el bot: el perfil es cosmético.
      this.logger.warn({ err: error, userId: user.id }, 'No se pudo sincronizar el perfil');
      return user;
    }
  }

  /** Marca el último acceso. No debe hacer fallar la operación que lo dispara. */
  async markLogin(userId: string): Promise<void> {
    try {
      await this.prisma.user.update({
        where: { id: userId },
        data: { lastLoginAt: new Date() },
      });
    } catch (error) {
      this.logger.warn({ err: error, userId }, 'No se pudo actualizar lastLoginAt');
    }
  }

  /**
   * Arranque en frío: crea como ADMIN los IDs de TELEGRAM_ADMIN_IDS que aún no existan.
   * Sin esto no habría forma de entrar la primera vez.
   */
  async ensureAdmins(telegramIds: readonly bigint[]): Promise<number> {
    if (telegramIds.length === 0) {
      return 0;
    }

    const adminRole = await this.prisma.role.findUnique({ where: { name: 'ADMIN' } });
    if (!adminRole) {
      this.logger.error('No existe el rol ADMIN: ejecuta el seed antes de arrancar');
      return 0;
    }

    let created = 0;
    for (const telegramUserId of telegramIds) {
      const existing = await this.prisma.user.findUnique({ where: { telegramUserId } });
      if (existing) {
        continue;
      }
      await this.prisma.user.create({
        data: { telegramUserId, roleId: adminRole.id, isActive: true },
      });
      created++;
      this.logger.log(`Administrador creado desde TELEGRAM_ADMIN_IDS: ${telegramUserId}`);
    }

    return created;
  }

  private async assertNotLastAdmin(excludingUserId: string): Promise<void> {
    const remaining = await this.prisma.user.count({
      where: { isActive: true, role: { name: 'ADMIN' }, id: { not: excludingUserId } },
    });

    if (remaining === 0) {
      throw new DomainException(
        DomainErrorCode.CONFLICT,
        'No puedes quitar el último administrador activo: nadie podría administrar el sistema.',
      );
    }
  }

  private parseTelegramId(value: string): bigint {
    if (!/^\d+$/.test(value.trim())) {
      throw new DomainException(
        DomainErrorCode.VALIDATION_FAILED,
        'El ID de Telegram debe ser un número.',
        { telegramUserId: value },
      );
    }
    return BigInt(value.trim());
  }

  private toAuthenticatedUser(user: UserWithRole): AuthenticatedUser {
    return {
      id: user.id,
      telegramUserId: user.telegramUserId,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      roleId: user.roleId,
      roleName: user.role.name,
      isActive: user.isActive,
      permissions: user.role.permissions.map((rp) => rp.permission.code as PermissionCode),
    };
  }
}
