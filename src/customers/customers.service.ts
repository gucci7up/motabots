import { Injectable } from '@nestjs/common';
import { CreditStatus, Customer, Prisma } from '@prisma/client';
import { PaginatedResult, paginate } from '../common/dto/pagination.dto';
import { DomainErrorCode, DomainException } from '../common/exceptions/domain.exception';
import { isNegative, money } from '../common/money';
import { PrismaService, PrismaTransaction } from '../database/prisma.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

/** Estados de crédito que siguen debiendo dinero. */
export const OPEN_CREDIT_STATUSES: CreditStatus[] = [
  CreditStatus.PENDING,
  CreditStatus.PARTIAL,
  CreditStatus.OVERDUE,
];

export interface CustomerBalance {
  /** Suma de los saldos de créditos abiertos. */
  balance: Prisma.Decimal;
  overdueBalance: Prisma.Decimal;
  openCredits: number;
  overdueCredits: number;
}

export interface CustomerHistory {
  customer: Customer;
  balance: CustomerBalance;
  totalPurchases: Prisma.Decimal;
  salesCount: number;
  lastSaleAt: Date | null;
}

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateCustomerDto): Promise<Customer> {
    return this.prisma.customer.create({ data: this.toData(dto) });
  }

  async update(id: string, dto: UpdateCustomerDto): Promise<Customer> {
    await this.findById(id);

    const data: Prisma.CustomerUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.phone !== undefined) data.phone = this.normalizePhone(dto.phone);
    if (dto.email !== undefined) data.email = dto.email.trim() || null;
    if (dto.address !== undefined) data.address = dto.address.trim() || null;
    if (dto.identificationNumber !== undefined) {
      data.identificationNumber = dto.identificationNumber.trim() || null;
    }
    if (dto.notes !== undefined) data.notes = dto.notes.trim() || null;
    if (dto.creditLimit !== undefined) data.creditLimit = this.parseCreditLimit(dto.creditLimit);
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    return this.prisma.customer.update({ where: { id }, data });
  }

  async findById(id: string): Promise<Customer> {
    const customer = await this.prisma.customer.findUnique({ where: { id } });
    if (!customer) {
      throw DomainException.notFound('el cliente', id);
    }
    return customer;
  }

  async findAll(page: number, pageSize: number): Promise<PaginatedResult<Customer>> {
    const where: Prisma.CustomerWhereInput = { isActive: true };

    const [customers, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.customer.count({ where }),
    ]);

    return paginate(customers, total, page, pageSize);
  }

  /**
   * Búsqueda por nombre, teléfono o identificación. El teléfono se compara sin formato:
   * el usuario puede tener guardado "809-123-4567" y escribir "8091234567".
   */
  async search(term: string, page: number, pageSize: number): Promise<PaginatedResult<Customer>> {
    const query = term.trim();
    if (query.length === 0) {
      return this.findAll(page, pageSize);
    }

    const digits = query.replace(/\D/g, '');

    const where: Prisma.CustomerWhereInput = {
      isActive: true,
      OR: [
        { name: { contains: query, mode: 'insensitive' } },
        { identificationNumber: { contains: query, mode: 'insensitive' } },
        ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : []),
        ...(query !== digits ? [{ phone: { contains: query } }] : []),
      ],
    };

    const [customers, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.customer.count({ where }),
    ]);

    return paginate(customers, total, page, pageSize);
  }

  /**
   * Saldo pendiente calculado desde los créditos abiertos. No hay campo `balance` en la
   * tabla: un saldo guardado a mano se desincroniza justo cuando más importa.
   */
  async getBalance(customerId: string, tx?: PrismaTransaction): Promise<CustomerBalance> {
    const client = tx ?? this.prisma;
    const now = new Date();

    const credits = await client.creditAccount.findMany({
      where: { customerId, status: { in: OPEN_CREDIT_STATUSES } },
      select: { balance: true, dueDate: true },
    });

    let balance = money(0);
    let overdueBalance = money(0);
    let overdueCredits = 0;

    for (const credit of credits) {
      balance = money(balance.plus(credit.balance));
      if (credit.dueDate < now) {
        overdueBalance = money(overdueBalance.plus(credit.balance));
        overdueCredits++;
      }
    }

    return { balance, overdueBalance, openCredits: credits.length, overdueCredits };
  }

  /** Ficha completa del cliente para el bot: saldo, compras acumuladas y última venta. */
  async getHistory(customerId: string): Promise<CustomerHistory> {
    const customer = await this.findById(customerId);
    const balance = await this.getBalance(customerId);

    const aggregate = await this.prisma.sale.aggregate({
      where: { customerId, saleStatus: 'COMPLETED' },
      _sum: { total: true },
      _count: { _all: true },
      _max: { createdAt: true },
    });

    return {
      customer,
      balance,
      totalPurchases: money(aggregate._sum.total ?? 0),
      salesCount: aggregate._count._all,
      lastSaleAt: aggregate._max.createdAt,
    };
  }

  /** Clientes con deuda abierta, ordenados por saldo descendente. */
  async findWithDebt(
    page: number,
    pageSize: number,
    onlyOverdue = false,
  ): Promise<PaginatedResult<{ customer: Customer; balance: Prisma.Decimal; overdue: boolean }>> {
    const now = new Date();

    const credits = await this.prisma.creditAccount.groupBy({
      by: ['customerId'],
      where: {
        status: { in: OPEN_CREDIT_STATUSES },
        ...(onlyOverdue ? { dueDate: { lt: now } } : {}),
      },
      _sum: { balance: true },
      _min: { dueDate: true },
    });

    const sorted = credits
      .map((row) => ({
        customerId: row.customerId,
        balance: money(row._sum.balance ?? 0),
        overdue: row._min.dueDate !== null && row._min.dueDate < now,
      }))
      .filter((row) => row.balance.greaterThan(0))
      .sort((a, b) => b.balance.comparedTo(a.balance));

    const pageRows = sorted.slice((page - 1) * pageSize, page * pageSize);

    const customers = await this.prisma.customer.findMany({
      where: { id: { in: pageRows.map((row) => row.customerId) } },
    });
    const byId = new Map(customers.map((customer) => [customer.id, customer]));

    const data = pageRows
      .map((row) => {
        const customer = byId.get(row.customerId);
        return customer ? { customer, balance: row.balance, overdue: row.overdue } : null;
      })
      .filter((row): row is { customer: Customer; balance: Prisma.Decimal; overdue: boolean } =>
        row !== null,
      );

    return paginate(data, sorted.length, page, pageSize);
  }

  /**
   * Verifica que una nueva venta a crédito no supere el límite del cliente.
   * Sin límite configurado, no hay tope.
   */
  async assertCreditLimit(
    customerId: string,
    additionalCredit: Prisma.Decimal,
    tx?: PrismaTransaction,
  ): Promise<void> {
    const client = tx ?? this.prisma;
    const customer = await client.customer.findUnique({ where: { id: customerId } });

    if (!customer) {
      throw DomainException.notFound('el cliente', customerId);
    }
    if (customer.creditLimit === null) {
      return;
    }

    const { balance } = await this.getBalance(customerId, tx);
    const projected = money(balance.plus(additionalCredit));

    if (projected.greaterThan(customer.creditLimit)) {
      throw new DomainException(
        DomainErrorCode.CREDIT_LIMIT_EXCEEDED,
        `El crédito supera el límite de ${customer.name}: ` +
          `saldo actual ${balance.toFixed(2)}, límite ${money(customer.creditLimit).toFixed(2)}.`,
        {
          customerId,
          currentBalance: balance.toString(),
          creditLimit: customer.creditLimit.toString(),
          requested: additionalCredit.toString(),
        },
      );
    }
  }

  private toData(dto: CreateCustomerDto): Prisma.CustomerCreateInput {
    return {
      name: dto.name.trim(),
      phone: this.normalizePhone(dto.phone),
      email: dto.email?.trim() || null,
      address: dto.address?.trim() || null,
      identificationNumber: dto.identificationNumber?.trim() || null,
      notes: dto.notes?.trim() || null,
      creditLimit: dto.creditLimit !== undefined ? this.parseCreditLimit(dto.creditLimit) : null,
    };
  }

  /** Guarda sólo los dígitos: así la búsqueda no depende de cómo se escribió el número. */
  private normalizePhone(phone?: string): string | null {
    if (!phone) {
      return null;
    }
    const digits = phone.replace(/\D/g, '');
    return digits.length > 0 ? digits : null;
  }

  private parseCreditLimit(value: string): Prisma.Decimal {
    const limit = money(value);
    if (isNegative(limit)) {
      throw new DomainException(
        DomainErrorCode.INVALID_AMOUNT,
        'El límite de crédito no puede ser negativo.',
      );
    }
    return limit;
  }
}
