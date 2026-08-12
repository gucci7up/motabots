import { Injectable } from '@nestjs/common';
import { Markup, Telegraf } from 'telegraf';
import { DateRange, thisMonth, thisWeek, today, yesterday } from '../../common/date-range';
import { ReportsService } from '../../reports/reports.service';
import { amount, percent, qty } from '../formatters';
import { CALLBACK, navigationKeyboard } from '../keyboards/main-menu.keyboard';
import { escapeMarkdown } from '../messages';
import type { BotContext } from '../telegram.context';
import { BaseHandler } from './handler.base';

const RANGES: Record<string, () => DateRange> = {
  today: today,
  yesterday: yesterday,
  week: thisWeek,
  month: thisMonth,
};

@Injectable()
export class ReportsHandler extends BaseHandler {
  constructor(private readonly reports: ReportsService) {
    super();
  }

  register(bot: Telegraf<BotContext>): void {
    bot.action(CALLBACK.REPORTS, async (ctx) => {
      await ctx.answerCbQuery();
      if (!(await this.ensure(ctx, 'reports.read'))) {
        return;
      }
      await this.edit(ctx, this.menuText(), this.menuKeyboard());
    });

    bot.command('reportes', async (ctx) => {
      await this.reply(ctx, this.menuText(), this.menuKeyboard());
    });

    bot.action(/^reports:sales:(\w+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      await this.showSales(ctx, ctx.match[1]);
    });

    bot.action(/^reports:products:(\w+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      await this.showProducts(ctx, ctx.match[1]);
    });

    bot.action('reports:customers', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showCustomers(ctx);
    });

