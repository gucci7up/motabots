import { Injectable, Logger } from '@nestjs/common';
import {
  InventoryMovement,
  InventoryMovementType,
  MovementDirection,
  Prisma,
} from '@prisma/client';
import { AuditAction, AuditService } from '../audit/audit.service';
import { DomainErrorCode, DomainException } from '../common/exceptions/domain.exception';
import { cost, formatQuantity, money, multiply, quantity } from '../common/money';
import { PrismaService, PrismaTransaction } from '../database/prisma.service';
import { SettingKey, SettingsService } from '../settings/settings.service';

/** Tipos de movimiento que suman stock. El resto lo resta. */
const INBOUND_TYPES = new Set<InventoryMovementType>([
  InventoryMovementType.PURCHASE,
  InventoryMovementType.RETURN,
  InventoryMovementType.ADJUSTMENT_IN,
  InventoryMovementType.INITIAL_STOCK,
  InventoryMovementType.SALE_CANCELLATION,
]);

export function directionOf(type: InventoryMovementType): MovementDirection {
  return INBOUND_TYPES.has(type) ? MovementDirection.IN : MovementDirection.OUT;
}

export interface MovementInput {
  productVariantId: string;
  type: InventoryMovementType;
  /** Siempre positiva: el sentido lo determina el tipo. */
  quantity: Prisma.Decimal | string | number;
  /** Costo unitario. Si se omite, se usa el costo vigente de la variante. */
  unitCost?: Prisma.Decimal | string | number;
  referenceType?: string;
  referenceId?: string;
  userId?: string | null;
  notes?: string;
}

