import { Injectable } from '@nestjs/common';
import { InventoryMovementType, Prisma } from '@prisma/client';
import { Markup, Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { quantity } from '../../common/money';
import { InventoryService } from '../../inventory/inventory.service';
import { ProductsService } from '../../products/products.service';
import { amount, qty } from '../formatters';
import { CALLBACK, navigationKeyboard } from '../keyboards/main-menu.keyboard';
import { escapeMarkdown } from '../messages';
import { SessionStore } from '../session/session.store';
import type { BotContext } from '../telegram.context';
import { BaseHandler, PAGE_SIZE } from './handler.base';

@Injectable()
export class InventoryHandler extends BaseHandler {
  constructor(
    private readonly sessions: SessionStore,
    private readonly inventory: InventoryService,
    private readonly products: ProductsService,
  ) {
    super();
  }

  register(bot: Telegraf<BotContext>): void {
    bot.action(CALLBACK.INVENTORY, async (ctx) => {
      await ctx.answerCbQuery();
      if (!(await this.ensure(ctx, 'inventory.read'))) {
        return;
      }
      await this.edit(ctx, await this.summaryText(), this.menuKeyboard());
    });

    bot.command('inventario', async (ctx) => {
      await this.reply(ctx, await this.summaryText(), this.menuKeyboard());
    });

    bot.action('inv:low', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showLowStock(ctx);
    });

    bot.action(/^inv:list:(\d+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      await this.showProducts(ctx, Number(ctx.match[1]));
    });

    bot.action('inv:search', async (ctx) => {
      await ctx.answerCbQuery();
      this.sessions.setStep(ctx.user.id, 'inventory:search');
      await this.edit(
        ctx,
        '*🔍 BUSCAR PRODUCTO*\n\nEscribe parte del nombre\\.',
        navigationKeyboard(CALLBACK.INVENTORY),
      );
    });

    bot.action(/^inv:variant:(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      await this.showVariant(ctx, ctx.match[1]);
    });

    bot.action(/^inv:in:(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      if (!(await this.ensure(ctx, 'inventory.adjust'))) {
        return;
      }

      const variant = await this.products.findVariantById(ctx.match[1]);
      const product = await this.products.findById(variant.productId);

      this.sessions.update(ctx.user.id, {
        step: 'inventory:quantity',
        targetId: variant.id,
        targetLabel: `${product.name} ${variant.name}`,
      });

      await this.edit(
        ctx,
        [
          '*📥 ENTRADA DE INVENTARIO*',
          '',
          escapeMarkdown(`${product.name} ${variant.name}`),
          `Stock actual: ${qty(variant.currentStock)}`,
          '',
          '¿Cuántas unidades entran?',
        ].join('\n'),
        Markup.inlineKeyboard([[Markup.button.callback('❌ Cancelar', CALLBACK.INVENTORY)]]),
      );
    });

    bot.on(message('text'), async (ctx, next) => {
      const session = this.sessions.get(ctx.user.id);

      if (session.step === 'inventory:search') {
        return this.handleSearch(ctx, ctx.message.text);
      }
      if (session.step === 'inventory:quantity') {
        return this.registerEntry(ctx, ctx.message.text);
      }

      return next();
    });
  }

  private async handleSearch(ctx: BotContext, term: string): Promise<void> {
    const result = await this.products.search(term, 1, PAGE_SIZE);

    const buttons = result.data.flatMap((product) =>
      product.variants.map((variant) => [
        Markup.button.callback(
          `${product.name} ${variant.name} · stock ${variant.currentStock.toFixed(0)}`,
          `inv:variant:${variant.id}`,
        ),
      ]),
    );

    this.sessions.setStep(ctx.user.id, 'idle');

    if (buttons.length === 0) {
      await this.reply(
        ctx,
        `No encontré productos con «${escapeMarkdown(term)}»\\.`,
        navigationKeyboard(CALLBACK.INVENTORY),
      );
      return;
    }

    await this.reply(
      ctx,
      '*PRODUCTOS*',
      Markup.inlineKeyboard([
        ...buttons.slice(0, 12),
        [Markup.button.callback('⬅️ Atrás', CALLBACK.INVENTORY)],
      ]),
    );
  }

  private async registerEntry(ctx: BotContext, raw: string): Promise<void> {
    const session = this.sessions.get(ctx.user.id);

    if (!session.targetId) {
      await this.reply(ctx, 'Se perdió el producto\\. Empieza de nuevo\\.');
      return;
    }

    let value: Prisma.Decimal;
    try {
      value = quantity(raw.replace(',', '.').trim());
    } catch {
      await this.reply(ctx, 'Cantidad inválida\\. Escribe un número\\.');
      return;
    }

    if (!value.greaterThan(0)) {
      await this.reply(ctx, 'La cantidad debe ser mayor que cero\\.');
      return;
    }

    const movement = await this.inventory.registerMovement({
      productVariantId: session.targetId,
      type: InventoryMovementType.PURCHASE,
      quantity: value,
      userId: ctx.user.id,
      notes: 'Entrada registrada desde Telegram',
    });

    this.sessions.clear(ctx.user.id);

    await this.reply(
      ctx,
      [
        '*✅ ENTRADA REGISTRADA*',
        '',
        escapeMarkdown(session.targetLabel ?? ''),
        `Entraron: ${qty(movement.quantity)}`,
        `Stock anterior: ${qty(movement.stockBefore)}`,
        `*Stock actual: ${qty(movement.stockAfter)}*`,
      ].join('\n'),
      navigationKeyboard(CALLBACK.INVENTORY),
    );
  }

  private async summaryText(): Promise<string> {
    const [value, lowStock] = await Promise.all([
      this.inventory.getInventoryValue(),
      this.inventory.findLowStock(),
    ]);

    const lines = [
      '*📦 INVENTARIO*',
      '',
      `Unidades: *${qty(value.totalUnits)}*`,
      `Valor a costo: ${amount(value.totalCost)}`,
    ];

    if (lowStock.length > 0) {
      lines.push('', escapeMarkdown(`⚠️ ${lowStock.length} producto(s) con stock bajo`));
    } else {
      lines.push('', '✅ Ningún producto bajo el mínimo');
    }

    return lines.join('\n');
  }

  private menuKeyboard(): ReturnType<typeof Markup.inlineKeyboard> {
    return Markup.inlineKeyboard([
      [Markup.button.callback('⚠️ Stock bajo', 'inv:low')],
      [Markup.button.callback('🔍 Buscar producto', 'inv:search')],
      [Markup.button.callback('📋 Ver todos', 'inv:list:1')],
      [Markup.button.callback('🏠 Menú', CALLBACK.MENU)],
    ]);
  }

  private async showLowStock(ctx: BotContext): Promise<void> {
    const lowStock = await this.inventory.findLowStock();

    if (lowStock.length === 0) {
      await this.edit(
        ctx,
        '✅ Ningún producto está bajo el mínimo\\.',
        navigationKeyboard(CALLBACK.INVENTORY),
      );
      return;
    }

    const rows = lowStock
      .slice(0, 12)
      .map((row) => [
        Markup.button.callback(
          `${row.productName} ${row.name} · ${row.currentStock.toFixed(0)}/${row.minimumStock.toFixed(0)}`,
          `inv:variant:${row.id}`,
        ),
      ]);

    await this.edit(
      ctx,
      [
        '*⚠️ STOCK BAJO*',
        '',
        escapeMarkdown(`${lowStock.length} producto(s) en o por debajo del mínimo:`),
      ].join('\n'),
      Markup.inlineKeyboard([...rows, [Markup.button.callback('⬅️ Atrás', CALLBACK.INVENTORY)]]),
    );
  }

  private async showProducts(ctx: BotContext, page: number): Promise<void> {
    const result = await this.products.findAll(page, PAGE_SIZE);

    const rows = result.data.flatMap((product) =>
      product.variants.map((variant) => [
        Markup.button.callback(
          `${product.name} ${variant.name} · ${variant.currentStock.toFixed(0)}`,
          `inv:variant:${variant.id}`,
        ),
      ]),
    );

    const pagination = this.paginationRow('inv:list', page, result.meta.totalPages);

    await this.edit(
      ctx,
      ['*📋 PRODUCTOS*', '', escapeMarkdown(`${result.meta.total} producto(s)`)].join('\n'),
      Markup.inlineKeyboard([
        ...rows,
        ...(pagination.length > 0 ? [pagination] : []),
        [Markup.button.callback('⬅️ Atrás', CALLBACK.INVENTORY)],
      ]),
    );
  }

  private async showVariant(ctx: BotContext, variantId: string): Promise<void> {
    const variant = await this.products.findVariantById(variantId);
    const product = await this.products.findById(variant.productId);
    const movements = await this.inventory.findMovements(variantId, 5);

    const lines = [
      `*${escapeMarkdown(`${product.name} ${variant.name}`)}*`,
      '',
      `Precio: ${amount(variant.salePrice)}`,
      `Costo: ${amount(variant.costPrice)}`,
      `*Stock: ${qty(variant.currentStock)}*`,
      `Mínimo: ${qty(variant.minimumStock)}`,
    ];

    if (movements.length > 0) {
      lines.push('', '*Últimos movimientos*');
      for (const movement of movements) {
        const sign = movement.direction === 'IN' ? '➕' : '➖';
        lines.push(`${sign} ${qty(movement.quantity)} · ${escapeMarkdown(movement.type)}`);
      }
    }

    await this.edit(
      ctx,
      lines.join('\n'),
      Markup.inlineKeyboard([
        [Markup.button.callback('📥 Registrar entrada', `inv:in:${variant.id}`)],
        [Markup.button.callback('⬅️ Atrás', CALLBACK.INVENTORY)],
      ]),
    );
  }
}
