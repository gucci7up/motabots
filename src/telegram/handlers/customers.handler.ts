import { Injectable } from '@nestjs/common';
import { Markup, Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { CustomersService } from '../../customers/customers.service';
import { amount, date } from '../formatters';
import { CALLBACK, navigationKeyboard } from '../keyboards/main-menu.keyboard';
import { escapeMarkdown } from '../messages';
import { SessionStore } from '../session/session.store';
import type { BotContext } from '../telegram.context';
import { BaseHandler, PAGE_SIZE } from './handler.base';

@Injectable()
export class CustomersHandler extends BaseHandler {
  constructor(
    private readonly sessions: SessionStore,
    private readonly customers: CustomersService,
  ) {
    super();
  }

  register(bot: Telegraf<BotContext>): void {
    bot.action(CALLBACK.CUSTOMERS, async (ctx) => {
      await ctx.answerCbQuery();
      if (!(await this.ensure(ctx, 'customers.read'))) {
        return;
      }
      await this.edit(ctx, this.menuText(), this.menuKeyboard());
    });

    bot.command('clientes', async (ctx) => {
      await this.reply(ctx, this.menuText(), this.menuKeyboard());
    });

    bot.action(/^cust:list:(\d+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      await this.showList(ctx, Number(ctx.match[1]));
    });

    bot.action('cust:search', async (ctx) => {
      await ctx.answerCbQuery();
      this.sessions.setStep(ctx.user.id, 'customer:search');
      await this.edit(
        ctx,
        '*🔍 BUSCAR CLIENTE*\n\nEscribe nombre, teléfono o cédula\\.',
        navigationKeyboard(CALLBACK.CUSTOMERS),
      );
    });

    bot.action('cust:new', async (ctx) => {
      await ctx.answerCbQuery();
      if (!(await this.ensure(ctx, 'customers.create'))) {
        return;
      }
      this.sessions.setStep(ctx.user.id, 'customer:new_name');
      await this.edit(
        ctx,
        '*➕ NUEVO CLIENTE*\n\nEscribe el nombre\\.',
        navigationKeyboard(CALLBACK.CUSTOMERS),
      );
    });

    bot.action('cust:nophone', async (ctx) => {
      await ctx.answerCbQuery();
      await this.saveCustomer(ctx);
    });

    bot.action(/^cust:view:(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      await this.showCustomer(ctx, ctx.match[1]);
    });

    bot.on(message('text'), async (ctx, next) => {
      const session = this.sessions.get(ctx.user.id);

      if (session.step === 'customer:search') {
        return this.handleSearch(ctx, ctx.message.text);
      }
      if (session.step === 'customer:new_name') {
        const name = ctx.message.text.trim();
        if (name.length < 2) {
          await this.reply(ctx, 'El nombre es muy corto\\.');
          return;
        }
        this.sessions.update(ctx.user.id, {
          newCustomerName: name,
          step: 'customer:new_phone',
        });
        await this.reply(
          ctx,
          'Escribe el teléfono, o pulsa Omitir\\.',
          Markup.inlineKeyboard([[Markup.button.callback('Omitir', 'cust:nophone')]]),
        );
        return;
      }
      if (session.step === 'customer:new_phone') {
        return this.saveCustomer(ctx, ctx.message.text);
      }

      return next();
    });
  }

  private async saveCustomer(ctx: BotContext, phone?: string): Promise<void> {
    const session = this.sessions.get(ctx.user.id);

    if (!session.newCustomerName) {
      await this.reply(ctx, 'Se perdió el nombre\\. Empieza de nuevo\\.');
      return;
    }

    const customer = await this.customers.create({ name: session.newCustomerName, phone });
    this.sessions.clear(ctx.user.id);

    await this.reply(
      ctx,
      `✅ Cliente creado: *${escapeMarkdown(customer.name)}*`,
      Markup.inlineKeyboard([
        [Markup.button.callback('👤 Ver ficha', `cust:view:${customer.id}`)],
        [Markup.button.callback('🏠 Menú', CALLBACK.MENU)],
      ]),
    );
  }

  private async handleSearch(ctx: BotContext, term: string): Promise<void> {
    const result = await this.customers.search(term, 1, PAGE_SIZE);
    this.sessions.setStep(ctx.user.id, 'idle');

    if (result.data.length === 0) {
      await this.reply(
        ctx,
        `No encontré clientes con «${escapeMarkdown(term)}»\\.`,
        Markup.inlineKeyboard([
          [Markup.button.callback('➕ Crear cliente', 'cust:new')],
          [Markup.button.callback('⬅️ Atrás', CALLBACK.CUSTOMERS)],
        ]),
      );
      return;
    }

    await this.reply(
      ctx,
      '*CLIENTES ENCONTRADOS*',
      Markup.inlineKeyboard([
        ...result.data.map((customer) => [
          Markup.button.callback(
            customer.phone ? `${customer.name} · ${customer.phone}` : customer.name,
            `cust:view:${customer.id}`,
          ),
        ]),
        [Markup.button.callback('⬅️ Atrás', CALLBACK.CUSTOMERS)],
      ]),
    );
  }

  private async showList(ctx: BotContext, page: number): Promise<void> {
    const result = await this.customers.findAll(page, PAGE_SIZE);

    if (result.data.length === 0) {
      await this.edit(
        ctx,
        'Todavía no hay clientes registrados\\.',
        Markup.inlineKeyboard([
          [Markup.button.callback('➕ Crear cliente', 'cust:new')],
          [Markup.button.callback('🏠 Menú', CALLBACK.MENU)],
        ]),
      );
      return;
    }

    const pagination = this.paginationRow('cust:list', page, result.meta.totalPages);

    await this.edit(
      ctx,
      ['*👥 CLIENTES*', '', escapeMarkdown(`${result.meta.total} cliente(s)`)].join('\n'),
      Markup.inlineKeyboard([
        ...result.data.map((customer) => [
          Markup.button.callback(customer.name, `cust:view:${customer.id}`),
        ]),
        ...(pagination.length > 0 ? [pagination] : []),
        [Markup.button.callback('⬅️ Atrás', CALLBACK.CUSTOMERS)],
      ]),
    );
  }

  private async showCustomer(ctx: BotContext, customerId: string): Promise<void> {
    const history = await this.customers.getHistory(customerId);
    const customer = history.customer;

    const lines = [`*👤 ${escapeMarkdown(customer.name.toUpperCase())}*`, ''];

    if (customer.phone) {
      lines.push(`Teléfono: ${escapeMarkdown(customer.phone)}`);
    }
    if (customer.identificationNumber) {
      lines.push(`Cédula: ${escapeMarkdown(customer.identificationNumber)}`);
    }
    if (customer.address) {
      lines.push(`Dirección: ${escapeMarkdown(customer.address)}`);
    }

    lines.push(
      '',
      `Compras: ${history.salesCount}`,
      `Total comprado: ${amount(history.totalPurchases)}`,
    );

    if (history.lastSaleAt) {
      lines.push(`Última compra: ${date(history.lastSaleAt)}`);
    }

    if (history.balance.balance.greaterThan(0)) {
      lines.push('', `*Debe: ${amount(history.balance.balance)}*`);
      if (history.balance.overdueBalance.greaterThan(0)) {
        lines.push(`🔴 Vencido: ${amount(history.balance.overdueBalance)}`);
      }
    } else {
      lines.push('', '✅ Sin deuda pendiente');
    }

    if (customer.creditLimit) {
      lines.push(`Límite de crédito: ${amount(customer.creditLimit)}`);
    }

    await this.edit(
      ctx,
      lines.join('\n'),
      Markup.inlineKeyboard([
        ...(history.balance.balance.greaterThan(0)
          ? [[Markup.button.callback('💳 Ver créditos', `credits:cust:${customer.id}`)]]
          : []),
        [Markup.button.callback('⬅️ Atrás', CALLBACK.CUSTOMERS)],
        [Markup.button.callback('🏠 Menú', CALLBACK.MENU)],
      ]),
    );
  }

  private menuText(): string {
    return ['*👥 CLIENTES*', '', '¿Qué quieres hacer?'].join('\n');
  }

  private menuKeyboard(): ReturnType<typeof Markup.inlineKeyboard> {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🔍 Buscar', 'cust:search')],
      [Markup.button.callback('📋 Ver todos', 'cust:list:1')],
      [Markup.button.callback('➕ Nuevo cliente', 'cust:new')],
      [Markup.button.callback('🏠 Menú', CALLBACK.MENU)],
    ]);
  }
}
