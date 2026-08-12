import { Injectable } from '@nestjs/common';
import { PaymentMethod, Prisma } from '@prisma/client';
import { Markup, Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { money } from '../../common/money';
import { CreditsService } from '../../credits/credits.service';
import { CustomersService } from '../../customers/customers.service';
import { amount, date, daysOverdue } from '../formatters';
import { CALLBACK, navigationKeyboard } from '../keyboards/main-menu.keyboard';
import { escapeMarkdown } from '../messages';
import { SessionStore } from '../session/session.store';
import type { BotContext } from '../telegram.context';
import { BaseHandler, PAGE_SIZE } from './handler.base';

const METHOD_LABELS: Record<string, string> = {
  CASH: '💵 Efectivo',
  BANK_TRANSFER: '🏦 Transferencia',
  CARD: '💳 Tarjeta',
  MOBILE_PAYMENT: '📱 Pago móvil',
  OTHER: '➖ Otro',
};

@Injectable()
export class CreditsHandler extends BaseHandler {
  constructor(
    private readonly sessions: SessionStore,
    private readonly credits: CreditsService,
    private readonly customers: CustomersService,
  ) {
    super();
  }

  register(bot: Telegraf<BotContext>): void {
    bot.action(CALLBACK.CREDITS, async (ctx) => {
      await ctx.answerCbQuery();
      if (!(await this.ensure(ctx, 'credits.read'))) {
        return;
      }
      await this.edit(ctx, await this.summaryText(), this.menuKeyboard());
    });

    bot.command('creditos', async (ctx) => {
      await this.reply(ctx, await this.summaryText(), this.menuKeyboard());
    });

    bot.action(/^credits:list:(\d+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      await this.showDebtors(ctx, Number(ctx.match[1]), false);
    });

    bot.action(/^credits:overdue:(\d+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      await this.showDebtors(ctx, Number(ctx.match[1]), true);
    });

    bot.action(/^credits:cust:(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      await this.showCustomerCredits(ctx, ctx.match[1]);
    });

    bot.action(/^credits:acc:(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      await this.showCredit(ctx, ctx.match[1]);
    });

    bot.action(/^credits:pay:(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      if (!(await this.ensure(ctx, 'credits.collect'))) {
        return;
      }

      const credit = await this.credits.findById(ctx.match[1]);
      this.sessions.update(ctx.user.id, {
        step: 'credit:amount',
        targetId: credit.id,
        targetLabel: credit.customer.name,
      });

      await this.edit(
        ctx,
        [
          '*💵 REGISTRAR ABONO*',
          '',
          `Cliente: ${escapeMarkdown(credit.customer.name)}`,
          `Saldo: *${amount(credit.balance)}*`,
          '',
          'Escribe el monto del abono\\.',
        ].join('\n'),
        Markup.inlineKeyboard([
          [Markup.button.callback('💰 Pagar todo el saldo', `credits:payall:${credit.id}`)],
          [Markup.button.callback('⬅️ Atrás', `credits:acc:${credit.id}`)],
        ]),
      );
    });

    bot.action(/^credits:payall:(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const credit = await this.credits.findById(ctx.match[1]);
      this.sessions.update(ctx.user.id, {
        step: 'idle',
        targetId: credit.id,
        expenseAmount: credit.balance.toString(),
      });
      await this.askMethod(ctx, credit.balance);
    });

    bot.action(/^credits:method:(.+)$/, async (ctx) => {
      await ctx.answerCbQuery('Registrando…');
      await this.registerInstallment(ctx, ctx.match[1] as PaymentMethod);
    });

    bot.on(message('text'), async (ctx, next) => {
      const session = this.sessions.get(ctx.user.id);
      if (session.step !== 'credit:amount') {
        return next();
      }

      let value: Prisma.Decimal;
      try {
        value = money(ctx.message.text.replace(',', '.').trim());
      } catch {
        await this.reply(ctx, 'Monto inválido\\. Escribe un número\\.');
        return;
      }

      if (!value.greaterThan(0)) {
        await this.reply(ctx, 'El abono debe ser mayor que cero\\.');
        return;
      }

      this.sessions.update(ctx.user.id, { expenseAmount: value.toString(), step: 'idle' });
      await this.askMethod(ctx, value, true);
    });
  }

  private async askMethod(
    ctx: BotContext,
    value: Prisma.Decimal,
    asReply = false,
  ): Promise<void> {
    const text = ['*💵 ABONO*', '', `Monto: *${amount(value)}*`, '', '¿Cómo te pagó?'].join('\n');

    const keyboard = Markup.inlineKeyboard([
      ...Object.entries(METHOD_LABELS).map(([method, label]) => [
        Markup.button.callback(label, `credits:method:${method}`),
      ]),
      [Markup.button.callback('❌ Cancelar', CALLBACK.CREDITS)],
    ]);

    if (asReply) {
      await this.reply(ctx, text, keyboard);
    } else {
      await this.edit(ctx, text, keyboard);
    }
  }

  private async registerInstallment(ctx: BotContext, method: PaymentMethod): Promise<void> {
    const session = this.sessions.get(ctx.user.id);

    if (!session.targetId || !session.expenseAmount) {
      await this.edit(ctx, 'Se perdió el abono en curso\\. Empieza de nuevo\\.', navigationKeyboard());
      return;
    }

    const result = await this.credits.registerInstallment({
      creditAccountId: session.targetId,
      amount: session.expenseAmount,
      method,
      userId: ctx.user.id,
    });

    this.sessions.clear(ctx.user.id);

    const lines = [
      '*✅ ABONO REGISTRADO*',
      '',
      `Monto: ${amount(result.payment.amount)}`,
      `Nuevo saldo: *${amount(result.credit.balance)}*`,
    ];

    if (result.fullyPaid) {
      lines.push('', '🎉 *Crédito saldado por completo*');
    }

    await this.edit(
      ctx,
      lines.join('\n'),
      Markup.inlineKeyboard([
        [Markup.button.callback('💳 Ver créditos', CALLBACK.CREDITS)],
        [Markup.button.callback('🏠 Menú', CALLBACK.MENU)],
      ]),
    );
  }

  private async summaryText(): Promise<string> {
    const summary = await this.credits.getSummary();

    const lines = [
      '*💳 CUENTAS POR COBRAR*',
      '',
      `Total pendiente: *${amount(summary.totalPending)}*`,
      `Créditos abiertos: ${summary.openCount}`,
    ];

    if (summary.overdueCount > 0) {
      lines.push(
        '',
        `🔴 Vencido: *${amount(summary.totalOverdue)}*`,
        `Créditos vencidos: ${summary.overdueCount}`,
      );
    }

    return lines.join('\n');
  }

  private menuKeyboard(): ReturnType<typeof Markup.inlineKeyboard> {
    return Markup.inlineKeyboard([
      [Markup.button.callback('👥 Clientes con deuda', 'credits:list:1')],
      [Markup.button.callback('🔴 Solo vencidos', 'credits:overdue:1')],
      [Markup.button.callback('🏠 Menú', CALLBACK.MENU)],
    ]);
  }

  private async showDebtors(ctx: BotContext, page: number, onlyOverdue: boolean): Promise<void> {
    const result = await this.customers.findWithDebt(page, PAGE_SIZE, onlyOverdue);

    if (result.data.length === 0) {
      await this.edit(
        ctx,
        onlyOverdue ? '✅ No hay créditos vencidos\\.' : '✅ Nadie tiene deuda pendiente\\.',
        navigationKeyboard(CALLBACK.CREDITS),
      );
      return;
    }

    const rows = result.data.map((row) => [
      Markup.button.callback(
        `${row.overdue ? '🔴' : '•'} ${row.customer.name} · ${row.balance.toFixed(0)}`,
        `credits:cust:${row.customer.id}`,
      ),
    ]);

    const prefix = onlyOverdue ? 'credits:overdue' : 'credits:list';
    const pagination = this.paginationRow(prefix, page, result.meta.totalPages);

    await this.edit(
      ctx,
      [
        onlyOverdue ? '*🔴 CLIENTES CON DEUDA VENCIDA*' : '*👥 CLIENTES CON DEUDA*',
        '',
        `${result.meta.total} cliente\\(s\\)`,
      ].join('\n'),
      Markup.inlineKeyboard([
        ...rows,
        ...(pagination.length > 0 ? [pagination] : []),
        [Markup.button.callback('⬅️ Atrás', CALLBACK.CREDITS)],
      ]),
    );
  }

  private async showCustomerCredits(ctx: BotContext, customerId: string): Promise<void> {
    const [customer, credits, balance] = await Promise.all([
      this.customers.findById(customerId),
      this.credits.findByCustomer(customerId),
      this.customers.getBalance(customerId),
    ]);

    if (credits.length === 0) {
      await this.edit(
        ctx,
        `${escapeMarkdown(customer.name)} no tiene créditos abiertos\\.`,
        navigationKeyboard('credits:list:1'),
      );
      return;
    }

    const rows = credits.map((credit) => {
      const overdue = daysOverdue(credit.dueDate);
      const flag = overdue > 0 ? `🔴 ${overdue}d` : '•';
      return [
        Markup.button.callback(
          `${flag} ${credit.balance.toFixed(0)} · vence ${credit.dueDate.toLocaleDateString('es-DO')}`,
          `credits:acc:${credit.id}`,
        ),
      ];
    });

    await this.edit(
      ctx,
      [
        `*${escapeMarkdown(customer.name.toUpperCase())}*`,
        '',
        `Saldo total: *${amount(balance.balance)}*`,
        balance.overdueBalance.greaterThan(0)
          ? `🔴 Vencido: ${amount(balance.overdueBalance)}`
          : '',
        '',
        'Elige un crédito:',
      ]
        .filter(Boolean)
        .join('\n'),
      Markup.inlineKeyboard([...rows, [Markup.button.callback('⬅️ Atrás', 'credits:list:1')]]),
    );
  }

  private async showCredit(ctx: BotContext, creditId: string): Promise<void> {
    const credit = await this.credits.findById(creditId);
    const overdue = daysOverdue(credit.dueDate);

    const lines = [
      '*💳 CRÉDITO*',
      '',
      `Cliente: ${escapeMarkdown(credit.customer.name)}`,
      `Venta: \`${escapeMarkdown(credit.sale.saleNumber)}\``,
      '',
      `Original: ${amount(credit.originalAmount)}`,
      `Abonado: ${amount(credit.paidAmount)}`,
      `*Saldo: ${amount(credit.balance)}*`,
      '',
      `Vencimiento: ${date(credit.dueDate)}`,
    ];

    if (overdue > 0 && credit.balance.greaterThan(0)) {
      lines.push(escapeMarkdown(`🔴 Vencido hace ${overdue} día(s)`));
    }

    const canCollect = credit.balance.greaterThan(0) && credit.status !== 'CANCELLED';

    await this.edit(
      ctx,
      lines.join('\n'),
      Markup.inlineKeyboard([
        ...(canCollect
          ? [[Markup.button.callback('💵 Registrar abono', `credits:pay:${credit.id}`)]]
          : []),
        [Markup.button.callback('⬅️ Atrás', `credits:cust:${credit.customerId}`)],
        [Markup.button.callback('🏠 Menú', CALLBACK.MENU)],
      ]),
    );
  }
}
