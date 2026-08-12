import { Injectable } from '@nestjs/common';
import { Prisma, SaleStatus } from '@prisma/client';
import { AccountingService, ProfitAndLoss } from '../accounting/accounting.service';
import { CreditsService } from '../credits/credits.service';
import { DateRange } from '../common/date-range';
import { money, quantity } from '../common/money';
import { PrismaService } from '../database/prisma.service';
import { ExpensesService } from '../expenses/expenses.service';
import { InventoryService } from '../inventory/inventory.service';

export interface SalesReport {
  range: DateRange;
  salesCount: number;
  grossSales: Prisma.Decimal;
  discounts: Prisma.Decimal;
  netSales: Prisma.Decimal;
  /** ITBIS contenido en lo facturado. No es ingreso tuyo. */
  taxCollected: Prisma.Decimal;
  /** Recargos por pago con tarjeta cobrados en el período. */
  surcharges: Prisma.Decimal;
  collected: Prisma.Decimal;
  onCredit: Prisma.Decimal;
  costOfGoodsSold: Prisma.Decimal;
  profit: Prisma.Decimal;
  averageTicket: Prisma.Decimal;
}

export interface ProductSalesRow {
  productVariantId: string;
  description: string;
  unitsSold: Prisma.Decimal;
  revenue: Prisma.Decimal;
  cost: Prisma.Decimal;
  profit: Prisma.Decimal;
  marginPercent: number;
}

