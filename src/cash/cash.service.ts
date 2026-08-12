import { Injectable, Logger } from '@nestjs/common';
import {
  CashMovement,
  CashMovementType,
  CashSession,
  CashSessionStatus,
  MovementDirection,
  Prisma,
} from '@prisma/client';
import { AuditAction, AuditService } from '../audit/audit.service';
import { DomainErrorCode, DomainException } from '../common/exceptions/domain.exception';
import { isNegative, money } from '../common/money';
import { PrismaService, PrismaTransaction } from '../database/prisma.service';

/** Tipos de movimiento que entran dinero en la caja. */
const INBOUND = new Set<CashMovementType>([
  CashMovementType.OPENING,
  CashMovementType.SALE,
  CashMovementType.CREDIT_COLLECTION,
  CashMovementType.MANUAL_IN,
]);

export function cashDirectionOf(type: CashMovementType): MovementDirection {
  return INBOUND.has(type) ? MovementDirection.IN : MovementDirection.OUT;
}

export interface CashSessionSummary {
  session: CashSession;
  openingAmount: Prisma.Decimal;
  totalIn: Prisma.Decimal;
  totalOut: Prisma.Decimal;
  expectedCash: Prisma.Decimal;
  movementCount: number;
}

export interface RegisterCashMovementInput {
  type: CashMovementType;
  amount: Prisma.Decimal | string | number;
  description?: string;
  referenceType?: string;
  referenceId?: string;
  userId: string;
}

