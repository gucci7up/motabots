import { Injectable } from '@nestjs/common';
import { Prisma, SaleStatus } from '@prisma/client';
import { DateRange } from '../common/date-range';
import { money } from '../common/money';
import { PrismaService } from '../database/prisma.service';

export interface ProfitAndLoss {
  range: DateRange;
  /** Ingresos: total de las ventas completadas del período. */
  revenue: Prisma.Decimal;
  /** Costo de ventas, siempre desde el snapshot congelado en cada línea. */
  costOfGoodsSold: Prisma.Decimal;
  grossProfit: Prisma.Decimal;
  expenses: Prisma.Decimal;
  netProfit: Prisma.Decimal;
  /** Margen bruto en porcentaje sobre los ingresos. */
  grossMarginPercent: number;
  salesCount: number;
}

export interface FinancialPosition {
  accountsReceivable: Prisma.Decimal;
  overdueReceivable: Prisma.Decimal;
  inventoryValue: Prisma.Decimal;
  cashOnHand: Prisma.Decimal;
}

@Injectable()
export class AccountingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Estado de resultados del período.
   *
   * Ingreso ≠ cobro: una venta a crédito es ingreso del día en que se vendió, aunque el
   * dinero entre semanas después. Por eso «vendí mucho» y «no tengo efectivo» pueden ser
   * ciertos a la vez sin que haya ningún error.
   */
  async getProfitAndLoss(range: DateRange): Promise<ProfitAndLoss> {
    const [salesAggregate, items, expensesAggregate] = await Promise.all([
      this.prisma.sale.aggregate({
        where: {
          saleStatus: SaleStatus.COMPLETED,
          createdAt: { gte: range.from, lte: range.to },
        },
        _sum: { total: true },
        _count: { _all: true },
      }),
      this.prisma.saleItem.findMany({
        where: {
          sale: {
            saleStatus: SaleStatus.COMPLETED,
            createdAt: { gte: range.from, lte: range.to },
          },
        },
        select: { quantity: true, unitCostSnapshot: true },
      }),
      this.prisma.expense.aggregate({
        where: { expenseDate: { gte: range.from, lte: range.to } },
        _sum: { amount: true },
      }),
    ]);

    const revenue = money(salesAggregate._sum.total ?? 0);

    const costOfGoodsSold = money(
      items.reduce(
        (acc, item) => acc.plus(item.quantity.times(item.unitCostSnapshot)),
        new Prisma.Decimal(0),
      ),
    );

    const grossProfit = money(revenue.minus(costOfGoodsSold));
    const expenses = money(expensesAggregate._sum.amount ?? 0);
    const netProfit = money(grossProfit.minus(expenses));

    const grossMarginPercent = revenue.isZero()
      ? 0
      : Number(grossProfit.dividedBy(revenue).times(100).toDecimalPlaces(2));

    return {
      range,
      revenue,
      costOfGoodsSold,
      grossProfit,
      expenses,
      netProfit,
      grossMarginPercent,
      salesCount: salesAggregate._count._all,
    };
  }

  /** Situación actual: por cobrar, inventario y efectivo en caja. */
  async getPosition(): Promise<FinancialPosition> {
    const now = new Date();

    const [receivable, overdue, inventory, cash] = await Promise.all([
      this.prisma.creditAccount.aggregate({
        where: { status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] } },
        _sum: { balance: true },
      }),
      this.prisma.creditAccount.aggregate({
        where: { status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] }, dueDate: { lt: now } },
        _sum: { balance: true },
      }),
      this.prisma.$queryRaw<{ value: Prisma.Decimal | null }[]>`
        SELECT COALESCE(SUM("currentStock" * "costPrice"), 0) AS value
        FROM product_variants WHERE "isActive" = true
      `,
      this.getCashOnHand(),
    ]);

    return {
      accountsReceivable: money(receivable._sum.balance ?? 0),
      overdueReceivable: money(overdue._sum.balance ?? 0),
      inventoryValue: money(inventory[0]?.value ?? 0),
      cashOnHand: cash,
    };
  }

  /** Efectivo en la caja abierta. Cero si no hay ninguna. */
  private async getCashOnHand(): Promise<Prisma.Decimal> {
    const session = await this.prisma.cashSession.findFirst({ where: { status: 'OPEN' } });
    if (!session) {
      return money(0);
    }

    const rows = await this.prisma.$queryRaw<{ balance: Prisma.Decimal | null }[]>`
      SELECT COALESCE(SUM(
        CASE WHEN direction = 'IN' THEN amount ELSE -amount END
      ), 0) AS balance
      FROM cash_movements
      WHERE "cashSessionId" = ${session.id} AND type <> 'CLOSING'
    `;

    return money(rows[0]?.balance ?? 0);
  }
}
