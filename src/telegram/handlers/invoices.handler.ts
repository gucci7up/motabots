import { Injectable } from '@nestjs/common';
import { Markup, Telegraf } from 'telegraf';
import { InvoicesService } from '../../invoices/invoices.service';
import { amount, date } from '../formatters';
import { CALLBACK, navigationKeyboard } from '../keyboards/main-menu.keyboard';
import { escapeMarkdown } from '../messages';
import type { BotContext } from '../telegram.context';
import { BaseHandler, PAGE_SIZE } from './handler.base';

@Injectable()
export class InvoicesHandler extends BaseHandler {
  constructor(private readonly invoices: InvoicesService) {
    super();
  }

  register(bot: Telegraf<BotContext>): void {
    bot.action(CALLBACK.INVOICES, async (ctx) => {
      await ctx.answerCbQuery();
      if (!(await this.ensure(ctx, 'invoices.read'))) {
        return;
      }
      await this.showList(ctx, 1);
    });

    bot.command('facturas', async (ctx) => {
      await this.reply(ctx, '*🧾 FACTURAS*', this.listKeyboard());
    });

    bot.action(/^invoice:list:(\d+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      await this.showList(ctx, Number(ctx.match[1]));
    });

    bot.action(/^invoice:view:(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      await this.showInvoice(ctx, ctx.match[1]);
    });

    bot.action(/^invoice:pdf:(.+)$/, async (ctx) => {
      const invoiceId = ctx.match[1];

      if (!invoiceId) {
        await ctx.answerCbQuery('No hay factura asociada', { show_alert: true });
        return;
      }
      if (!(await this.ensure(ctx, 'invoices.read'))) {
        return;
      }

      await ctx.answerCbQuery('Generando PDF…');

      const { buffer, filename } = await this.invoices.getPdf(invoiceId, true);

      await ctx.replyWithDocument({ source: buffer, filename });
    });
  }

  private async showList(ctx: BotContext, page: number): Promise<void> {
    const result = await this.invoices.findAll(page, PAGE_SIZE);

    if (result.data.length === 0) {
      await this.edit(ctx, 'Todavía no hay facturas emitidas\\.', navigationKeyboard());
      return;
    }

    const rows = result.data.map((invoice) => [
      Markup.button.callback(
        `${invoice.number} · ${invoice.total.toFixed(0)}${invoice.status === 'CANCELLED' ? ' ❌' : ''}`,
        `invoice:view:${invoice.id}`,
      ),
    ]);

    const pagination = this.paginationRow('invoice:list', page, result.meta.totalPages);

    await this.edit(
      ctx,
      ['*🧾 FACTURAS*', '', escapeMarkdown(`${result.meta.total} factura(s)`)].join('\n'),
      Markup.inlineKeyboard([
        ...rows,
        ...(pagination.length > 0 ? [pagination] : []),
        [Markup.button.callback('🏠 Menú', CALLBACK.MENU)],
      ]),
    );
  }

  private async showInvoice(ctx: BotContext, invoiceId: string): Promise<void> {
    const invoice = await this.invoices.findById(invoiceId);

    const lines = [
      `*🧾 ${escapeMarkdown(invoice.number)}*`,
      '',
      `Fecha: ${date(invoice.issueDate)}`,
      `Cliente: ${escapeMarkdown(invoice.customer?.name ?? 'Consumidor final')}`,
      '',
      `Total: *${amount(invoice.total)}*`,
      `Pagado: ${amount(invoice.paidAmount)}`,
    ];

    if (invoice.pendingAmount.greaterThan(0)) {
      lines.push(`*Saldo pendiente: ${amount(invoice.pendingAmount)}*`);
    }

    if (invoice.status === 'CANCELLED') {
      lines.push('', '❌ *FACTURA ANULADA*');
      if (invoice.cancellationReason) {
        lines.push(escapeMarkdown(invoice.cancellationReason));
      }
    }

    await this.edit(
      ctx,
      lines.join('\n'),
      Markup.inlineKeyboard([
        [Markup.button.callback('📄 Enviar PDF', `invoice:pdf:${invoice.id}`)],
        [Markup.button.callback('⬅️ Atrás', 'invoice:list:1')],
        [Markup.button.callback('🏠 Menú', CALLBACK.MENU)],
      ]),
    );
  }

  private listKeyboard(): ReturnType<typeof Markup.inlineKeyboard> {
    return Markup.inlineKeyboard([
      [Markup.button.callback('📋 Ver facturas', 'invoice:list:1')],
      [Markup.button.callback('🏠 Menú', CALLBACK.MENU)],
    ]);
  }
}
