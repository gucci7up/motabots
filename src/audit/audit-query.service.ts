import { Injectable } from '@nestjs/common';
import { AuditLog, Prisma } from '@prisma/client';
import { PaginatedResult, paginate } from '../common/dto/pagination.dto';
import { PrismaService } from '../database/prisma.service';

export type AuditLogWithUser = Prisma.AuditLogGetPayload<{ include: { user: true } }>;

export interface AuditFilter {
  entity?: string;
  entityId?: string;
  userId?: string;
  action?: string;
  from?: Date;
  to?: Date;
}

/**
 * Consulta del registro de auditoría. Sólo lectura, a propósito: no existe ningún método
 * para borrar ni modificar un audit log, ni aquí ni en ninguna otra parte del sistema.
 */
@Injectable()
export class AuditQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async find(
    filter: AuditFilter,
    page: number,
    pageSize: number,
  ): Promise<PaginatedResult<AuditLogWithUser>> {
    const where: Prisma.AuditLogWhereInput = {
      ...(filter.entity ? { entity: filter.entity } : {}),
      ...(filter.entityId ? { entityId: filter.entityId } : {}),
      ...(filter.userId ? { userId: filter.userId } : {}),
      ...(filter.action ? { action: filter.action } : {}),
      ...(filter.from || filter.to
        ? { createdAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
        : {}),
    };

    const [logs, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        include: { user: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return paginate(logs, total, page, pageSize);
  }

  /** Historial completo de una entidad concreta: útil para auditar una venta puntual. */
  async findForEntity(entity: string, entityId: string): Promise<AuditLogWithUser[]> {
    return this.prisma.auditLog.findMany({
      where: { entity, entityId },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Recuento por acción en un período: da una vista rápida de la actividad. */
  async summarize(from: Date, to: Date): Promise<{ action: string; count: number }[]> {
    const grouped = await this.prisma.auditLog.groupBy({
      by: ['action'],
      where: { createdAt: { gte: from, lte: to } },
      _count: { _all: true },
    });

    return grouped
      .map((row) => ({ action: row.action, count: row._count._all }))
      .sort((a, b) => b.count - a.count);
  }
}

export type { AuditLog };
