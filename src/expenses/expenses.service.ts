import { Injectable } from '@nestjs/common';
import {
  AccountingEntryType,
  CashMovementType,
  Expense,
  ExpenseCategory,
  PaymentMethod,
  Prisma,
} from '@prisma/client';
import { AuditAction, AuditService } from '../audit/audit.service';
import { CashService } from '../cash/cash.service';
import { PaginatedResult, paginate } from '../common/dto/pagination.dto';
import { DomainErrorCode, DomainException } from '../common/exceptions/domain.exception';
import { money } from '../common/money';
import { PrismaService } from '../database/prisma.service';

export interface CreateExpenseInput {
  expenseCategoryCode: string;
  amount: string | Prisma.Decimal;
  description: string;
  paymentMethod: PaymentMethod;
  reference?: string;
  expenseDate?: Date;
  userId: string;
}

export type ExpenseWithCategory = Prisma.ExpenseGetPayload<{ include: { category: true } }>;

@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cash: CashService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Registra un gasto. Si se pagó en efectivo y hay caja abierta, sale de la caja en la
   * misma transacción: un gasto en efectivo que no descuente de caja la descuadra al cerrar.
   */
  async create(input: CreateExpenseInput): Promise<ExpenseWithCategory> {
    const amount = money(input.amount);

    if (!amount.greaterThan(0)) {
      throw new DomainException(
        DomainErrorCode.INVALID_AMOUNT,
        'El gasto debe ser mayor que cero.',
      );
    }

    const description = input.description.trim();
    if (description.length === 0) {
      throw new DomainException(
        DomainErrorCode.VALIDATION_FAILED,
        'El gasto necesita una descripción: sin ella el reporte no sirve de nada.',
      );
    }

    const category = await this.prisma.expenseCategory.findUnique({
      where: { code: input.expenseCategoryCode },
    });

    if (!category || !category.isActive) {
      throw DomainException.notFound('la categoría de gasto', input.expenseCategoryCode);
    }

    return this.prisma.transaction(async (tx) => {
      const session =
        input.paymentMethod === PaymentMethod.CASH ? await this.cash.getOpenSession(tx) : null;

      const expense = await tx.expense.create({
        data: {
          expenseCategoryId: category.id,
          amount,
          description,
          paymentMethod: input.paymentMethod,
          reference: input.reference?.trim() || null,
          userId: input.userId,
          cashSessionId: session?.id ?? null,
          expenseDate: input.expenseDate ?? new Date(),
        },
        include: { category: true },
      });

      if (session) {
        await this.cash.addMovement(tx, session.id, {
          type: CashMovementType.EXPENSE,
          amount,
          description: `${category.name}: ${description}`,
          referenceType: 'EXPENSE',
          referenceId: expense.id,
          userId: input.userId,
        });
      }

      await tx.accountingEntry.createMany({
        data: [
          {
            type: AccountingEntryType.EXPENSE,
            referenceType: 'EXPENSE',
            referenceId: expense.id,
            description: `${category.name}: ${description}`,
            amount,
            userId: input.userId,
          },
          ...(session
            ? [
                {
                  type: AccountingEntryType.CASH_OUT,
                  referenceType: 'EXPENSE',
                  referenceId: expense.id,
                  description: `Salida de caja: ${description}`,
                  amount,
                  userId: input.userId,
                },
              ]
            : []),
        ],
      });

      await this.audit.recordIn(tx, {
        userId: input.userId,
        action: AuditAction.EXPENSE_CREATED,
        entity: 'Expense',
        entityId: expense.id,
        after: {
          amount,
          category: category.code,
          description,
          paymentMethod: input.paymentMethod,
          affectedCash: session !== null,
        },
      });

      return expense;
    });
  }

  findCategories(): Promise<ExpenseCategory[]> {
    return this.prisma.expenseCategory.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async findAll(
    page: number,
    pageSize: number,
    range?: { from: Date; to: Date },
  ): Promise<PaginatedResult<ExpenseWithCategory>> {
    const where: Prisma.ExpenseWhereInput = range
      ? { expenseDate: { gte: range.from, lte: range.to } }
      : {};

    const [expenses, total] = await Promise.all([
      this.prisma.expense.findMany({
        where,
        include: { category: true },
        orderBy: { expenseDate: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.expense.count({ where }),
    ]);

    return paginate(expenses, total, page, pageSize);
  }

  /** Total de gastos del período, desglosado por categoría. */
  async getTotals(range: { from: Date; to: Date }): Promise<{
    total: Prisma.Decimal;
    byCategory: { code: string; name: string; total: Prisma.Decimal; count: number }[];
  }> {
    const expenses = await this.prisma.expense.findMany({
      where: { expenseDate: { gte: range.from, lte: range.to } },
      include: { category: true },
    });

    let total = money(0);
    const grouped = new Map<string, { code: string; name: string; total: Prisma.Decimal; count: number }>();

    for (const expense of expenses) {
      total = money(total.plus(expense.amount));

      const current = grouped.get(expense.category.code);
      if (current) {
        current.total = money(current.total.plus(expense.amount));
        current.count++;
      } else {
        grouped.set(expense.category.code, {
          code: expense.category.code,
          name: expense.category.name,
          total: money(expense.amount),
          count: 1,
        });
      }
    }

    const byCategory = [...grouped.values()].sort((a, b) => b.total.comparedTo(a.total));

    return { total, byCategory };
  }

  async findById(id: string): Promise<ExpenseWithCategory> {
    const expense = await this.prisma.expense.findUnique({
      where: { id },
      include: { category: true },
    });
    if (!expense) {
      throw DomainException.notFound('el gasto', id);
    }
    return expense;
  }
}

export type { Expense };
