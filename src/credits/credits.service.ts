import { Injectable, Logger } from '@nestjs/common';
import {
  AccountingEntryType,
  CreditAccount,
  CreditStatus,
  InvoiceStatus,
  Payment,
  PaymentMethod,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { AuditAction, AuditService } from '../audit/audit.service';
import { DomainErrorCode, DomainException } from '../common/exceptions/domain.exception';
import { PaginatedResult, paginate } from '../common/dto/pagination.dto';
import { formatMoney, isNegative, money } from '../common/money';
import { OPEN_CREDIT_STATUSES } from '../customers/customers.service';
import { PrismaService, PrismaTransaction } from '../database/prisma.service';

export interface RegisterInstallmentInput {
  creditAccountId: string;
  amount: string | Prisma.Decimal;
  method: PaymentMethod;
  reference?: string;
  notes?: string;
  userId: string;
  cashSessionId?: string | null;
  idempotencyKey?: string;
}

export interface InstallmentResult {
  payment: Payment;
  credit: CreditAccount;
  fullyPaid: boolean;
}

type CreditWithRelations = Prisma.CreditAccountGetPayload<{
  include: { customer: true; sale: { include: { invoice: true } } };
}>;

@Injectable()
export class CreditsService {
  private readonly logger = new Logger(CreditsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Registra un abono a un crédito.
   *
   * Todo va en una transacción con la fila del crédito bloqueada (FOR UPDATE): dos abonos
   * simultáneos al mismo crédito hacen cola, no se pisan. El bloqueo explícito es lo que da
   * la garantía, por eso basta ReadCommitted. El saldo de la venta y de la
   * factura se recalculan desde los pagos, nunca se ajustan a mano.
   */
  async registerInstallment(input: RegisterInstallmentInput): Promise<InstallmentResult> {
    const amount = money(input.amount);

    if (!amount.greaterThan(0)) {
      throw new DomainException(
        DomainErrorCode.INVALID_AMOUNT,
        'El abono debe ser mayor que cero.',
      );
    }

    if (input.idempotencyKey) {
      const existing = await this.prisma.payment.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (existing && existing.creditAccountId) {
        this.logger.warn({ key: input.idempotencyKey }, 'Abono duplicado descartado');
        const credit = await this.prisma.creditAccount.findUniqueOrThrow({
          where: { id: existing.creditAccountId },
        });
        return { payment: existing, credit, fullyPaid: credit.status === CreditStatus.PAID };
      }
    }

    return this.prisma.transaction(async (tx) => {
      const credit = await this.lockCredit(tx, input.creditAccountId);

      if (credit.status === CreditStatus.CANCELLED) {
        throw new DomainException(
          DomainErrorCode.CONFLICT,
          'Este crédito está cancelado: no admite abonos.',
        );
      }
      if (credit.status === CreditStatus.PAID) {
        throw new DomainException(DomainErrorCode.CONFLICT, 'Este crédito ya está saldado.');
      }

      const balance = money(credit.balance);
      if (amount.greaterThan(balance)) {
        throw new DomainException(
          DomainErrorCode.INVALID_AMOUNT,
          `El abono (${formatMoney(amount)}) supera el saldo pendiente (${formatMoney(balance)}).`,
          { balance: balance.toString(), amount: amount.toString() },
        );
      }

      const newPaid = money(money(credit.paidAmount).plus(amount));
      const newBalance = money(money(credit.originalAmount).minus(newPaid));
      const fullyPaid = newBalance.isZero();

      const payment = await tx.payment.create({
        data: {
          saleId: credit.saleId,
          creditAccountId: credit.id,
          customerId: credit.customerId,
          cashSessionId: input.cashSessionId ?? null,
          amount,
          method: input.method,
          reference: input.reference?.trim() || null,
          notes: input.notes?.trim() || null,
          userId: input.userId,
          idempotencyKey: input.idempotencyKey ?? null,
        },
      });

      const updatedCredit = await tx.creditAccount.update({
        where: { id: credit.id },
        data: {
          paidAmount: newPaid,
          balance: newBalance,
          status: fullyPaid ? CreditStatus.PAID : CreditStatus.PARTIAL,
          closedAt: fullyPaid ? new Date() : null,
        },
      });

      // La venta y la factura reflejan lo cobrado. Se derivan del crédito, no se tocan aparte.
      const sale = await tx.sale.findUniqueOrThrow({ where: { id: credit.saleId } });
      const salePaid = money(money(sale.paidAmount).plus(amount));
      const salePending = money(money(sale.total).minus(salePaid));

      await tx.sale.update({
        where: { id: sale.id },
        data: {
          paidAmount: salePaid,
          pendingAmount: salePending,
          paymentStatus: salePending.isZero() ? PaymentStatus.PAID : PaymentStatus.PARTIAL,
        },
      });

      const invoice = await tx.invoice.findUnique({ where: { saleId: sale.id } });
      if (invoice && invoice.status !== InvoiceStatus.CANCELLED) {
        await tx.invoice.update({
          where: { id: invoice.id },
          data: {
            paidAmount: salePaid,
            pendingAmount: salePending,
            status: salePending.isZero() ? InvoiceStatus.PAID : InvoiceStatus.PARTIAL,
          },
        });
      }

      await tx.accountingEntry.createMany({
        data: [
          {
            type: AccountingEntryType.CREDIT_COLLECTED,
            referenceType: 'CREDIT_PAYMENT',
            referenceId: payment.id,
            description: `Abono a crédito de venta ${sale.saleNumber}`,
            amount,
            userId: input.userId,
          },
          ...(input.method === PaymentMethod.CASH
            ? [
                {
                  type: AccountingEntryType.CASH_IN,
                  referenceType: 'CREDIT_PAYMENT',
                  referenceId: payment.id,
                  description: `Cobro en efectivo ${sale.saleNumber}`,
                  amount,
                  userId: input.userId,
                },
              ]
            : []),
        ],
      });

      await this.audit.recordIn(tx, {
        userId: input.userId,
        action: AuditAction.CREDIT_COLLECTED,
        entity: 'CreditAccount',
        entityId: credit.id,
        before: { balance: credit.balance, status: credit.status },
        after: { balance: newBalance, status: updatedCredit.status, amount },
        metadata: { method: input.method, reference: input.reference ?? null },
      });

      return { payment, credit: updatedCredit, fullyPaid };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  async findById(id: string): Promise<CreditWithRelations> {
    const credit = await this.prisma.creditAccount.findUnique({
      where: { id },
      include: { customer: true, sale: { include: { invoice: true } } },
    });

    if (!credit) {
      throw DomainException.notFound('el crédito', id);
    }
    return credit;
  }

  async findByCustomer(customerId: string, onlyOpen = true): Promise<CreditWithRelations[]> {
    return this.prisma.creditAccount.findMany({
      where: {
        customerId,
        ...(onlyOpen ? { status: { in: OPEN_CREDIT_STATUSES } } : {}),
      },
      include: { customer: true, sale: { include: { invoice: true } } },
      orderBy: { dueDate: 'asc' },
    });
  }

  async findOpen(page: number, pageSize: number): Promise<PaginatedResult<CreditWithRelations>> {
    const where: Prisma.CreditAccountWhereInput = { status: { in: OPEN_CREDIT_STATUSES } };

    const [credits, total] = await Promise.all([
      this.prisma.creditAccount.findMany({
        where,
        include: { customer: true, sale: { include: { invoice: true } } },
        orderBy: { dueDate: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.creditAccount.count({ where }),
    ]);

    return paginate(credits, total, page, pageSize);
  }

  /** Totales de cuentas por cobrar. */
  async getSummary(): Promise<{
    totalPending: Prisma.Decimal;
    totalOverdue: Prisma.Decimal;
    openCount: number;
    overdueCount: number;
  }> {
    const now = new Date();

    const [open, overdue] = await Promise.all([
      this.prisma.creditAccount.aggregate({
        where: { status: { in: OPEN_CREDIT_STATUSES } },
        _sum: { balance: true },
        _count: { _all: true },
      }),
      this.prisma.creditAccount.aggregate({
        where: { status: { in: OPEN_CREDIT_STATUSES }, dueDate: { lt: now } },
        _sum: { balance: true },
        _count: { _all: true },
      }),
    ]);

    return {
      totalPending: money(open._sum.balance ?? 0),
      totalOverdue: money(overdue._sum.balance ?? 0),
      openCount: open._count._all,
      overdueCount: overdue._count._all,
    };
  }

  /**
   * Marca como OVERDUE los créditos vencidos con saldo. Lo ejecuta un job diario:
   * `OVERDUE` es un estado derivado del tiempo, no algo que el usuario asigne.
   */
  async markOverdue(): Promise<number> {
    const result = await this.prisma.creditAccount.updateMany({
      where: {
        status: { in: [CreditStatus.PENDING, CreditStatus.PARTIAL] },
        dueDate: { lt: new Date() },
        balance: { gt: 0 },
      },
      data: { status: CreditStatus.OVERDUE },
    });

    if (result.count > 0) {
      this.logger.log(`Créditos marcados como vencidos: ${result.count}`);
    }

    return result.count;
  }

  private async lockCredit(tx: PrismaTransaction, id: string): Promise<CreditAccount> {
    const rows = await tx.$queryRaw<CreditAccount[]>`
      SELECT * FROM credit_accounts WHERE id = ${id} FOR UPDATE
    `;

    const credit = rows[0];
    if (!credit) {
      throw DomainException.notFound('el crédito', id);
    }

    // El saldo viene de PostgreSQL como string en raw queries: se normaliza a Decimal.
    return {
      ...credit,
      originalAmount: money(credit.originalAmount),
      paidAmount: money(credit.paidAmount),
      balance: money(credit.balance),
    };
  }
}

export { isNegative };
