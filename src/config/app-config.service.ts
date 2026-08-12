import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './env.schema';

/**
 * Acceso tipado a la configuración validada. Ningún módulo lee `process.env` directamente.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  private get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true });
  }

  get nodeEnv(): Env['NODE_ENV'] {
    return this.get('NODE_ENV');
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }

  get isTest(): boolean {
    return this.nodeEnv === 'test';
  }

  get port(): number {
    return this.get('PORT');
  }

  get appUrl(): string | undefined {
    return this.get('APP_URL');
  }

  get timezone(): string {
    return this.get('TZ');
  }

  get databaseUrl(): string {
    return this.get('DATABASE_URL');
  }

  get logLevel(): Env['LOG_LEVEL'] {
    return this.get('LOG_LEVEL');
  }

  get logPretty(): boolean {
    return this.get('LOG_PRETTY');
  }

  get telegram(): {
    botToken: string | undefined;
    adminIds: bigint[];
    webhookSecret: string | undefined;
    mode: Env['TELEGRAM_MODE'];
  } {
    return {
      botToken: this.get('TELEGRAM_BOT_TOKEN'),
      adminIds: this.get('TELEGRAM_ADMIN_IDS'),
      webhookSecret: this.get('TELEGRAM_WEBHOOK_SECRET'),
      mode: this.get('TELEGRAM_MODE'),
    };
  }

  get storage(): { driver: Env['STORAGE_DRIVER']; localPath: string } {
    return {
      driver: this.get('STORAGE_DRIVER'),
      localPath: this.get('STORAGE_LOCAL_PATH'),
    };
  }

  get store(): {
    name: string;
    phone: string;
    address: string;
    currency: string;
    currencySymbol: string;
  } {
    return {
      name: this.get('STORE_NAME'),
      phone: this.get('STORE_PHONE'),
      address: this.get('STORE_ADDRESS'),
      currency: this.get('CURRENCY'),
      currencySymbol: this.get('CURRENCY_SYMBOL'),
    };
  }

  get redisUrl(): string | undefined {
    return this.get('REDIS_URL');
  }
}
