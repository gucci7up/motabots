import { Injectable } from '@nestjs/common';
import { PaymentMethod, Prisma } from '@prisma/client';
import { Markup, Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { thisMonth, today } from '../../common/date-range';
import { money } from '../../common/money';
import { ExpensesService } from '../../expenses/expenses.service';
import { amount } from '../formatters';
import { CALLBACK, navigationKeyboard } from '../keyboards/main-menu.keyboard';
import { escapeMarkdown } from '../messages';
import { SessionStore } from '../session/session.store';
import type { BotContext } from '../telegram.context';
import { BaseHandler } from './handler.base';

const METHOD_LABELS: Record<string, string> = {
  CASH: '💵 Efectivo',
  BANK_TRANSFER: '🏦 Transferencia',
  CARD: '💳 Tarjeta',
  MOBILE_PAYMENT: '📱 Pago móvil',
  OTHER: '➖ Otro',
};

@Injectable()
export class ExpensesHandler extends BaseHandler {
  constructor(
    private readonly sessions: SessionStore,
    private readonly expenses: ExpensesService,
  ) {
    super();
  }

  register(bot: Telegraf<BotContext>): void {
    bot.action(CALLBACK.EXPENSES, async (ctx) => {
      await ctx.answerCbQuery();
      if (!(await this.ensure(ctx, 'expenses.create'))) {
        return;
      }
      await this.edit(ctx, await this.summaryText(), this.menuKeyboard());
    });

    bot.command('gastos', async (ctx) => {
      await this.reply(ctx, await this.summaryText(), this.menuKeyboard());
    });

    bot.action('expense:new', async (ctx) => {
      await ctx.answerCbQuery();
      if (!(await this.ensure(ctx, 'expenses.create'))) {
        return;
      }

      const categories = await this.expenses.findCategories();

      await this.edit(
        ctx,
        ['*💸 NUEVO GASTO*', '', '¿De qué es el gasto?'].join('\n'),
        Markup.inlineKeyboard([
          ...this.chunk(
            categories.map((category) =>
              Markup.button.callback(category.name, `expense:cat:${category.code}`),
            ),
            2,
          ),
          [Markup.button.callback('❌ Cancelar', CALLBACK.EXPENSES)],
        ]),
      );
    });

    bot.action(/^expense:cat:(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      this.sessions.update(ctx.user.id, {
        step: 'expense:amount',
        expenseCategoryCode: ctx.match[1],
      });

      await this.edit(
        ctx,
        ['*💸 NUEVO GASTO*', '', '¿Cuánto gastaste?'].join('\n'),
        Markup.inlineKeyboard([[Markup.button.callback('❌ Cancelar', CALLBACK.EXPENSES)]]),
      );
    });

    bot.action(/^expense:method:(.+)$/, async (ctx) => {
      await ctx.answerCbQuery('Registrando…');
      await this.save(ctx, ctx.match[1] as PaymentMethod);
    });

    bot.action('expense:list', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showList(ctx);
    });

    bot.on(message('text'), async (ctx, next) => {
      const session = this.sessions.get(ctx.user.id);

      if (session.step === 'expense:amount') {
        let value: Prisma.Decimal;
        try {
          value = money(ctx.message.text.replace(',', '.').trim());
        } catch {
          await this.reply(ctx, 'Monto inválido\\. Escribe un número\\.');
          return;
        }

        if (!value.greaterThan(0)) {
          await this.reply(ctx, 'El gasto debe ser mayor que cero\\.');
          return;
        }

        this.sessions.update(ctx.user.id, {
          expenseAmount: value.toString(),
          step: 'expense:description',
        });

        await this.reply(ctx, '¿En qué lo gastaste? Escribe una descripción\\.');
        return;
      }

      if (session.step === 'expense:description') {
        const description = ctx.message.text.trim();

        if (description.length < 2) {
          await this.reply(ctx, 'La descripción es muy corta\\.');
          return;
        }

        this.sessions.update(ctx.user.id, { targetLabel: description, step: 'idle' });

        await this.reply(
          ctx,
          ['*💸 GASTO*', '', '¿Cómo lo pagaste?'].join('\n'),
          Markup.inlineKeyboard([
            ...Object.entries(METHOD_LABELS).map(([method, label]) => [
              Markup.button.callback(label, `expense:method:${method}`),
            ]),
            [Markup.button.callback('❌ Cancelar', CALLBACK.EXPENSES)],
          ]),
        );
        return;
      }

      return next();
    });
  }

  private async save(ctx: BotContext, method: PaymentMethod): Promise<void> {
    const session = this.sessions.get(ctx.user.id);

    if (!session.expenseCategoryCode || !session.expenseAmount || !session.targetLabel) {
      await this.edit(ctx, 'Se perdió el gasto en curso\\. Empieza de nuevo\\.', navigationKeyboard());
      return;
    }

    const expense = await this.expenses.create({
      expenseCategoryCode: session.expenseCategoryCode,
      amount: session.expenseAmount,
      description: session.targetLabel,
      paymentMethod: method,
      userId: ctx.user.id,
    });

    this.sessions.clear(ctx.user.id);

    const lines = [
      '*✅ GASTO REGISTRADO*',
      '',
      `Categoría: ${escapeMarkdown(expense.category.name)}`,
      `Monto: ${amount(expense.amount)}`,
      `Concepto: ${escapeMarkdown(expense.description)}`,
    ];

    if (expense.cashSessionId) {
      lines.push('', '💰 Descontado de la caja abierta');
    } else if (method === PaymentMethod.CASH) {
      lines.push('', '⚠️ No hay caja abierta: no se descontó de caja');
    }

    await this.edit(
      ctx,
      lines.join('\n'),
      Markup.inlineKeyboard([
        [Markup.button.callback('💸 Otro gasto', 'expense:new')],
        [Markup.button.callback('🏠 Menú', CALLBACK.MENU)],
      ]),
    );
  }

  private async summaryText(): Promise<string> {
    const [dayTotals, monthTotals] = await Promise.all([
      this.expenses.getTotals(today()),
      this.expenses.getTotals(thisMonth()),
    ]);

    const lines = [
      '*💸 GASTOS*',
      '',
      `Hoy: *${amount(dayTotals.total)}*`,
      `Este mes: ${amount(monthTotals.total)}`,
    ];

    if (monthTotals.byCategory.length > 0) {
      lines.push('', '*Por categoría (mes)*');
      for (const category of monthTotals.byCategory.slice(0, 6)) {
        lines.push(`${escapeMarkdown(category.name)}: ${amount(category.total)}`);
      }
    }

    return lines.join('\n');
  }

  private async showList(ctx: BotContext): Promise<void> {
    const result = await this.expenses.findAll(1, 10, thisMonth());

    const lines = result.data.map(
      (expense) =>
        `• ${amount(expense.amount)} · ${escapeMarkdown(expense.category.name)}\n` +
        `   ${escapeMarkdown(expense.description)}`,
    );

    await this.edit(
      ctx,
      [
        '*📋 GASTOS DEL MES*',
        '',
        ...(lines.length > 0 ? lines : ['Sin gastos registrados este mes\\.']),
      ].join('\n'),
      navigationKeyboard(CALLBACK.EXPENSES),
    );
  }

  private menuKeyboard(): ReturnType<typeof Markup.inlineKeyboard> {
    return Markup.inlineKeyboard([
      [Markup.button.callback('➕ Registrar gasto', 'expense:new')],
      [Markup.button.callback('📋 Ver gastos del mes', 'expense:list')],
      [Markup.button.callback('🏠 Menú', CALLBACK.MENU)],
    ]);
  }

  private chunk<T>(items: T[], size: number): T[][] {
    const rows: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
      rows.push(items.slice(i, i + size));
    }
    return rows;
  }
}
