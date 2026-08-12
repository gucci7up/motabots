import { Injectable } from '@nestjs/common';
import { SettingType } from '@prisma/client';
import { Markup, Telegraf } from 'telegraf';
import { AuditQueryService } from '../../audit/audit-query.service';
import { thisWeek } from '../../common/date-range';
import { SettingKey, SettingKeyValue, SettingsService } from '../../settings/settings.service';
import { date } from '../formatters';
import { CALLBACK, navigationKeyboard } from '../keyboards/main-menu.keyboard';
import { escapeMarkdown } from '../messages';
import type { BotContext } from '../telegram.context';
import { BaseHandler, PAGE_SIZE } from './handler.base';

/** Etiquetas legibles de las acciones auditadas. */
const ACTION_LABELS: Record<string, string> = {
  login: '🔑 Inicio de sesión',
  'login.denied': '⛔ Acceso denegado',
  'sale.created': '🛒 Venta creada',
  'sale.cancelled': '❌ Venta cancelada',
  'payment.created': '💵 Pago registrado',
  'credit.created': '💳 Crédito creado',
  'credit.collected': '💰 Abono registrado',
  'inventory.adjusted': '📦 Inventario ajustado',
  'product.created': '🏷 Producto creado',
  'product.updated': '✏️ Producto modificado',
  'expense.created': '💸 Gasto registrado',
  'cash.opened': '🔓 Caja abierta',
  'cash.closed': '🔒 Caja cerrada',
  'invoice.cancelled': '🧾 Factura anulada',
  'user.created': '👤 Usuario creado',
  'user.updated': '👤 Usuario modificado',
  'user.deactivated': '👤 Usuario desactivado',
  'settings.updated': '⚙️ Configuración modificada',
};

