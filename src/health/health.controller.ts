import { Controller, Get, HttpCode, HttpStatus, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { HealthResult, HealthService } from './health.service';

/**
 * Fuera del versionado de la API: Docker, Traefik y Dokploy consultan siempre `/health`,
 * y esa URL no debe cambiar cuando la API pase a v2.
 */
@ApiTags('health')
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Liveness: el proceso está vivo' })
  live(): { status: 'ok'; uptimeSeconds: number } {
    return this.health.liveness();
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness: la aplicación puede atender tráfico (incluye PostgreSQL)' })
  async ready(@Res({ passthrough: true }) response: Response): Promise<HealthResult> {
    const result = await this.health.readiness();
    // 503 cuando la base de datos no responde: así el balanceador deja de enviar tráfico.
    response.status(
      result.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE,
    );
    return result;
  }
}
