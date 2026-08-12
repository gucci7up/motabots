import { Injectable, Logger } from '@nestjs/common';
import { AuditSource, Prisma } from '@prisma/client';
import { PrismaService, PrismaTransaction } from '../database/prisma.service';

/** Acciones auditadas. Cadenas estables: se consultan en reportes de auditoría. */
export const AuditAction = {
  LOGIN: 'login',
  LOGIN_DENIED: 'login.denied',
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  USER_DEACTIVATED: 'user.deactivated',
  SALE_CREATED: 'sale.created',
  SALE_CANCELLED: 'sale.cancelled',
  PAYMENT_CREATED: 'payment.created',
  CREDIT_CREATED: 'credit.created',
  CREDIT_COLLECTED: 'credit.collected',
  INVENTORY_ADJUSTED: 'inventory.adjusted',
  PRODUCT_CREATED: 'product.created',
  PRODUCT_UPDATED: 'product.updated',
  EXPENSE_CREATED: 'expense.created',
  CASH_OPENED: 'cash.opened',
  CASH_CLOSED: 'cash.closed',
  INVOICE_CANCELLED: 'invoice.cancelled',
  SETTINGS_UPDATED: 'settings.updated',
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditEntry {
  userId?: string | null;
  action: AuditActionValue;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  source?: AuditSource;
}

/**
 * Registro append-only de operaciones. No existe método de borrado ni de actualización:
 * un histórico que se puede editar no sirve como auditoría.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Registra dentro de la transacción recibida. Es la forma correcta cuando la operación
   * auditada es transaccional: si la venta hace rollback, su auditoría también.
   */
  async recordIn(tx: PrismaTransaction, entry: AuditEntry): Promise<void> {
    await tx.auditLog.create({ data: this.toData(entry) });
  }

  /**
   * Registra fuera de transacción. Nunca propaga errores: que falle la auditoría de un login
   * no debe impedir el login, pero sí queda en el log de la aplicación.
   */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({ data: this.toData(entry) });
    } catch (error) {
      this.logger.error(
        { err: error, action: entry.action, entity: entry.entity },
        'No se pudo registrar el audit log',
      );
    }
  }

  private toData(entry: AuditEntry): Prisma.AuditLogUncheckedCreateInput {
    return {
      userId: entry.userId ?? null,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      before: this.toJson(entry.before),
      after: this.toJson(entry.after),
      metadata: this.toJson(entry.metadata),
      ipAddress: entry.ipAddress ?? null,
      source: entry.source ?? AuditSource.TELEGRAM,
    };
  }

  /**
   * Prisma.Decimal y BigInt no son JSON válido; se convierten a string para conservar
   * el valor exacto en el histórico.
   */
  private toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
    if (value === undefined || value === null) {
      return Prisma.JsonNull;
    }
    return JSON.parse(
      JSON.stringify(value, (_key, item: unknown) => {
        if (typeof item === 'bigint') {
          return item.toString();
        }
        if (Prisma.Decimal.isDecimal(item)) {
          return item.toString();
        }
        return item;
      }),
    ) as Prisma.InputJsonValue;
  }
}