interface LockedVariant {
  id: string;
  name: string;
  currentStock: Prisma.Decimal;
  costPrice: Prisma.Decimal;
}

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Aplica movimientos DENTRO de una transacción existente. Es el punto de entrada que usa
   * la venta: inventario y venta tienen que confirmarse o deshacerse juntos.
   *
   * Bloquea las filas de las variantes con FOR UPDATE ordenadas por id. El orden importa:
   * dos transacciones que tocan las mismas variantes en orden distinto se bloquean mutuamente.
   */
  async applyMovements(
    tx: PrismaTransaction,
    inputs: readonly MovementInput[],
    options: { allowNegativeStock?: boolean } = {},
  ): Promise<InventoryMovement[]> {
    if (inputs.length === 0) {
      return [];
    }

    const allowNegative =
      options.allowNegativeStock ??
      (await this.settings.getBoolean(SettingKey.ALLOW_NEGATIVE_STOCK, false));

    const variantIds = [...new Set(inputs.map((input) => input.productVariantId))].sort();
    const locked = await this.lockVariants(tx, variantIds);

    const movements: InventoryMovement[] = [];

    for (const input of inputs) {
      const variant = locked.get(input.productVariantId);
      if (!variant) {
        throw DomainException.notFound('la variante', input.productVariantId);
      }

      const qty = quantity(input.quantity);
      if (!qty.greaterThan(0)) {
        throw new DomainException(
          DomainErrorCode.VALIDATION_FAILED,
          'La cantidad del movimiento debe ser mayor que cero.',
          { productVariantId: input.productVariantId },
        );
      }

      const direction = directionOf(input.type);
      const stockBefore = variant.currentStock;
      const stockAfter =
        direction === MovementDirection.IN ? stockBefore.plus(qty) : stockBefore.minus(qty);

      if (stockAfter.lessThan(0) && !allowNegative) {
        throw new DomainException(
          DomainErrorCode.INSUFFICIENT_STOCK,
          `Stock insuficiente de ${variant.name}: disponible ${formatQuantity(stockBefore)}, ` +
            `solicitado ${formatQuantity(qty)}.`,
          {
            productVariantId: variant.id,
            available: stockBefore.toString(),
            requested: qty.toString(),
          },
        );
      }

      const unitCost = input.unitCost !== undefined ? cost(input.unitCost) : cost(variant.costPrice);

      const movement = await tx.inventoryMovement.create({
        data: {
          productVariantId: variant.id,
          type: input.type,
          direction,
          quantity: qty,
          stockBefore,
          stockAfter,
          unitCost,
          totalCost: multiply(qty, unitCost),
          referenceType: input.referenceType ?? null,
          referenceId: input.referenceId ?? null,
          userId: input.userId ?? null,
          notes: input.notes ?? null,
        },
      });

      await tx.productVariant.update({
        where: { id: variant.id },
        data: { currentStock: stockAfter },
      });

      // La caché local refleja el nuevo stock: dos líneas de la misma variante en una
      // venta deben descontar acumulativamente, no partir ambas del stock inicial.
      variant.currentStock = stockAfter;

      movements.push(movement);
    }

    return movements;
  }

  /** Movimiento suelto (entrada de mercancía, ajuste, merma) con su propia transacción. */
  async registerMovement(input: MovementInput): Promise<InventoryMovement> {
    const [movement] = await this.prisma.transaction(async (tx) =>
      this.applyMovements(tx, [input]),
    );

    await this.audit.record({
      userId: input.userId ?? null,
      action: AuditAction.INVENTORY_ADJUSTED,
      entity: 'ProductVariant',
      entityId: input.productVariantId,
      after: {
        type: input.type,
        quantity: movement.quantity,
        stockBefore: movement.stockBefore,
        stockAfter: movement.stockAfter,
      },
      metadata: { notes: input.notes ?? null },
    });

    return movement;
  }

  /**
   * Bloqueo pesimista de las variantes. Sin esto, dos ventas simultáneas del último producto
   * leerían el mismo stock disponible y ambas se completarían.
   */
  private async lockVariants(
    tx: PrismaTransaction,
    variantIds: readonly string[],
  ): Promise<Map<string, LockedVariant>> {
    const rows = await tx.$queryRaw<LockedVariant[]>`
      SELECT id, name, "currentStock", "costPrice"
      FROM product_variants
      WHERE id IN (${Prisma.join(variantIds)})
      ORDER BY id
      FOR UPDATE
    `;

    if (rows.length !== variantIds.length) {
      const found = new Set(rows.map((row) => row.id));
      const missing = variantIds.filter((id) => !found.has(id));
      throw DomainException.notFound('la variante', missing.join(', '));
    }

    return new Map(rows.map((row) => [row.id, row]));
  }

  /** Variantes en o por debajo del stock mínimo. Base de las alertas de stock bajo. */
  async findLowStock(): Promise<
    { id: string; name: string; productName: string; currentStock: Prisma.Decimal; minimumStock: Prisma.Decimal }[]
  > {
    return this.prisma.$queryRaw`
      SELECT v.id, v.name, p.name AS "productName", v."currentStock", v."minimumStock"
      FROM product_variants v
      JOIN products p ON p.id = v."productId"
      WHERE v."isActive" = true
        AND v."minimumStock" > 0
        AND v."currentStock" <= v."minimumStock"
      ORDER BY p.name, v.name
    `;
  }

  /** Valor del inventario a costo vigente. */
  async getInventoryValue(): Promise<{ totalCost: Prisma.Decimal; totalUnits: Prisma.Decimal }> {
    const rows = await this.prisma.$queryRaw<
      { totalCost: Prisma.Decimal | null; totalUnits: Prisma.Decimal | null }[]
    >`
      SELECT
        COALESCE(SUM(v."currentStock" * v."costPrice"), 0) AS "totalCost",
        COALESCE(SUM(v."currentStock"), 0) AS "totalUnits"
      FROM product_variants v
      WHERE v."isActive" = true
    `;

    const row = rows[0];
    return {
      totalCost: money(row?.totalCost ?? 0),
      totalUnits: quantity(row?.totalUnits ?? 0),
    };
  }

  async findMovements(
    productVariantId: string,
    take = 20,
  ): Promise<InventoryMovement[]> {
    return this.prisma.inventoryMovement.findMany({
      where: { productVariantId },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  /**
   * Recalcula `currentStock` desde los movimientos y reporta diferencias.
   * `currentStock` es una proyección; esto verifica que no haya divergido.
   */
  async reconcile(apply = false): Promise<
    { variantId: string; name: string; stored: Prisma.Decimal; computed: Prisma.Decimal }[]
  > {
    const rows = await this.prisma.$queryRaw<
      { variantId: string; name: string; stored: Prisma.Decimal; computed: Prisma.Decimal }[]
    >`
      SELECT
        v.id AS "variantId",
        v.name,
        v."currentStock" AS stored,
        COALESCE(SUM(
          CASE WHEN m.direction = 'IN' THEN m.quantity ELSE -m.quantity END
        ), 0) AS computed
      FROM product_variants v
      LEFT JOIN inventory_movements m ON m."productVariantId" = v.id
      GROUP BY v.id, v.name, v."currentStock"
      HAVING v."currentStock" <> COALESCE(SUM(
        CASE WHEN m.direction = 'IN' THEN m.quantity ELSE -m.quantity END
      ), 0)
    `;

    if (rows.length > 0) {
      this.logger.warn({ count: rows.length }, 'Variantes con stock divergente de sus movimientos');
    }

    if (apply) {
      for (const row of rows) {
        await this.prisma.productVariant.update({
          where: { id: row.variantId },
          data: { currentStock: row.computed },
        });
      }
    }

    return rows;
  }
}
