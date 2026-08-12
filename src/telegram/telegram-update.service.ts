import { Injectable, Logger } from '@nestjs/common';
import { Prisma, TelegramUpdateStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

/**
 * Idempotencia del webhook. Telegram reenvía un update si no recibe 200 a tiempo; sin este
 * control, un timeout de red durante una venta la duplicaría.
 *
 * El registro se inserta ANTES de procesar y la unicidad la garantiza la base, no la
 * aplicación: dos réplicas procesando el mismo update a la vez chocan en el índice único.
 */
@Injectable()
export class TelegramUpdateService {
  private readonly logger = new Logger(TelegramUpdateService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reserva el update. Devuelve `true` si es nuevo y debe procesarse, `false` si ya se
   * procesó antes y hay que descartarlo.
   */
  async claim(updateId: number): Promise<boolean> {
    try {
      await this.prisma.telegramUpdate.create({
        data: { updateId: BigInt(updateId), status: TelegramUpdateStatus.PROCESSED },
      });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        this.logger.debug({ updateId }, 'Update de Telegram duplicado; descartado');
        return false;
      }
      throw error;
    }
  }

  /** Marca el update como fallido, conservando el motivo para diagnóstico. */
  async markFailed(updateId: number, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await this.prisma.telegramUpdate.update({
        where: { updateId: BigInt(updateId) },
        data: { status: TelegramUpdateStatus.FAILED, error: message.slice(0, 500) },
      });
    } catch (updateError) {
      this.logger.warn({ err: updateError, updateId }, 'No se pudo marcar el update como fallido');
    }
  }

  /**
   * Purga registros antiguos. La retención sólo necesita cubrir la ventana de reintentos de
   * Telegram; 30 días es holgado. Se ejecuta explícitamente, nunca de forma automática.
   */
  async purgeOlderThan(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const result = await this.prisma.telegramUpdate.deleteMany({
      where: { processedAt: { lt: cutoff } },
    });
    return result.count;
  }
}
