import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Markup, Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { isNegative, money } from '../../common/money';
import { CashService } from '../../cash/cash.service';
import { amount, date } from '../formatters';
import { CALLBACK, navigationKeyboard } from '../keyboards/main-menu.keyboard';
import { escapeMarkdown } from '../messages';
import { SessionStore } from '../session/session.store';
import type { BotContext } from '../telegram.context';
import { BaseHandler } from './handler.base';

@Injectable()
export class CashHandler extends BaseHandler {
  constructor(
    private readonly sessions: SessionStore,
    private readonly cash: CashService,
  ) {
    super();
  }

  register(bot: Telegraf<BotContext>): void {
    bot.action(CALLBACK.CASH, async (ctx) => {
      await ctx.answerCbQuery();
      if (!(await this.ensure(ctx, 'cash.read'))) {
        return;
      }
      await this.showStatus(ctx);
    });

    bot.command('caja', async (ctx) => {
      const { text, keyboard } = await this.status();
      await this.reply(ctx, text, keyboard);
    });

    bot.action('cash:open', async (ctx) => {
      await ctx.answerCbQuery();
      if (!(await this.ensure(ctx, 'cash.open'))) {
        return;
      }
      this.sessions.setStep(ctx.user.id, 'cash:open_amount');
      await this.edit(
        ctx,
        ['*💰 ABRIR CAJA*', '', '¿Con cuánto efectivo empiezas?'].join('\n'),
        Markup.inlineKeyboard([
          [Markup.button.callback('Empezar en 0', 'cash:open:0')],
          [Markup.button.callback('❌ Cancelar', CALLBACK.CASH)],
        ]),
      );
    });

    bot.action('cash:open:0', async (ctx) => {
      await ctx.answerCbQuery();
      await this.openCash(ctx, '0');
    });

    bot.action('cash:close', async (ctx) => {
      await ctx.answerCbQuery();
      if (!(await this.ensure(ctx, 'cash.close'))) {
        return;
      }

      const summary = await this.cash.getSummary();
      this.sessions.setStep(ctx.user.id, 'cash:close_amount');

      await this.edit(
        ctx,
        [
          '*🔒 CERRAR CAJA*',
          '',
          `Efectivo esperado: *${amount(summary.expectedCash)}*`,
          '',
          'Cuenta el efectivo y escribe cuánto hay realmente\\.',
        ].join('\n'),
        Markup.inlineKeyboard([[Markup.button.callback('❌ Cancelar', CALLBACK.CASH)]]),
      );
    });

    bot.action('cash:movements', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showMovements(ctx);
    });

    bot.on(message('text'), async (ctx, next) => {
      const session = this.sessions.get(ctx.user.id);

      if (session.step === 'cash:open_amount') {
        return this.openCash(ctx, ctx.message.text);
      }
      if (session.step === 'cash:close_amount') {
        return this.closeCash(ctx, ctx.message.text);
      }

      return next();
    });
  }

  private async openCash(ctx: BotContext, raw: string): Promise<void> {
    let value: Prisma.Decimal;
    try {
      value = money(raw.replace(',', '.').trim());
    } catch {
      await this.reply(ctx, 'Monto inválido\\. Escribe un número\\.');
      return;
    }

    if (isNegative(value)) {
      await this.reply(ctx, 'El efectivo inicial no puede ser negativo\\.');
      return;
    }

    await this.cash.open(value, ctx.user.id);
    this.sessions.clear(ctx.user.id);

    const { text, keyboard } = await this.status();
    await this.reply(ctx, `✅ *Caja abierta*\n\n${text}`, keyboard);
  }

  private async closeCash(ctx: BotContext, raw: string): Promise<void> {
    let counted: Prisma.Decimal;
    try {
      counted = money(raw.replace(',', '.').trim());
    } catch {
      await this.reply(ctx, 'Monto inválido\\. Escribe un número\\.');
      return;
    }

    const result = await this.cash.close(counted, ctx.user.id);
    this.sessions.clear(ctx.user.id);

    const difference = result.difference;
    const lines = [
      '*🔒 CAJA CERRADA*',
      '',
      `Esperado: ${amount(result.expectedCash)}`,
      `Contado: ${amount(counted)}`,
      '',
    ];

    if (difference.isZero()) {
      lines.push('✅ *La caja cuadra exactamente*');
    } else if (difference.isNegative()) {
      lines.push(`⚠️ *Faltante: ${amount(difference.abs())}*`);
    } else {
      lines.push(`⚠️ *Sobrante: ${amount(difference)}*`);
    }

    await this.reply(ctx, lines.join('\n'), navigationKeyboard());
  }

  private async showStatus(ctx: BotContext): Promise<void> {
    const { text, keyboard } = await this.status();
    await this.edit(ctx, text, keyboard);
  }

  private async status(): Promise<{
    text: string;
    keyboard: ReturnType<typeof Markup.inlineKeyboard>;
  }> {
    const session = await this.cash.getOpenSession();

    if (!session) {
      return {
        text: ['*💰 CAJA*', '', '🔒 La caja está cerrada\\.'].join('\n'),
        keyboard: Markup.inlineKeyboard([
          [Markup.button.callback('🔓 Abrir caja', 'cash:open')],
          [Markup.button.callback('🏠 Menú', CALLBACK.MENU)],
        ]),
      };
    }

    const summary = await this.cash.getSummary(session.id);

    return {
      text: [
        '*💰 CAJA ABIERTA*',
        '',
        `Abierta: ${date(session.openedAt)}`,
        `Inicial: ${amount(summary.openingAmount)}`,
        '',
        `Entradas: ${amount(summary.totalIn)}`,
        `Salidas: ${amount(summary.totalOut)}`,
        `*Efectivo esperado: ${amount(summary.expectedCash)}*`,
        '',
        escapeMarkdown(`${summary.movementCount} movimiento(s)`),
      ].join('\n'),
      keyboard: Markup.inlineKeyboard([
        [Markup.button.callback('📋 Ver movimientos', 'cash:movements')],
        [Markup.button.callback('🔒 Cerrar caja', 'cash:close')],
        [Markup.button.callback('🏠 Menú', CALLBACK.MENU)],
      ]),
    };
  }

  private async showMovements(ctx: BotContext): Promise<void> {
    const session = await this.cash.getOpenSession();

    if (!session) {
      await this.edit(ctx, 'La caja está cerrada\\.', navigationKeyboard());
      return;
    }

    const movements = await this.cash.findMovements(session.id);
    const recent = movements.slice(-15);

    const lines = recent.map((movement) => {
      const sign = movement.direction === 'IN' ? '➕' : '➖';
      const description = movement.description ?? movement.type;
      return `${sign} ${amount(movement.amount)} · ${escapeMarkdown(description)}`;
    });

    await this.edit(
      ctx,
      [
        '*📋 MOVIMIENTOS DE CAJA*',
        '',
        ...(lines.length > 0 ? lines : ['Sin movimientos todavía\\.']),
      ].join('\n'),
      navigationKeyboard(CALLBACK.CASH),
    );
  }
}
