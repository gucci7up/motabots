import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainErrorCode, DomainException } from '../common/exceptions/domain.exception';
import { PrismaTransaction } from '../database/prisma.service';

export const DEFAULT_SERIES = 'DEFAULT';

interface SequenceRow {
  id: string;
  prefix: string;
  format: string;
  nextNumber: number;
  padding: number;
}

/**
 * Numeración consecutiva de facturas.
 *
 * El consecutivo se toma con la fila de la secuencia bloqueada (FOR UPDATE) dentro de la
 * misma transacción que crea la venta: dos ventas simultáneas no pueden obtener el mismo
 * número, y si la venta hace rollback el número no se consume.
 */
@Injectable()
export class InvoiceNumberService {
  async next(tx: PrismaTransaction, series = DEFAULT_SERIES): Promise<string> {
    const rows = await tx.$queryRaw<SequenceRow[]>`
      SELECT id, prefix, format, "nextNumber", padding
      FROM invoice_sequences
      WHERE series = ${series} AND "isActive" = true
      FOR UPDATE
    `;

    const sequence = rows[0];
    if (!sequence) {
      throw new DomainException(
        DomainErrorCode.CONFLICT,
        'No hay una secuencia de facturas configurada. Ejecuta el seed.',
        { series },
      );
    }

    const number = this.format(sequence, new Date());

    await tx.invoiceSequence.update({
      where: { id: sequence.id },
      data: { nextNumber: sequence.nextNumber + 1 },
    });

    return number;
  }

  /**
   * Construye el número a partir de la plantilla configurada.
   * Marcadores: {PREFIX}, {YYYY}, {YY}, {MM}, {SEQ}.
   */
  format(sequence: Omit<SequenceRow, 'id'>, date: Date): string {
    const year = date.getFullYear();
    const padded = String(sequence.nextNumber).padStart(sequence.padding, '0');

    return sequence.format
      .replace('{PREFIX}', sequence.prefix)
      .replace('{YYYY}', String(year))
      .replace('{YY}', String(year).slice(-2))
      .replace('{MM}', String(date.getMonth() + 1).padStart(2, '0'))
      .replace('{SEQ}', padded);
  }

  /**
   * Número de venta interno, independiente del de factura. Usa su propia serie con el
   * mismo bloqueo: contar filas de `sales` sería propenso a colisiones bajo concurrencia.
   */
  nextSaleNumber(tx: PrismaTransaction): Promise<string> {
    return this.next(tx, SALE_SERIES);
  }
}

export const SALE_SERIES = 'SALE';

export type { Prisma };
