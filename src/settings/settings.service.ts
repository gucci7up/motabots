import { Injectable, Logger } from '@nestjs/common';
import { Prisma, SettingType } from '@prisma/client';
import { AuditAction, AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';

/** Claves de configuración usadas por la lógica de negocio. */
export const SettingKey = {
  STORE_NAME: 'store.name',
  STORE_PHONE: 'store.phone',
  STORE_ADDRESS: 'store.address',
  STORE_LOGO: 'store.logoStorageKey',
  CURRENCY: 'currency',
  CURRENCY_SYMBOL: 'currencySymbol',
  INVOICE_PREFIX: 'invoice.prefix',
  INVOICE_FORMAT: 'invoice.format',
  TAX_ENABLED: 'tax.enabled',
  TAX_RATE: 'tax.rate',
  TAX_INCLUDED: 'tax.included',
  CARD_SURCHARGE_PERCENT: 'payments.cardSurchargePercent',
  ALLOW_NEGATIVE_STOCK: 'inventory.allowNegativeStock',
  CREDIT_ENABLED: 'credit.enabled',
  CREDIT_DEFAULT_DUE_DAYS: 'credit.defaultDueDays',
  LOW_STOCK_ALERTS: 'alerts.lowStock.enabled',
  DAILY_SUMMARY_HOUR: 'alerts.dailySummary.hour',
} as const;

export type SettingKeyValue = (typeof SettingKey)[keyof typeof SettingKey];

const CACHE_TTL_MS = 30_000;

/**
 * Configuración de negocio, almacenada en base para poder cambiarla desde Telegram sin
 * redesplegar. Se cachea unos segundos: se lee en cada venta y no cambia casi nunca.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private cache = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get<T>(key: SettingKeyValue, fallback: T): Promise<T> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value as T;
    }

    const setting = await this.prisma.setting.findUnique({ where: { key } });
    if (!setting) {
      return fallback;
    }

    this.cache.set(key, { value: setting.value, expiresAt: Date.now() + CACHE_TTL_MS });
    return setting.value as T;
  }

  async getBoolean(key: SettingKeyValue, fallback = false): Promise<boolean> {
    const value = await this.get<unknown>(key, fallback);
    return typeof value === 'boolean' ? value : fallback;
  }

  async getNumber(key: SettingKeyValue, fallback = 0): Promise<number> {
    const value = await this.get<unknown>(key, fallback);
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  async getString(key: SettingKeyValue, fallback = ''): Promise<string> {
    const value = await this.get<unknown>(key, fallback);
    return typeof value === 'string' ? value : fallback;
  }

  async set(
    key: SettingKeyValue,
    value: Prisma.InputJsonValue,
    type: SettingType,
    actorId: string | null,
  ): Promise<void> {
    const before = await this.prisma.setting.findUnique({ where: { key } });

    await this.prisma.setting.upsert({
      where: { key },
      update: { value, type, updatedById: actorId },
      create: { key, value, type, updatedById: actorId },
    });

    this.cache.delete(key);

    await this.audit.record({
      userId: actorId,
      action: AuditAction.SETTINGS_UPDATED,
      entity: 'Setting',
      entityId: key,
      before: before?.value ?? null,
      after: value,
    });

    this.logger.log(`Configuración actualizada: ${key}`);
  }

  /** Invalida la caché. Necesario en tests y tras un cambio masivo de configuración. */
  clearCache(): void {
    this.cache.clear();
  }
}
