import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

export type HealthStatus = 'ok' | 'degraded';

export interface HealthResult {
  status: HealthStatus;
  uptimeSeconds: number;
  timestamp: string;
  checks: {
    database: { status: 'up' | 'down'; latencyMs?: number };
  };
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: el proceso responde. No toca dependencias externas. */
  liveness(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  /** Readiness: verifica de verdad la conexión con PostgreSQL. */
  async readiness(): Promise<HealthResult> {
    const startedAt = Date.now();
    let databaseUp = false;
    let latencyMs: number | undefined;

    try {
      await this.prisma.healthCheck();
      databaseUp = true;
      latencyMs = Date.now() - startedAt;
    } catch (error) {
      this.logger.error({ err: error }, 'Health check de base de datos falló');
    }

    return {
      status: databaseUp ? 'ok' : 'degraded',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      checks: {
        database: databaseUp ? { status: 'up', latencyMs } : { status: 'down' },
      },
    };
  }
}
