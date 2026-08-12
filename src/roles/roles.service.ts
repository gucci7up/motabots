import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { DomainException } from '../common/exceptions/domain.exception';
import { PermissionCode } from './permissions';

export interface RoleWithPermissions {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: PermissionCode[];
}

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<RoleWithPermissions[]> {
    const roles = await this.prisma.role.findMany({
      include: { permissions: { include: { permission: true } } },
      orderBy: { name: 'asc' },
    });

    return roles.map((role) => ({
      id: role.id,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      permissions: role.permissions.map((rp) => rp.permission.code as PermissionCode),
    }));
  }

  async findByName(name: string): Promise<RoleWithPermissions> {
    const role = await this.prisma.role.findUnique({
      where: { name },
      include: { permissions: { include: { permission: true } } },
    });

    if (!role) {
      throw DomainException.notFound('el rol', name);
    }

    return {
      id: role.id,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      permissions: role.permissions.map((rp) => rp.permission.code as PermissionCode),
    };
  }

  /** Permisos efectivos de un rol, leídos de la base (no del catálogo en código). */
  async getPermissions(roleId: string): Promise<PermissionCode[]> {
    const rows = await this.prisma.rolePermission.findMany({
      where: { roleId },
      include: { permission: true },
    });
    return rows.map((row) => row.permission.code as PermissionCode);
  }
}
