import { Injectable } from '@nestjs/common';
import { Markup, Telegraf } from 'telegraf';
import { today } from '../../common/date-range';
import { ReportsService } from '../../reports/reports.service';
import { amount, percent } from '../formatters';
import { CALLBACK } from '../keyboards/main-menu.keyboard';
import { escapeMarkdown } from '../messages';
import type { BotContext } from '../telegram.context';
import { BaseHandler } from './handler.base';

@Injectable()
export class DashboardHandler extends BaseHandler {
  constructor(private readonly reports: ReportsService) {
    super();
  }

  register(bot: Telegraf<BotContext>): void {
    bot.action(CALLBACK.SUMMARY, async (ctx) => {
      await ctx.answerCbQuery();
      if (!(await this.ensure(ctx, 'sales.read'))) {
        return;
      }
      await this.edit(ctx, await this.render(), this.keyboard());
    });

    bot.action('summary:refresh', async (ctx) => {
      await ctx.answerCbQuery('Actualizado');
      await this.edit(ctx, await this.render(), this.keyboard());
    });
  }

  private keyboard(): ReturnType<typeof Markup.inlineKeyboard> {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Actualizar', 'summary:refresh')],
      [Markup.button.callback('📈 Reportes', CALLBACK.REPORTS)],
      [Markup.button.callback('🏠 Menú', CALLBACK.MENU)],
    ]);
  }

  private async render(): Promise<string> {
    const range = today();
    const data = await this.reports.getDashboard(range);

    const lines = [
      '*📊 RESUMEN DE HOY*',
      '',
      `Ventas: *${data.sales.salesCount}*`,
      `Facturado: ${amount(data.sales.netSales)}`,
      `Cobrado: ${amount(data.sales.collected)}`,
    ];

    if (data.sales.onCredit.greaterThan(0)) {
      lines.push(`A crédito: ${amount(data.sales.onCredit)}`);
    }

    lines.push(
      '',
      `Costo: ${amount(data.sales.costOfGoodsSold)}`,
      `Ganancia bruta: *${amount(data.sales.profit)}*`,
      `Gastos: ${amount(data.expenses)}`,
      `*Ganancia neta: ${amount(data.netProfit)}*`,
    );

    if (data.sales.salesCount > 0) {
      const margin = data.sales.netSales.isZero()
        ? 0
        : Number(data.sales.profit.dividedBy(data.sales.netSales).times(100));
      lines.push(`Margen: ${percent(margin)}`);
      lines.push(`Ticket promedio: ${amount(data.sales.averageTicket)}`);
    }

    lines.push(
      '',
      '*SITUACIÓN*',
      `Por cobrar: ${amount(data.position.accountsReceivable)}`,
    );

    if (data.position.overdueReceivable.greaterThan(0)) {
      lines.push(`🔴 Vencido: ${amount(data.position.overdueReceivable)}`);
    }

    lines.push(
      `Inventario: ${amount(data.position.inventoryValue)}`,
      `Efectivo en caja: ${amount(data.position.cashOnHand)}`,
    );

    if (data.lowStockCount > 0) {
      lines.push('', escapeMarkdown(`⚠️ ${data.lowStockCount} productos con stock bajo`));
    }

    return lines.join('\n');
  }
}
