import { Injectable, Logger } from '@nestjs/common';
import {
  AccountingEntryType,
  CreditStatus,
  InventoryMovementType,
  InvoiceStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  Sale,
  SaleStatus,
} from '@prisma/client';
import { AuditAction, AuditService } from '../audit/audit.service';
import { DomainErrorCode, DomainException } from '../common/exceptions/domain.exception';
import { isNegative, money, multiply, quantity, sum } from '../common/money';
import { CustomersService } from '../customers/customers.service';
import { PrismaService, PrismaTransaction } from '../database/prisma.service';
import { InventoryService, MovementInput } from '../inventory/inventory.service';
import { InvoiceNumberService } from '../invoices/invoice-number.service';
import { SettingKey, SettingsService } from '../settings/settings.service';
import { CreateSaleDto, SaleItemDto } from './dto/create-sale.dto';

export type SaleWithDetail = Prisma.SaleGetPayload<{
  include: {
    items: true;
    payments: true;
    invoice: true;
    creditAccount: true;
    customer: true;
  };
}>;

const SALE_DETAIL = {
  items: true,
  payments: true,
  invoice: true,
  creditAccount: true,
  customer: true,
} satisfies Prisma.SaleInclude;

interface PreparedItem {
  productVariantId: string;
  descriptionSnapshot: string;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  discount: Prisma.Decimal;
  unitCostSnapshot: Prisma.Decimal;
  subtotal: Prisma.Decimal;
  total: Prisma.Decimal;
}