export interface CustomerSalesRow {
  customerId: string;
  name: string;
  salesCount: number;
  total: Prisma.Decimal;
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounting: AccountingService,
    private readonly inventory: InventoryService,
    private readonly credits: CreditsService,
    private readonly expenses: ExpensesService,
  ) {}

  /** Reporte de ventas del período. Sólo cuentan las ventas completadas. */
  async getSalesReport(range: DateRange): Promise<SalesReport> {
    const where: Prisma.SaleWhereInput = {
      saleStatus: SaleStatus.COMPLETED,
      createdAt: { gte: range.from, lte: range.to },
    };

    const [aggregate, items] = await Promise.all([
      this.prisma.sale.aggregate({
        where,
        _sum: {
          subtotal: true,
          discount: true,
          total: true,
          taxAmount: true,
          surcharge: true,
          paidAmount: true,
          pendingAmount: true,
        },
        _count: { _all: true },
      }),
      this.prisma.saleItem.findMany({
        where: { sale: where },
        select: { quantity: true, unitCostSnapshot: true },
      }),
    ]);

    const salesCount = aggregate._count._all;
    const grossSales = money(aggregate._sum.subtotal ?? 0);
    const discounts = money(aggregate._sum.discount ?? 0);
    const netSales = money(aggregate._sum.total ?? 0);
    const taxCollected = money(aggregate._sum.taxAmount ?? 0);
    const surcharges = money(aggregate._sum.surcharge ?? 0);
    const collected = money(aggregate._sum.paidAmount ?? 0);
    const onCredit = money(aggregate._sum.pendingAmount ?? 0);

    const costOfGoodsSold = money(
      items.reduce(
        (acc, item) => acc.plus(item.quantity.times(item.unitCostSnapshot)),
        new Prisma.Decimal(0),
      ),
    );

    return {
      range,
      salesCount,
      grossSales,
      discounts,
      netSales,
      taxCollected,
      surcharges,
      collected,
      onCredit,
      costOfGoodsSold,
      // La ganancia se calcula sobre el ingreso real, sin el ITBIS que hay que entregar.
      profit: money(netSales.minus(taxCollected).minus(costOfGoodsSold)),
      averageTicket: salesCount > 0 ? money(netSales.dividedBy(salesCount)) : money(0),
    };
  }

  /**
   * Productos vendidos en el período, ordenables por unidades o por ganancia.
   * La agregación se hace en PostgreSQL: traer las líneas al proceso no escala.
   */
  async getProductSales(
    range: DateRange,
    orderBy: 'units' | 'profit' | 'margin' = 'units',
    limit = 10,
    direction: 'desc' | 'asc' = 'desc',
  ): Promise<ProductSalesRow[]> {
    const rows = await this.prisma.$queryRaw<
      {
        productVariantId: string;
        description: string;
        unitsSold: Prisma.Decimal;
        revenue: Prisma.Decimal;
        cost: Prisma.Decimal;
      }[]
    >`
      SELECT
        i."productVariantId",
        MAX(i."descriptionSnapshot") AS description,
        SUM(i.quantity) AS "unitsSold",
        SUM(i.total) AS revenue,
        SUM(i.quantity * i."unitCostSnapshot") AS cost
      FROM sale_items i
      JOIN sales s ON s.id = i."saleId"
      WHERE s."saleStatus" = 'COMPLETED'
        AND s."createdAt" >= ${range.from}
        AND s."createdAt" <= ${range.to}
      GROUP BY i."productVariantId"
    `;

    const mapped = rows.map((row) => {
      const revenue = money(row.revenue);
      const cost = money(row.cost);
      const profit = money(revenue.minus(cost));

      return {
        productVariantId: row.productVariantId,
        description: row.description,
        unitsSold: quantity(row.unitsSold),
        revenue,
        cost,
        profit,
        marginPercent: revenue.isZero()
          ? 0
          : Number(profit.dividedBy(revenue).times(100).toDecimalPlaces(2)),
      };
    });

    const compare = (a: ProductSalesRow, b: ProductSalesRow): number => {
      switch (orderBy) {
        case 'units':
          return b.unitsSold.comparedTo(a.unitsSold);
        case 'profit':
          return b.profit.comparedTo(a.profit);
        case 'margin':
          return b.marginPercent - a.marginPercent;
      }
    };

    const sorted = mapped.sort(compare);
    return (direction === 'desc' ? sorted : sorted.reverse()).slice(0, limit);
  }

  /** Mejores clientes del período. */
  async getTopCustomers(range: DateRange, limit = 10): Promise<CustomerSalesRow[]> {
    const grouped = await this.prisma.sale.groupBy({
      by: ['customerId'],
      where: {
        saleStatus: SaleStatus.COMPLETED,
        createdAt: { gte: range.from, lte: range.to },
        customerId: { not: null },
      },
      _sum: { total: true },
      _count: { _all: true },
    });

    const customers = await this.prisma.customer.findMany({
      where: { id: { in: grouped.map((row) => row.customerId!).filter(Boolean) } },
    });
    const byId = new Map(customers.map((customer) => [customer.id, customer]));

    return grouped
      .map((row) => ({
        customerId: row.customerId!,
        name: byId.get(row.customerId!)?.name ?? 'Cliente eliminado',
        salesCount: row._count._all,
        total: money(row._sum.total ?? 0),
      }))
      .sort((a, b) => b.total.comparedTo(a.total))
      .slice(0, limit);
  }

  /** Estado del inventario: valor, unidades y productos bajo mínimo. */
  async getInventoryReport(): Promise<{
    totalUnits: Prisma.Decimal;
    totalCost: Prisma.Decimal;
    lowStockCount: number;
    lowStock: { id: string; name: string; productName: string; currentStock: Prisma.Decimal; minimumStock: Prisma.Decimal }[];
  }> {
    const [value, lowStock] = await Promise.all([
      this.inventory.getInventoryValue(),
      this.inventory.findLowStock(),
    ]);

    return {
      totalUnits: value.totalUnits,
      totalCost: value.totalCost,
      lowStockCount: lowStock.length,
      lowStock: lowStock.slice(0, 20),
    };
  }

  /** Cuentas por cobrar: pendiente, vencido y próximos vencimientos. */
  async getCreditsReport(range: DateRange): Promise<{
    totalPending: Prisma.Decimal;
    totalOverdue: Prisma.Decimal;
    openCount: number;
    overdueCount: number;
    collectedInPeriod: Prisma.Decimal;
  }> {
    const [summary, collected] = await Promise.all([
      this.credits.getSummary(),
      this.prisma.payment.aggregate({
        where: {
          creditAccountId: { not: null },
          isReversal: false,
          createdAt: { gte: range.from, lte: range.to },
        },
        _sum: { amount: true },
      }),
    ]);

    return { ...summary, collectedInPeriod: money(collected._sum.amount ?? 0) };
  }

  /** Estado de resultados más la situación financiera actual. */
  async getFinancialReport(range: DateRange): Promise<{
    profitAndLoss: ProfitAndLoss;
    position: Awaited<ReturnType<AccountingService['getPosition']>>;
    expensesByCategory: Awaited<ReturnType<ExpensesService['getTotals']>>['byCategory'];
  }> {
    const [profitAndLoss, position, expenses] = await Promise.all([
      this.accounting.getProfitAndLoss(range),
      this.accounting.getPosition(),
      this.expenses.getTotals(range),
    ]);

    return { profitAndLoss, position, expensesByCategory: expenses.byCategory };
  }

  /** Resumen del día para la pantalla principal del bot. */
  async getDashboard(range: DateRange): Promise<{
    sales: SalesReport;
    expenses: Prisma.Decimal;
    netProfit: Prisma.Decimal;
    position: Awaited<ReturnType<AccountingService['getPosition']>>;
    lowStockCount: number;
  }> {
    const [sales, expenseTotals, position, lowStock] = await Promise.all([
      this.getSalesReport(range),
      this.expenses.getTotals(range),
      this.accounting.getPosition(),
      this.inventory.findLowStock(),
    ]);

    return {
      sales,
      expenses: expenseTotals.total,
      netProfit: money(sales.profit.minus(expenseTotals.total)),
      position,
      lowStockCount: lowStock.length,
    };
  }
}