@Injectable()
export class SettingsHandler extends BaseHandler {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditQueryService,
  ) {
    super();
  }

  register(bot: Telegraf<BotContext>): void {
    bot.action(CALLBACK.SETTINGS, async (ctx) => {
      await ctx.answerCbQuery();
      if (!(await this.ensure(ctx, 'settings.manage'))) {
        return;
      }
      await this.edit(ctx, await this.settingsText(), this.menuKeyboard());
    });

    bot.action('settings:toggle:negative', async (ctx) => {
      await ctx.answerCbQuery();
      if (!(await this.ensure(ctx, 'settings.manage'))) {
        return;
      }
      await this.toggle(ctx, SettingKey.ALLOW_NEGATIVE_STOCK);
    });

    bot.action('settings:toggle:credit', async (ctx) => {
      await ctx.answerCbQuery();
      if (!(await this.ensure(ctx, 'settings.manage'))) {
        return;
      }
      await this.toggle(ctx, SettingKey.CREDIT_ENABLED);
    });

    bot.action('settings:toggle:lowstock', async (ctx) => {
      await ctx.answerCbQuery();
      if (!(await this.ensure(ctx, 'settings.manage'))) {
        return;
      }
      await this.toggle(ctx, SettingKey.LOW_STOCK_ALERTS);
    });

    // ── Auditoría (sólo lectura) ─────────────────────────────
    bot.action(/^audit:list:(\d+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      if (!(await this.ensure(ctx, 'audit.read'))) {
        return;
      }
      await this.showAudit(ctx, Number(ctx.match[1]));
    });

    bot.action('audit:summary', async (ctx) => {
      await ctx.answerCbQuery();
      if (!(await this.ensure(ctx, 'audit.read'))) {
        return;
      }
      await this.showAuditSummary(ctx);
    });
  }

  private async toggle(ctx: BotContext, key: SettingKeyValue): Promise<void> {
    const current = await this.settings.getBoolean(key, false);
    await this.settings.set(key, !current, SettingType.BOOLEAN, ctx.user.id);
    await this.edit(ctx, await this.settingsText(), this.menuKeyboard());
  }

  private async settingsText(): Promise<string> {
    const [storeName, phone, address, currency, negativeStock, creditEnabled, dueDays, lowStock, summaryHour] =
      await Promise.all([
        this.settings.getString(SettingKey.STORE_NAME, 'MotaParfum'),
        this.settings.getString(SettingKey.STORE_PHONE, ''),
        this.settings.getString(SettingKey.STORE_ADDRESS, ''),
        this.settings.getString(SettingKey.CURRENCY_SYMBOL, 'RD$'),
        this.settings.getBoolean(SettingKey.ALLOW_NEGATIVE_STOCK, false),
        this.settings.getBoolean(SettingKey.CREDIT_ENABLED, true),
        this.settings.getNumber(SettingKey.CREDIT_DEFAULT_DUE_DAYS, 15),
        this.settings.getBoolean(SettingKey.LOW_STOCK_ALERTS, true),
        this.settings.getNumber(SettingKey.DAILY_SUMMARY_HOUR, 21),
      ]);

    const flag = (value: boolean): string => (value ? '✅ Sí' : '❌ No');

    return [
      '*⚙️ CONFIGURACIÓN*',
      '',
      `Tienda: ${escapeMarkdown(storeName)}`,
      phone ? `Teléfono: ${escapeMarkdown(phone)}` : 'Teléfono: _sin definir_',
      address ? `Dirección: ${escapeMarkdown(address)}` : 'Dirección: _sin definir_',
      `Moneda: ${escapeMarkdown(currency)}`,
      '',
      '*Reglas de negocio*',
      `Vender sin stock: ${flag(negativeStock)}`,
      `Ventas a crédito: ${flag(creditEnabled)}`,
      escapeMarkdown(`Días de crédito por defecto: ${dueDays}`),
      '',
      '*Alertas*',
      `Stock bajo: ${flag(lowStock)}`,
      escapeMarkdown(`Resumen diario: ${summaryHour}:00`),
    ].join('\n');
  }

  private menuKeyboard(): ReturnType<typeof Markup.inlineKeyboard> {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Vender sin stock', 'settings:toggle:negative')],
      [Markup.button.callback('🔄 Ventas a crédito', 'settings:toggle:credit')],
      [Markup.button.callback('🔄 Alertas de stock bajo', 'settings:toggle:lowstock')],
      [Markup.button.callback('🔍 Auditoría', 'audit:list:1')],
      [Markup.button.callback('🏠 Menú', CALLBACK.MENU)],
    ]);
  }

  private async showAudit(ctx: BotContext, page: number): Promise<void> {
    const result = await this.audit.find({}, page, PAGE_SIZE);

    if (result.data.length === 0) {
      await this.edit(ctx, 'No hay registros de auditoría\\.', navigationKeyboard(CALLBACK.SETTINGS));
      return;
    }

    const lines = result.data.map((log) => {
      const label = ACTION_LABELS[log.action] ?? log.action;
      const who = log.user
        ? (log.user.firstName ?? log.user.username ?? log.user.telegramUserId.toString())
        : 'sistema';

      return `${escapeMarkdown(label)}\n   ${date(log.createdAt)} · ${escapeMarkdown(who)}`;
    });

    const pagination = this.paginationRow('audit:list', page, result.meta.totalPages);

    await this.edit(
      ctx,
      [
        '*🔍 AUDITORÍA*',
        '',
        escapeMarkdown(`${result.meta.total} registro(s)`),
        '',
        ...lines,
      ].join('\n'),
      Markup.inlineKeyboard([
        ...(pagination.length > 0 ? [pagination] : []),
        [Markup.button.callback('📊 Resumen de la semana', 'audit:summary')],
        [Markup.button.callback('⬅️ Atrás', CALLBACK.SETTINGS)],
      ]),
    );
  }

  private async showAuditSummary(ctx: BotContext): Promise<void> {
    const range = thisWeek();
    const summary = await this.audit.summarize(range.from, range.to);

    const lines = summary.map((row) => {
      const label = ACTION_LABELS[row.action] ?? row.action;
      return `${escapeMarkdown(label)}: ${row.count}`;
    });

    await this.edit(
      ctx,
      [
        '*📊 ACTIVIDAD · ÚLTIMOS 7 DÍAS*',
        '',
        ...(lines.length > 0 ? lines : ['Sin actividad registrada\\.']),
      ].join('\n'),
      navigationKeyboard('audit:list:1'),
    );
  }
}