    bot.action('reports:financial', async (ctx) => {
      await ctx.answerCbQuery();
      if (!(await this.ensure(ctx, 'accounting.read'))) {
        return;
      }
      await this.showFinancial(ctx);
    });
  }

  private range(key: string): DateRange {
    const factory = RANGES[key] ?? today;
    return factory();
  }

  private async showSales(ctx: BotContext, rangeKey: string): Promise<void> {
    const range = this.range(rangeKey);
    const report = await this.reports.getSalesReport(range);

    const lines = [
      `*🛒 VENTAS · ${escapeMarkdown(report.range.label.toUpperCase())}*`,
      '',
      `Cantidad de ventas: *${report.salesCount}*`,
      `Ventas brutas: ${amount(report.grossSales)}`,
    ];

    if (report.discounts.greaterThan(0)) {
      lines.push(`Descuentos: ${amount(report.discounts)}`);
    }

    lines.push(
      `Ventas netas: *${amount(report.netSales)}*`,
      '',
      `Cobrado: ${amount(report.collected)}`,
      `A crédito: ${amount(report.onCredit)}`,
      '',
      `Costo: ${amount(report.costOfGoodsSold)}`,
      `*Ganancia: ${amount(report.profit)}*`,
    );

    if (report.salesCount > 0) {
      lines.push(`Ticket promedio: ${amount(report.averageTicket)}`);
    }

    await this.edit(
      ctx,
      lines.join('\n'),
      Markup.inlineKeyboard([
        [
          Markup.button.callback('Hoy', 'reports:sales:today'),
          Markup.button.callback('Ayer', 'reports:sales:yesterday'),
        ],
        [
          Markup.button.callback('7 días', 'reports:sales:week'),
          Markup.button.callback('Mes', 'reports:sales:month'),
        ],
        [Markup.button.callback('⬅️ Atrás', CALLBACK.REPORTS)],
      ]),
    );
  }

  private async showProducts(ctx: BotContext, rangeKey: string): Promise<void> {
    const range = this.range(rangeKey);
    const [topSelling, topProfit] = await Promise.all([
      this.reports.getProductSales(range, 'units', 5),
      this.reports.getProductSales(range, 'profit', 5),
    ]);

    const lines = [`*📦 PRODUCTOS · ${escapeMarkdown(range.label.toUpperCase())}*`, ''];

    if (topSelling.length === 0) {
      lines.push('No hubo ventas en este período\\.');
    } else {
      lines.push('*Más vendidos*');
      topSelling.forEach((row, index) => {
        lines.push(
          `${index + 1}\\. ${escapeMarkdown(row.description)}\n` +
            `    ${qty(row.unitsSold)} uds · ${amount(row.revenue)}`,
        );
      });

      lines.push('', '*Mayor ganancia*');
      topProfit.forEach((row, index) => {
        lines.push(
          `${index + 1}\\. ${escapeMarkdown(row.description)}\n` +
            `    ${amount(row.profit)} · margen ${percent(row.marginPercent)}`,
        );
      });
    }

    await this.edit(
      ctx,
      lines.join('\n'),
      Markup.inlineKeyboard([
        [
          Markup.button.callback('Hoy', 'reports:products:today'),
          Markup.button.callback('7 días', 'reports:products:week'),
          Markup.button.callback('Mes', 'reports:products:month'),
        ],
        [Markup.button.callback('⬅️ Atrás', CALLBACK.REPORTS)],
      ]),
    );
  }

  private async showCustomers(ctx: BotContext): Promise<void> {
    const range = thisMonth();
    const top = await this.reports.getTopCustomers(range, 10);

    const lines = ['*👥 MEJORES CLIENTES · ESTE MES*', ''];

    if (top.length === 0) {
      lines.push('No hubo ventas con cliente este mes\\.');
    } else {
      top.forEach((row, index) => {
        lines.push(
          `${index + 1}\\. ${escapeMarkdown(row.name)}\n` +
            `    ${amount(row.total)} · ${row.salesCount} compra\\(s\\)`,
        );
      });
    }

    await this.edit(ctx, lines.join('\n'), navigationKeyboard(CALLBACK.REPORTS));
  }

  private async showFinancial(ctx: BotContext): Promise<void> {
    const range = thisMonth();
    const report = await this.reports.getFinancialReport(range);
    const pnl = report.profitAndLoss;

    const lines = [
      '*📈 ESTADO FINANCIERO · ESTE MES*',
      '',
      `Ingresos: *${amount(pnl.revenue)}*`,
      `Costo de ventas: ${amount(pnl.costOfGoodsSold)}`,
      `*Utilidad bruta: ${amount(pnl.grossProfit)}*`,
      `Margen: ${percent(pnl.grossMarginPercent)}`,
      '',
      `Gastos: ${amount(pnl.expenses)}`,
      `*Utilidad neta: ${amount(pnl.netProfit)}*`,
      '',
      '*SITUACIÓN ACTUAL*',
      `Por cobrar: ${amount(report.position.accountsReceivable)}`,
    ];

    if (report.position.overdueReceivable.greaterThan(0)) {
      lines.push(`🔴 Vencido: ${amount(report.position.overdueReceivable)}`);
    }

    lines.push(
      `Inventario: ${amount(report.position.inventoryValue)}`,
      `Efectivo: ${amount(report.position.cashOnHand)}`,
    );

    if (report.expensesByCategory.length > 0) {
      lines.push('', '*Gastos por categoría*');
      for (const category of report.expensesByCategory.slice(0, 5)) {
        lines.push(`${escapeMarkdown(category.name)}: ${amount(category.total)}`);
      }
    }

    await this.edit(ctx, lines.join('\n'), navigationKeyboard(CALLBACK.REPORTS));
  }

  private menuText(): string {
    return ['*📈 REPORTES*', '', '¿Qué quieres ver?'].join('\n');
  }

  private menuKeyboard(): ReturnType<typeof Markup.inlineKeyboard> {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🛒 Ventas', 'reports:sales:today')],
      [Markup.button.callback('📦 Productos', 'reports:products:month')],
      [Markup.button.callback('👥 Mejores clientes', 'reports:customers')],
      [Markup.button.callback('📈 Estado financiero', 'reports:financial')],
      [Markup.button.callback('🏠 Menú', CALLBACK.MENU)],
    ]);
  }
}
