import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { timingSafeEqual } from 'node:crypto';
import type { Update } from 'telegraf/types';
import { AppConfigService } from '../config/app-config.service';
import { TelegramService } from './telegram.service';

/**
 * Webhook de Telegram. Excluido de Swagger: no es una API pública, es un endpoint de
 * integración que sólo Telegram debe invocar.
 */
@ApiExcludeController()
@Controller({ path: 'telegram', version: '1' })
export class TelegramController {
  private readonly logger = new Logger(TelegramController.name);

  constructor(
    private readonly telegram: TelegramService,
    private readonly config: AppConfigService,
  ) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async webhook(
    @Body() update: Update,
    @Headers('x-telegram-bot-api-secret-token') secretToken?: string,
  ): Promise<{ ok: true }> {
    if (!this.isAuthentic(secretToken)) {
      this.logger.warn('Petición al webhook con secret token inválido; descartada');
      // Se responde 200 a propósito: un 401 le confirmaría a quien sondea que el endpoint existe.
      return { ok: true };
    }

    try {
      await this.telegram.handleUpdate(update);
    } catch (error) {
      // Siempre 200: un error aquí haría que Telegram reintente el update indefinidamente.
      // La idempotencia ya evita duplicados, y el fallo queda registrado.
      this.logger.error({ err: error }, 'Fallo procesando un update de Telegram');
    }

    return { ok: true };
  }

  private isAuthentic(received?: string): boolean {
    const expected = this.config.telegram.webhookSecret;

    if (!expected) {
      this.logger.error('TELEGRAM_WEBHOOK_SECRET no configurado: se rechaza todo el tráfico');
      return false;
    }

    if (!received) {
      return false;
    }

    const a = Buffer.from(received);
    const b = Buffer.from(expected);
    // Comparación en tiempo constante: comparar con === filtra el secreto por temporización.
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
