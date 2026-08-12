import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/** Cliente dentro de una transacción: no expone $transaction ni $connect. */
export type PrismaTransaction = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export interface TransactionOptions {
  isolationLevel?: Prisma.TransactionIsolationLevel;
  /** Milisegundos que la transacción puede esperar para iniciar. */
  maxWait?: number;
  /** Milisegundos máximos de duración de la transacción. */
  timeout?: number;
  /** Reintentos ante fallo de serialización o deadlock. */
  retries?: number;
}

/** Códigos de Prisma que indican un conflicto recuperable reintentando. */
const RETRIABLE_PRISMA_CODES = new Set([
  'P2034', // Transaction failed due to a write conflict or a deadlock
]);
/** Códigos SQLSTATE de PostgreSQL: serialization_failure y deadlock_detected. */
const RETRIABLE_PG_CODES = new Set(['40001', '40P01']);

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
      errorFormat: 'minimal',
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Conexión con PostgreSQL establecida');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Verificación real de conectividad usada por /health. */
  async healthCheck(): Promise<boolean> {
    await this.$queryRaw`SELECT 1`;
    return true;
  }

  /**
   * Ejecuta trabajo dentro de una transacción con nivel `Serializable` por defecto.
   *
   * `Serializable` es lo que impide que dos ventas simultáneas del último producto se
   * completen ambas. El precio es que PostgreSQL puede abortar una de las dos con un fallo
   * de serialización: por eso se reintenta automáticamente. El callback debe ser idempotente
   * respecto a efectos externos (no enviar mensajes de Telegram dentro de la transacción).
   */
  async transaction<T>(
    fn: (tx: PrismaTransaction) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    const {
      isolationLevel = Prisma.TransactionIsolationLevel.Serializable,
      maxWait = 5_000,
      timeout = 15_000,
      retries = 3,
    } = options;

    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.$transaction(fn, { isolationLevel, maxWait, timeout });
      } catch (error) {
        lastError = error;

        if (!isRetriable(error) || attempt === retries) {
          throw error;
        }

        // Espera con backoff exponencial y jitter para no re-colisionar de inmediato.
        const delay = 2 ** attempt * 25 + Math.floor(Math.random() * 25);
        this.logger.warn(
          { attempt: attempt + 1, retries, delay },
          'Conflicto de transacción; reintentando',
        );
        await sleep(delay);
      }
    }

    throw lastError;
  }
}

function isRetriable(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (RETRIABLE_PRISMA_CODES.has(error.code)) {
      return true;
    }
    const meta = error.meta as { code?: unknown } | undefined;
    if (typeof meta?.code === 'string' && RETRIABLE_PG_CODES.has(meta.code)) {
      return true;
    }
  }

  if (error instanceof Error) {
    return [...RETRIABLE_PG_CODES].some((code) => error.message.includes(code));
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