@Injectable()
export class CashService {
  private readonly logger = new Logger(CashService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Abre la caja. Sólo puede haber una sesión abierta a la vez: lo garantiza un índice
   * único parcial en la base, no sólo esta comprobación.
   */
  async open(openingAmount: string | Prisma.Decimal, userId: string): Promise<CashSession> {
    const amount = money(openingAmount);

    if (isNegative(amount)) {
      throw new DomainException(
        DomainErrorCode.INVALID_AMOUNT,
        'El efectivo inicial no puede ser negativo.',
      );
    }

    return this.prisma.transaction(async (tx) => {
      const open = await tx.cashSession.findFirst({ where: { status: CashSessionStatus.OPEN } });
      if (open) {
        throw new DomainException(
          DomainErrorCode.CASH_SESSION_ALREADY_OPEN,
          'Ya hay una caja abierta. Ciérrala antes de abrir otra.',
          { cashSessionId: open.id },
        );
      }

      const session = await tx.cashSession.create({
        data: { openedById: userId, openingAmount: amount, status: CashSessionStatus.OPEN },
      });

      await tx.cashMovement.create({
        data: {
          cashSessionId: session.id,
          type: CashMovementType.OPENING,
          direction: MovementDirection.IN,
          amount,
          description: 'Efectivo inicial',
          userId,
        },
      });

      await this.audit.recordIn(tx, {
        userId,
        action: AuditAction.CASH_OPENED,
        entity: 'CashSession',
        entityId: session.id,
        after: { openingAmount: amount },
      });

      this.logger.log({ sessionId: session.id }, 'Caja abierta');

      return session;
    });
  }

  /**
   * Cierra la caja comparando el efectivo contado con el esperado.
   * La diferencia se registra tal cual: cuadrar la caja borrando movimientos sería
   * falsear el histórico.
   */
  async close(
    actualCash: string | Prisma.Decimal,
    userId: string,
    notes?: string,
  ): Promise<{ session: CashSession; expectedCash: Prisma.Decimal; difference: Prisma.Decimal }> {
    const counted = money(actualCash);

    if (isNegative(counted)) {
      throw new DomainException(
        DomainErrorCode.INVALID_AMOUNT,
        'El efectivo contado no puede ser negativo.',
      );
    }

    return this.prisma.transaction(async (tx) => {
      const session = await tx.cashSession.findFirst({
        where: { status: CashSessionStatus.OPEN },
      });

      if (!session) {
        throw new DomainException(
          DomainErrorCode.CASH_SESSION_NOT_OPEN,
          'No hay ninguna caja abierta.',
        );
      }

      const expectedCash = await this.computeExpectedCash(tx, session.id);
      const difference = money(counted.minus(expectedCash));

      await tx.cashMovement.create({
        data: {
          cashSessionId: session.id,
          type: CashMovementType.CLOSING,
          direction: MovementDirection.OUT,
          amount: counted,
          description: 'Cierre de caja',
          userId,
        },
      });

      const closed = await tx.cashSession.update({
        where: { id: session.id },
        data: {
          status: CashSessionStatus.CLOSED,
          closedById: userId,
          closedAt: new Date(),
          expectedCash,
          actualCash: counted,
          difference,
          notes: notes?.trim() || null,
        },
      });

      await this.audit.recordIn(tx, {
        userId,
        action: AuditAction.CASH_CLOSED,
        entity: 'CashSession',
        entityId: session.id,
        after: { expectedCash, actualCash: counted, difference },
        metadata: { notes: notes ?? null },
      });

      this.logger.log(
        { sessionId: session.id, difference: difference.toString() },
        'Caja cerrada',
      );

      return { session: closed, expectedCash, difference };
    });
  }

  /** Sesión abierta actual, o null si la caja está cerrada. */
  async getOpenSession(tx?: PrismaTransaction): Promise<CashSession | null> {
    const client = tx ?? this.prisma;
    return client.cashSession.findFirst({ where: { status: CashSessionStatus.OPEN } });
  }

  /**
   * Registra un movimiento en la caja abierta. Si no hay caja abierta lanza error:
   * aceptar efectivo sin caja dejaría dinero sin registrar.
   */
  async registerMovement(input: RegisterCashMovementInput): Promise<CashMovement> {
    const amount = money(input.amount);

    if (!amount.greaterThan(0)) {
      throw new DomainException(
        DomainErrorCode.INVALID_AMOUNT,
        'El movimiento de caja debe ser mayor que cero.',
      );
    }

    return this.prisma.transaction(async (tx) => {
      const session = await this.getOpenSession(tx);
      if (!session) {
        throw new DomainException(
          DomainErrorCode.CASH_SESSION_NOT_OPEN,
          'No hay caja abierta: abre la caja antes de registrar movimientos de efectivo.',
        );
      }

      return this.addMovement(tx, session.id, input);
    });
  }

  /**
   * Añade un movimiento dentro de una transacción ya abierta. Lo usan la venta en efectivo,
   * el cobro de un crédito y el gasto pagado en efectivo.
   */
  async addMovement(
    tx: PrismaTransaction,
    cashSessionId: string,
    input: RegisterCashMovementInput,
  ): Promise<CashMovement> {
    return tx.cashMovement.create({
      data: {
        cashSessionId,
        type: input.type,
        direction: cashDirectionOf(input.type),
        amount: money(input.amount),
        description: input.description ?? null,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        userId: input.userId,
      },
    });
  }

  /** Resumen de la sesión: entradas, salidas y efectivo esperado. */
  async getSummary(sessionId?: string): Promise<CashSessionSummary> {
    const session = sessionId
      ? await this.prisma.cashSession.findUnique({ where: { id: sessionId } })
      : await this.getOpenSession();

    if (!session) {
      throw new DomainException(
        DomainErrorCode.CASH_SESSION_NOT_OPEN,
        'No hay ninguna caja abierta.',
      );
    }

    const movements = await this.prisma.cashMovement.findMany({
      where: { cashSessionId: session.id, type: { not: CashMovementType.CLOSING } },
    });

    let totalIn = money(0);
    let totalOut = money(0);

    for (const movement of movements) {
      if (movement.direction === MovementDirection.IN) {
        totalIn = money(totalIn.plus(movement.amount));
      } else {
        totalOut = money(totalOut.plus(movement.amount));
      }
    }

    return {
      session,
      openingAmount: money(session.openingAmount),
      totalIn,
      totalOut,
      expectedCash: money(totalIn.minus(totalOut)),
      movementCount: movements.length,
    };
  }

  async findMovements(sessionId: string): Promise<CashMovement[]> {
    return this.prisma.cashMovement.findMany({
      where: { cashSessionId: sessionId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Efectivo esperado = apertura + entradas − salidas, calculado desde los movimientos.
   * El movimiento de apertura ya está incluido como entrada, así que no se suma aparte.
   */
  private async computeExpectedCash(
    tx: PrismaTransaction,
    cashSessionId: string,
  ): Promise<Prisma.Decimal> {
    const movements = await tx.cashMovement.findMany({
      where: { cashSessionId, type: { not: CashMovementType.CLOSING } },
      select: { direction: true, amount: true },
    });

    let expected = money(0);
    for (const movement of movements) {
      expected =
        movement.direction === MovementDirection.IN
          ? money(expected.plus(movement.amount))
          : money(expected.minus(movement.amount));
    }

    return expected;
  }
}