@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly customers: CustomersService,
    private readonly invoiceNumbers: InvoiceNumberService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Registra una venta completa. Todo ocurre dentro de una única transacción serializable:
   * venta, líneas, inventario, factura, pagos, crédito, caja, asientos y auditoría se
   * confirman juntos o no se crea nada. Nunca queda una venta a medias.
   */
  async create(dto: CreateSaleDto, userId: string): Promise<SaleWithDetail> {
    // La comprobación de idempotencia se repite dentro de la transacción; ésta sólo evita
    // el trabajo cuando la respuesta ya existe.
    if (dto.idempotencyKey) {
      const existing = await this.prisma.sale.findUnique({
        where: { idempotencyKey: dto.idempotencyKey },
        include: SALE_DETAIL,
      });
      if (existing) {
        this.logger.warn({ idempotencyKey: dto.idempotencyKey }, 'Venta duplicada descartada');
        return existing;
      }
    }

    const creditEnabled = await this.settings.getBoolean(SettingKey.CREDIT_ENABLED, true);

    const sale = await this.prisma.transaction(async (tx) => {
      if (dto.idempotencyKey) {
        const duplicate = await tx.sale.findUnique({
          where: { idempotencyKey: dto.idempotencyKey },
          include: SALE_DETAIL,
        });
        if (duplicate) {
          return duplicate;
        }
      }

      const items = await this.prepareItems(tx, dto.items);

      const itemsSubtotal = sum(items.map((item) => item.subtotal));
      const itemsDiscount = sum(items.map((item) => item.discount));
      const globalDiscount = dto.discount ? money(dto.discount) : money(0);

      if (isNegative(globalDiscount)) {
        throw new DomainException(
          DomainErrorCode.INVALID_AMOUNT,
          'El descuento no puede ser negativo.',
        );
      }

      const discount = money(itemsDiscount.plus(globalDiscount));
      const total = money(itemsSubtotal.minus(discount));

      if (isNegative(total)) {
        throw new DomainException(
          DomainErrorCode.INVALID_AMOUNT,
          'El descuento no puede superar el total de la venta.',
          { subtotal: itemsSubtotal.toString(), discount: discount.toString() },
        );
      }

      const paidAmount = sum((dto.payments ?? []).map((payment) => money(payment.amount)));

      if (isNegative(paidAmount)) {
        throw new DomainException(
          DomainErrorCode.INVALID_AMOUNT,
          'Los pagos no pueden ser negativos.',
        );
      }
      if (paidAmount.greaterThan(total)) {
        throw new DomainException(
          DomainErrorCode.INVALID_AMOUNT,
          `El pago (${paidAmount.toFixed(2)}) supera el total de la venta (${total.toFixed(2)}).`,
        );
      }

      const pendingAmount = money(total.minus(paidAmount));
      const hasCredit = pendingAmount.greaterThan(0);

      // Un saldo pendiente es una venta a crédito: exige cliente y fecha de vencimiento.
      if (hasCredit) {
        if (!creditEnabled) {
          throw new DomainException(
            DomainErrorCode.CREDIT_NOT_ALLOWED,
            'Las ventas a crédito están desactivadas en la configuración.',
          );
        }
        if (!dto.customerId) {
          throw new DomainException(
            DomainErrorCode.VALIDATION_FAILED,
            'Una venta a crédito necesita un cliente: hay que saber quién debe.',
          );
        }
        await this.customers.assertCreditLimit(dto.customerId, pendingAmount, tx);
      }

      const dueDate = hasCredit ? await this.resolveDueDate(dto.dueDate) : null;

      const paymentStatus = hasCredit
        ? paidAmount.greaterThan(0)
          ? PaymentStatus.PARTIAL
          : PaymentStatus.CREDIT
        : PaymentStatus.PAID;

      const saleNumber = await this.invoiceNumbers.nextSaleNumber(tx);

      const created = await tx.sale.create({
        data: {
          saleNumber,
          customerId: dto.customerId ?? null,
          userId,
          subtotal: itemsSubtotal,
          discount,
          taxAmount: money(0),
          total,
          paidAmount,
          pendingAmount,
          paymentStatus,
          saleStatus: SaleStatus.COMPLETED,
          notes: dto.notes?.trim() || null,
          idempotencyKey: dto.idempotencyKey ?? null,
          items: { create: items },
        },
        include: SALE_DETAIL,
      });

      // Inventario: una salida por línea, con el bloqueo de variantes que impide sobreventa.
      const movements: MovementInput[] = created.items.map((item) => ({
        productVariantId: item.productVariantId,
        type: InventoryMovementType.SALE,
        quantity: item.quantity,
        unitCost: item.unitCostSnapshot,
        referenceType: 'SALE',
        referenceId: created.id,
        userId,
      }));
      await this.inventory.applyMovements(tx, movements);

      // Factura con número consecutivo tomado bajo bloqueo.
      const invoiceNumber = await this.invoiceNumbers.next(tx);
      await tx.invoice.create({
        data: {
          number: invoiceNumber,
          series: 'DEFAULT',
          saleId: created.id,
          customerId: dto.customerId ?? null,
          subtotal: itemsSubtotal,
          discount,
          taxAmount: money(0),
          total,
          paidAmount,
          pendingAmount,
          status: this.invoiceStatusFor(paymentStatus),
        },
      });

      for (const payment of dto.payments ?? []) {
        const amount = money(payment.amount);
        if (amount.isZero()) {
          continue;
        }
        await tx.payment.create({
          data: {
            saleId: created.id,
            customerId: dto.customerId ?? null,
            amount,
            method: payment.method,
            reference: payment.reference?.trim() || null,
            userId,
          },
        });
      }

      if (hasCredit && dueDate) {
        await tx.creditAccount.create({
          data: {
            saleId: created.id,
            customerId: dto.customerId!,
            originalAmount: pendingAmount,
            paidAmount: money(0),
            balance: pendingAmount,
            dueDate,
            status: CreditStatus.PENDING,
          },
        });
      }

      const costOfGoods = sum(
        created.items.map((item) => multiply(item.quantity, item.unitCostSnapshot)),
      );

      await tx.accountingEntry.createMany({
        data: [
          {
            type: AccountingEntryType.REVENUE,
            referenceType: 'SALE',
            referenceId: created.id,
            description: `Venta ${saleNumber}`,
            amount: total,
            userId,
          },
          {
            type: AccountingEntryType.COST_OF_GOODS_SOLD,
            referenceType: 'SALE',
            referenceId: created.id,
            description: `Costo de venta ${saleNumber}`,
            amount: costOfGoods,
            userId,
          },
          ...(hasCredit
            ? [
                {
                  type: AccountingEntryType.CREDIT_ISSUED,
                  referenceType: 'SALE',
                  referenceId: created.id,
                  description: `Crédito otorgado en ${saleNumber}`,
                  amount: pendingAmount,
                  userId,
                },
              ]
            : []),
        ],
      });

      await this.audit.recordIn(tx, {
        userId,
        action: AuditAction.SALE_CREATED,
        entity: 'Sale',
        entityId: created.id,
        after: {
          saleNumber,
          invoiceNumber,
          total,
          paidAmount,
          pendingAmount,
          paymentStatus,
          items: created.items.length,
        },
      });

      return tx.sale.findUniqueOrThrow({ where: { id: created.id }, include: SALE_DETAIL });
    });

    return sale;
  }

  /**
   * Cancela una venta. No se borra nada: se invierte. Devuelve el inventario, anula la
   * factura, cancela el crédito y registra asientos inversos, todo en una transacción.
   */
  async cancel(saleId: string, reason: string, userId: string): Promise<SaleWithDetail> {
    return this.prisma.transaction(async (tx) => {
      const sale = await tx.sale.findUnique({ where: { id: saleId }, include: SALE_DETAIL });

      if (!sale) {
        throw DomainException.notFound('la venta', saleId);
      }
      if (sale.saleStatus === SaleStatus.CANCELLED) {
        throw new DomainException(
          DomainErrorCode.SALE_ALREADY_CANCELLED,
          'Esta venta ya estaba cancelada.',
        );
      }

      // Devolución de inventario: movimiento inverso, nunca borrado del original.
      await this.inventory.applyMovements(
        tx,
        sale.items.map((item) => ({
          productVariantId: item.productVariantId,
          type: InventoryMovementType.SALE_CANCELLATION,
          quantity: item.quantity,
          unitCost: item.unitCostSnapshot,
          referenceType: 'SALE_CANCELLATION',
          referenceId: sale.id,
          userId,
          notes: reason,
        })),
      );

      // Los pagos cobrados se revierten con un pago de reversión, no se editan.
      for (const payment of sale.payments.filter((p) => !p.isReversal)) {
        await tx.payment.create({
          data: {
            saleId: sale.id,
            customerId: sale.customerId,
            amount: money(payment.amount).negated(),
            method: payment.method,
            reference: payment.reference,
            notes: `Reversión por cancelación: ${reason}`,
            userId,
            isReversal: true,
            reversedPaymentId: payment.id,
          },
        });
      }

      if (sale.creditAccount) {
        // El saldo se conserva tal cual: `balance = originalAmount − paidAmount` es una
        // invariante con CHECK en la base. Lo que anula la deuda es el estado CANCELLED,
        // que queda fuera de los estados abiertos con los que se calcula lo que debe el cliente.
        await tx.creditAccount.update({
          where: { id: sale.creditAccount.id },
          data: {
            status: CreditStatus.CANCELLED,
            cancelledAt: new Date(),
            notes: reason,
          },
        });
      }

      if (sale.invoice) {
        await tx.invoice.update({
          where: { id: sale.invoice.id },
          data: {
            status: InvoiceStatus.CANCELLED,
            cancelledAt: new Date(),
            cancelledById: userId,
            cancellationReason: reason,
          },
        });
      }

      const costOfGoods = sum(
        sale.items.map((item) => multiply(item.quantity, item.unitCostSnapshot)),
      );

      await tx.accountingEntry.createMany({
        data: [
          {
            type: AccountingEntryType.REVENUE,
            referenceType: 'SALE_CANCELLATION',
            referenceId: sale.id,
            description: `Anulación de venta ${sale.saleNumber}`,
            amount: money(sale.total).negated(),
            userId,
          },
          {
            type: AccountingEntryType.COST_OF_GOODS_SOLD,
            referenceType: 'SALE_CANCELLATION',
            referenceId: sale.id,
            description: `Reverso de costo ${sale.saleNumber}`,
            amount: costOfGoods.negated(),
            userId,
          },
        ],
      });

      // El total histórico NO se toca: borrarlo destruiría el registro de lo que se vendió.
      // Tras las reversiones lo cobrado neto es cero, así que `pendingAmount` vuelve a ser el
      // total para respetar la invariante `pagado + pendiente = total`. Nadie debe ese dinero:
      // los reportes y el saldo del cliente excluyen las ventas CANCELLED.
      const cancelled = await tx.sale.update({
        where: { id: sale.id },
        data: {
          saleStatus: SaleStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelledById: userId,
          cancellationReason: reason,
          paidAmount: money(0),
          pendingAmount: money(sale.total),
        },
        include: SALE_DETAIL,
      });

      await this.audit.recordIn(tx, {
        userId,
        action: AuditAction.SALE_CANCELLED,
        entity: 'Sale',
        entityId: sale.id,
        before: {
          saleStatus: sale.saleStatus,
          paidAmount: sale.paidAmount,
          pendingAmount: sale.pendingAmount,
        },
        after: { saleStatus: SaleStatus.CANCELLED, reason },
      });

      return cancelled;
    });
  }

  async findById(id: string): Promise<SaleWithDetail> {
    const sale = await this.prisma.sale.findUnique({ where: { id }, include: SALE_DETAIL });
    if (!sale) {
      throw DomainException.notFound('la venta', id);
    }
    return sale;
  }

  async findRecent(take = 10): Promise<Sale[]> {
    return this.prisma.sale.findMany({
      where: { saleStatus: SaleStatus.COMPLETED },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  /**
   * Congela precio y costo de cada línea. Es lo que hace que cambiar el precio mañana
   * no altere lo que se vendió hoy.
   */
  private async prepareItems(
    tx: PrismaTransaction,
    items: readonly SaleItemDto[],
  ): Promise<PreparedItem[]> {
    const variantIds = [...new Set(items.map((item) => item.productVariantId))];
    const variants = await tx.productVariant.findMany({
      where: { id: { in: variantIds } },
      include: { product: true },
    });
    const byId = new Map(variants.map((variant) => [variant.id, variant]));

    return items.map((item) => {
      const variant = byId.get(item.productVariantId);
      if (!variant) {
        throw DomainException.notFound('la variante', item.productVariantId);
      }
      if (!variant.isActive) {
        throw new DomainException(
          DomainErrorCode.VALIDATION_FAILED,
          `${variant.product.name} ${variant.name} está desactivado y no puede venderse.`,
        );
      }

      const qty = quantity(item.quantity);
      if (!qty.greaterThan(0)) {
        throw new DomainException(
          DomainErrorCode.VALIDATION_FAILED,
          'La cantidad debe ser mayor que cero.',
        );
      }

      const unitPrice = item.unitPrice !== undefined ? money(item.unitPrice) : money(variant.salePrice);
      if (isNegative(unitPrice)) {
        throw new DomainException(
          DomainErrorCode.INVALID_AMOUNT,
          'El precio no puede ser negativo.',
        );
      }

      const discount = item.discount ? money(item.discount) : money(0);
      if (isNegative(discount)) {
        throw new DomainException(
          DomainErrorCode.INVALID_AMOUNT,
          'El descuento no puede ser negativo.',
        );
      }

      const subtotal = multiply(qty, unitPrice);
      if (discount.greaterThan(subtotal)) {
        throw new DomainException(
          DomainErrorCode.INVALID_AMOUNT,
          `El descuento supera el importe de ${variant.product.name} ${variant.name}.`,
        );
      }

      return {
        productVariantId: variant.id,
        descriptionSnapshot: `${variant.product.name} ${variant.name}`.trim(),
        quantity: qty,
        unitPrice,
        discount,
        unitCostSnapshot: variant.costPrice,
        subtotal,
        total: money(subtotal.minus(discount)),
      };
    });
  }

  private async resolveDueDate(raw?: string): Promise<Date> {
    if (raw) {
      const date = new Date(raw);
      if (Number.isNaN(date.getTime())) {
        throw new DomainException(
          DomainErrorCode.VALIDATION_FAILED,
          'La fecha de vencimiento no es válida.',
        );
      }
      return date;
    }

    const days = await this.settings.getNumber(SettingKey.CREDIT_DEFAULT_DUE_DAYS, 15);
    const date = new Date();
    date.setDate(date.getDate() + days);
    return date;
  }

  private invoiceStatusFor(paymentStatus: PaymentStatus): InvoiceStatus {
    switch (paymentStatus) {
      case PaymentStatus.PAID:
        return InvoiceStatus.PAID;
      case PaymentStatus.PARTIAL:
        return InvoiceStatus.PARTIAL;
      case PaymentStatus.CREDIT:
        return InvoiceStatus.CREDIT;
    }
  }
}

export { PaymentMethod };
