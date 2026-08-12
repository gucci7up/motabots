import { Injectable } from '@nestjs/common';
import { PaymentMethod, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Markup, Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { formatLocalDate } from '../../common/date-range';
import { isNegative, money, quantity } from '../../common/money';
import { CustomersService } from '../../customers/customers.service';
import { ProductsService } from '../../products/products.service';
import { SalesService } from '../../sales/sales.service';
import { SettingKey, SettingsService } from '../../settings/settings.service';
import { amount, cartTotal, qty, renderCart, renderSaleReceipt, renderSaleSummary } from '../formatters';
import { CALLBACK, navigationKeyboard } from '../keyboards/main-menu.keyboard';
import { escapeMarkdown } from '../messages';
import type { BotContext } from '../telegram.context';
import { SessionStore } from '../session/session.store';
import { BaseHandler, PAGE_SIZE } from './handler.base';

@Injectable()
export class SaleHandler extends BaseHandler {
  constructor(
    private readonly sessions: SessionStore,
    private readonly sales: SalesService,
    private readonly products: ProductsService,
    private readonly customers: CustomersService,
    private readonly settings: SettingsService,
  ) {
    super();
  }

  register(bot: Telegraf<BotContext>): void {
    bot.action(CALLBACK.SALES, async (ctx) => {
      await ctx.answerCbQuery();
      await this.edit(ctx, this.salesMenuText(), this.salesMenuKeyboard());
    });

    bot.command('venta', async (ctx) => {
      if (!this.can(ctx, 'sales.create')) {
        await this.reply(ctx, '🔒 No tienes permiso para registrar ventas\\.');
        return;
      }
      this.startSale(ctx);
      await this.reply(ctx, this.customerStepText(), this.customerStepKeyboard());
    });

    bot.action('sale:new', async (ctx) => {
      await ctx.answerCbQuery();
      if (!(await this.ensure(ctx, 'sales.create'))) {
        return;
      }
      this.startSale(ctx);
      await this.edit(ctx, this.customerStepText(), this.customerStepKeyboard());
    });

    // ── Cliente ──────────────────────────────────────────────
    bot.action('sale:cust:none', async (ctx) => {
      await ctx.answerCbQuery();
      this.sessions.update(ctx.user.id, { customerId: null, customerName: undefined });
      await this.edit(ctx, this.productStepText(), this.productStepKeyboard());
    });

    bot.action('sale:cust:nophone', async (ctx) => {
      await ctx.answerCbQuery();
      await this.createCustomer(ctx);
    });

    bot.action('sale:cust:search', async (ctx) => {
      await ctx.answerCbQuery();
      this.sessions.setStep(ctx.user.id, 'sale:customer_search');
      await this.edit(
        ctx,
        '*🔍 BUSCAR CLIENTE*\n\nEscribe el nombre, teléfono o cédula\\.',
        this.cancelKeyboard(),
      );
    });

    bot.action('sale:cust:new', async (ctx) => {
      await ctx.answerCbQuery();
      if (!(await this.ensure(ctx, 'customers.create'))) {
        return;
      }
      this.sessions.setStep(ctx.user.id, 'sale:customer_new_name');
      await this.edit(ctx, '*➕ NUEVO CLIENTE*\n\nEscribe el nombre\\.', this.cancelKeyboard());
    });

    bot.action(/^sale:cust:pick:(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const customerId = ctx.match[1];
      if (!customerId) {
        return;
      }
      const customer = await this.customers.findById(customerId);
      this.sessions.update(ctx.user.id, {
        customerId: customer.id,
        customerName: customer.name,
        step: 'idle',
      });
      await this.edit(ctx, this.productStepText(customer.name), this.productStepKeyboard());
    });

    // ── Productos ────────────────────────────────────────────
    bot.action('sale:prod:search', async (ctx) => {
      await ctx.answerCbQuery();
      this.sessions.setStep(ctx.user.id, 'sale:product_search');
      await this.edit(
        ctx,
        '*🔍 BUSCAR PRODUCTO*\n\nEscribe parte del nombre\\.',
        this.cancelKeyboard(),
      );
    });

    bot.action(/^sale:prod:pick:(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const variantId = ctx.match[1];
      if (!variantId) {
        return;
      }

      const variant = await this.products.findVariantById(variantId);
      const product = await this.products.findById(variant.productId);
      const label = `${product.name} ${variant.name}`;

      this.sessions.update(ctx.user.id, {
        step: 'sale:quantity',
        targetId: variant.id,
        targetLabel: label,
      });

      await this.edit(
        ctx,
        [
          `*${escapeMarkdown(label)}*`,
          '',
          `Precio: ${amount(variant.salePrice)}`,
          `Disponible: ${qty(variant.currentStock)}`,
          '',
          '¿Cuántas unidades?',
        ].join('\n'),
        Markup.inlineKeyboard([
          [1, 2, 3].map((n) => Markup.button.callback(String(n), `sale:qty:${n}`)),
          [4, 5, 10].map((n) => Markup.button.callback(String(n), `sale:qty:${n}`)),
          [Markup.button.callback('❌ Cancelar', 'sale:cancel')],
        ]),
      );
    });

    bot.action(/^sale:qty:(\d+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      await this.addLine(ctx, ctx.match[1]);
    });

    // ── Carrito ──────────────────────────────────────────────
    bot.action('sale:cart', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showCart(ctx);
    });

    bot.action('sale:cart:add', async (ctx) => {
      await ctx.answerCbQuery();
      this.sessions.setStep(ctx.user.id, 'sale:product_search');
      await this.edit(
        ctx,
        '*🔍 BUSCAR PRODUCTO*\n\nEscribe parte del nombre\\.',
        this.cancelKeyboard(),
      );
    });

    bot.action(/^sale:cart:del:(\d+)$/, async (ctx) => {
      await ctx.answerCbQuery('Línea eliminada');
      const index = Number(ctx.match[1]);
      if (Number.isInteger(index)) {
        this.sessions.removeFromCart(ctx.user.id, index);
      }
      await this.showCart(ctx);
    });

    bot.action('sale:discount', async (ctx) => {
      await ctx.answerCbQuery();
      this.sessions.update(ctx.user.id, { step: 'sale:discount', discountReturnTo: 'cart' });
      await this.edit(ctx, this.discountText(ctx), this.discountKeyboard());
    });

    // Mismo descuento, pero pedido desde la pantalla de pago: se vuelve allí, no al carrito.
    bot.action('sale:discount:pay', async (ctx) => {
      await ctx.answerCbQuery();
      this.sessions.update(ctx.user.id, { step: 'sale:discount', discountReturnTo: 'payment' });
      await this.edit(ctx, this.discountText(ctx), this.discountKeyboard());
    });

    bot.action('sale:discount:clear', async (ctx) => {
      await ctx.answerCbQuery('Descuento quitado');
      const session = this.sessions.get(ctx.user.id);
      this.sessions.update(ctx.user.id, { discount: undefined, step: 'idle' });

      if (session.discountReturnTo === 'payment') {
        await this.edit(ctx, this.methodStepText(ctx), this.methodKeyboard());
      } else {
        await this.showCart(ctx);
      }
    });

    // ── Pago ─────────────────────────────────────────────────
    bot.action('sale:checkout', async (ctx) => {
      await ctx.answerCbQuery();
      const session = this.sessions.get(ctx.user.id);

      if (session.cart.length === 0) {
        await ctx.answerCbQuery('El carrito está vacío', { show_alert: true });
        return;
      }

      // La forma de pago va primero: la tarjeta lleva recargo y cambia el total.
      await this.edit(ctx, this.methodStepText(ctx), this.methodKeyboard());
    });

    bot.action('sale:pay:full', async (ctx) => {
      await ctx.answerCbQuery();
      const total = await this.totalWithSurcharge(ctx);
      this.sessions.update(ctx.user.id, { paidAmount: total.toString(), step: 'idle' });
      await this.showSummary(ctx);
    });

    bot.action('sale:pay:none', async (ctx) => {
      await ctx.answerCbQuery();
      if (!(await this.assertCreditAllowed(ctx))) {
        return;
      }
      this.sessions.update(ctx.user.id, { paidAmount: '0', step: 'idle' });
      await this.askDueDate(ctx);
    });

    bot.action('sale:pay:partial', async (ctx) => {
      await ctx.answerCbQuery();
      if (!(await this.assertCreditAllowed(ctx))) {
        return;
      }
      this.sessions.setStep(ctx.user.id, 'sale:payment_amount');
      await this.edit(
        ctx,
        [
          '*🧮 PAGO PARCIAL*',
          '',
          `Total: ${amount(await this.totalWithSurcharge(ctx))}`,
          '',
          'Escribe cuánto te está pagando ahora\\.',
        ].join('\n'),
        this.cancelKeyboard(),
      );
    });

    bot.action(/^sale:method:(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      this.sessions.update(ctx.user.id, { paymentMethod: ctx.match[1] });
      await this.edit(ctx, await this.paymentStepText(ctx), this.paymentKeyboard());
    });

    // ── Vencimiento ──────────────────────────────────────────
    bot.action(/^sale:due:(\d+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const days = Number(ctx.match[1]);
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + days);
      this.sessions.update(ctx.user.id, { dueDate: dueDate.toISOString(), step: 'idle' });
      await this.showSummary(ctx);
    });

    bot.action('sale:due:custom', async (ctx) => {
      await ctx.answerCbQuery();
      this.sessions.setStep(ctx.user.id, 'sale:due_date');
      await this.edit(
        ctx,
        '*📅 VENCIMIENTO*\n\nEscribe la fecha en formato DD/MM/AAAA\\.',
        this.cancelKeyboard(),
      );
    });

    // ── Confirmación ─────────────────────────────────────────
    bot.action('sale:confirm', async (ctx) => {
      await ctx.answerCbQuery('Registrando…');
      await this.confirm(ctx);
    });

    bot.action('sale:cancel', async (ctx) => {
      await ctx.answerCbQuery('Venta cancelada');
      this.sessions.clear(ctx.user.id);
      await this.edit(ctx, '❌ Venta cancelada\\.', navigationKeyboard());
    });

    // ── Entrada de texto del asistente ───────────────────────
    bot.on(message('text'), async (ctx, next) => {
      const session = this.sessions.get(ctx.user.id);
      if (!session.step.startsWith('sale:')) {
        return next();
      }

      const text = ctx.message.text.trim();

      switch (session.step) {
        case 'sale:customer_search':
          return this.handleCustomerSearch(ctx, text);
        case 'sale:customer_new_name':
          return this.handleNewCustomerName(ctx, text);
        case 'sale:customer_new_phone':
          return this.handleNewCustomerPhone(ctx, text);
        case 'sale:product_search':
          return this.handleProductSearch(ctx, text);
        case 'sale:quantity':
          return this.addLine(ctx, text);
        case 'sale:discount':
          return this.handleDiscount(ctx, text);
        case 'sale:payment_amount':
          return this.handlePaymentAmount(ctx, text);
        case 'sale:due_date':
          return this.handleDueDate(ctx, text);
        default:
          return next();
      }
    });
  }

  // ── Pasos ──────────────────────────────────────────────────

  private startSale(ctx: BotContext): void {
    this.sessions.clear(ctx.user.id);
    this.sessions.update(ctx.user.id, { idempotencyKey: randomUUID(), step: 'idle' });
  }

  private async handleCustomerSearch(ctx: BotContext, term: string): Promise<void> {
    const result = await this.customers.search(term, 1, PAGE_SIZE);

    if (result.data.length === 0) {
      await this.reply(
        ctx,
        `No encontré clientes con «${escapeMarkdown(term)}»\\.`,
        Markup.inlineKeyboard([
          [Markup.button.callback('➕ Crear cliente nuevo', 'sale:cust:new')],
          [Markup.button.callback('🔍 Buscar otra vez', 'sale:cust:search')],
          [Markup.button.callback('❌ Cancelar', 'sale:cancel')],
        ]),
      );
      return;
    }

    await this.reply(
      ctx,
      '*CLIENTES ENCONTRADOS*\n\nElige uno:',
      Markup.inlineKeyboard([
        ...result.data.map((customer) => [
          Markup.button.callback(
            customer.phone ? `${customer.name} · ${customer.phone}` : customer.name,
            `sale:cust:pick:${customer.id}`,
          ),
        ]),
        [Markup.button.callback('❌ Cancelar', 'sale:cancel')],
      ]),
    );
  }

  private async handleNewCustomerName(ctx: BotContext, name: string): Promise<void> {
    if (name.length < 2) {
      await this.reply(ctx, 'El nombre es muy corto\\. Escríbelo de nuevo\\.');
      return;
    }

    this.sessions.update(ctx.user.id, {
      newCustomerName: name,
      step: 'sale:customer_new_phone',
    });

    await this.reply(
      ctx,
      'Escribe el teléfono, o pulsa Omitir\\.',
      Markup.inlineKeyboard([
        [Markup.button.callback('Omitir', 'sale:cust:nophone')],
        [Markup.button.callback('❌ Cancelar', 'sale:cancel')],
      ]),
    );
  }

  private async handleNewCustomerPhone(ctx: BotContext, phone: string): Promise<void> {
    await this.createCustomer(ctx, phone);
  }

  private async createCustomer(ctx: BotContext, phone?: string): Promise<void> {
    const session = this.sessions.get(ctx.user.id);
    const name = session.newCustomerName;

    if (!name) {
      await this.reply(ctx, 'Se perdió el nombre del cliente\\. Empieza de nuevo con /venta\\.');
      return;
    }

    const customer = await this.customers.create({ name, phone });
    this.sessions.update(ctx.user.id, {
      customerId: customer.id,
      customerName: customer.name,
      step: 'idle',
    });

    await this.reply(
      ctx,
      `✅ Cliente creado: ${escapeMarkdown(customer.name)}`,
      this.productStepKeyboard(),
    );
  }

  private async handleProductSearch(ctx: BotContext, term: string): Promise<void> {
    const result = await this.products.search(term, 1, PAGE_SIZE);

    const buttons = result.data.flatMap((product) =>
      product.variants
        .filter((variant) => variant.isActive)
        .map((variant) => [
          Markup.button.callback(
            `${product.name} ${variant.name} · ${variant.salePrice.toFixed(0)} · stock ${variant.currentStock.toFixed(0)}`,
            `sale:prod:pick:${variant.id}`,
          ),
        ]),
    );

    if (buttons.length === 0) {
      await this.reply(
        ctx,
        `No encontré productos con «${escapeMarkdown(term)}»\\.`,
        Markup.inlineKeyboard([
          [Markup.button.callback('🔍 Buscar otra vez', 'sale:prod:search')],
          [Markup.button.callback('❌ Cancelar', 'sale:cancel')],
        ]),
      );
      return;
    }

    await this.reply(
      ctx,
      '*PRODUCTOS*\n\nElige uno:',
      Markup.inlineKeyboard([
        ...buttons.slice(0, 12),
        [Markup.button.callback('❌ Cancelar', 'sale:cancel')],
      ]),
    );
  }

  private async addLine(ctx: BotContext, rawQuantity: string): Promise<void> {
    const session = this.sessions.get(ctx.user.id);

    if (!session.targetId) {
      await this.reply(ctx, 'No hay producto seleccionado\\. Empieza de nuevo con /venta\\.');
      return;
    }

    let parsed: Prisma.Decimal;
    try {
      parsed = quantity(rawQuantity.replace(',', '.'));
    } catch {
      await this.reply(ctx, 'Cantidad inválida\\. Escribe un número\\.');
      return;
    }

    if (!parsed.greaterThan(0)) {
      await this.reply(ctx, 'La cantidad debe ser mayor que cero\\.');
      return;
    }

    const variant = await this.products.findVariantById(session.targetId);

    this.sessions.addToCart(ctx.user.id, {
      productVariantId: variant.id,
      description: session.targetLabel ?? variant.name,
      quantity: parsed.toString(),
      unitPrice: variant.salePrice.toString(),
    });
    this.sessions.update(ctx.user.id, { step: 'idle', targetId: undefined });

    await this.showCart(ctx, true);
  }

  private async handleDiscount(ctx: BotContext, text: string): Promise<void> {
    let discount: Prisma.Decimal;
    try {
      discount = money(text.replace(',', '.'));
    } catch {
      await this.reply(ctx, 'Monto inválido\\. Escribe un número\\.');
      return;
    }

    if (isNegative(discount)) {
      await this.reply(ctx, 'El descuento no puede ser negativo\\.');
      return;
    }

    const total = cartTotal(this.sessions.get(ctx.user.id).cart);
    if (discount.greaterThan(total)) {
      await this.reply(ctx, 'El descuento no puede superar el total\\.');
      return;
    }

    const session = this.sessions.update(ctx.user.id, {
      discount: discount.toString(),
      step: 'idle',
    });

    // Se vuelve a la pantalla desde la que se pidió el descuento, no siempre al carrito.
    if (session.discountReturnTo === 'payment') {
      await this.reply(ctx, this.methodStepText(ctx), this.methodKeyboard());
      return;
    }

    await this.showCart(ctx, true);
  }

  private async handlePaymentAmount(ctx: BotContext, text: string): Promise<void> {
    let paid: Prisma.Decimal;
    try {
      paid = money(text.replace(',', '.'));
    } catch {
      await this.reply(ctx, 'Monto inválido\\. Escribe un número\\.');
      return;
    }

    const total = await this.totalWithSurcharge(ctx);

    if (isNegative(paid)) {
      await this.reply(ctx, 'El pago no puede ser negativo\\.');
      return;
    }
    if (paid.greaterThan(total)) {
      await this.reply(ctx, `El pago no puede superar el total \\(${amount(total)}\\)\\.`);
      return;
    }

    this.sessions.update(ctx.user.id, { paidAmount: paid.toString(), step: 'idle' });

    if (paid.equals(total)) {
      await this.showSummary(ctx);
      return;
    }

    await this.askDueDate(ctx);
  }

  private async handleDueDate(ctx: BotContext, text: string): Promise<void> {
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);

    if (!match) {
      await this.reply(ctx, 'Fecha inválida\\. Usa DD/MM/AAAA\\.');
      return;
    }

    const [, day, month, year] = match;
    const dueDate = new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 59);

    if (Number.isNaN(dueDate.getTime())) {
      await this.reply(ctx, 'Fecha inválida\\. Usa DD/MM/AAAA\\.');
      return;
    }

    this.sessions.update(ctx.user.id, { dueDate: dueDate.toISOString(), step: 'idle' });
    await this.showSummary(ctx);
  }

  private async askDueDate(ctx: BotContext): Promise<void> {
    const days = await this.settings.getNumber(SettingKey.CREDIT_DEFAULT_DUE_DAYS, 15);

    await this.edit(
      ctx,
      ['*📅 VENCIMIENTO DEL CRÉDITO*', '', '¿Cuándo te paga el resto?'].join('\n'),
      Markup.inlineKeyboard([
        [
          Markup.button.callback('7 días', 'sale:due:7'),
          Markup.button.callback('15 días', 'sale:due:15'),
        ],
        [
          Markup.button.callback('30 días', 'sale:due:30'),
          Markup.button.callback(`${days} días (def.)`, `sale:due:${days}`),
        ],
        [Markup.button.callback('📅 Otra fecha', 'sale:due:custom')],
        [Markup.button.callback('❌ Cancelar', 'sale:cancel')],
      ]),
    );
  }

  private async showCart(ctx: BotContext, asReply = false): Promise<void> {
    const session = this.sessions.get(ctx.user.id);
    const text = renderCart(session.cart, session.customerName);

    const rows: ReturnType<typeof Markup.button.callback>[][] = [
      [
        Markup.button.callback('➕ Agregar', 'sale:cart:add'),
        Markup.button.callback('💲 Descuento', 'sale:discount'),
      ],
    ];

    session.cart.forEach((line, index) => {
      rows.push([
        Markup.button.callback(`🗑 Quitar ${index + 1}. ${line.description}`, `sale:cart:del:${index}`),
      ]);
    });

    if (session.cart.length > 0) {
      rows.push([Markup.button.callback('✅ Continuar al pago', 'sale:checkout')]);
    }
    rows.push([Markup.button.callback('❌ Cancelar venta', 'sale:cancel')]);

    const keyboard = Markup.inlineKeyboard(rows);

    if (asReply) {
      await this.reply(ctx, text, keyboard);
    } else {
      await this.edit(ctx, text, keyboard);
    }
  }

  private async showSummary(ctx: BotContext): Promise<void> {
    const session = this.sessions.get(ctx.user.id);
    const storeName = await this.settings.getString(SettingKey.STORE_NAME, 'MotaParfum');

    const discount = session.discount ? money(session.discount) : money(0);
    const surcharge = await this.surcharge(ctx);
    const total = await this.totalWithSurcharge(ctx);
    const paid = session.paidAmount ? money(session.paidAmount) : money(0);
    const pending = money(total.minus(paid));

    const text = renderSaleSummary({
      storeName,
      customerName: session.customerName,
      cart: session.cart,
      discount,
      surcharge,
      total,
      paid,
      pending,
      dueDate: session.dueDate ? new Date(session.dueDate) : undefined,
    });

    await this.edit(
      ctx,
      text,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ CONFIRMAR', 'sale:confirm')],
        [Markup.button.callback('❌ CANCELAR', 'sale:cancel')],
      ]),
    );
  }

  private async confirm(ctx: BotContext): Promise<void> {
    const session = this.sessions.get(ctx.user.id);

    if (session.cart.length === 0) {
      await this.reply(ctx, 'El carrito está vacío\\.');
      return;
    }

    const paid = session.paidAmount ? money(session.paidAmount) : money(0);

    const sale = await this.sales.create(
      {
        customerId: session.customerId ?? undefined,
        items: session.cart.map((line) => ({
          productVariantId: line.productVariantId,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
        })),
        discount: session.discount,
        payments: paid.greaterThan(0)
          ? [
              {
                amount: paid.toString(),
                method: (session.paymentMethod as PaymentMethod) ?? PaymentMethod.CASH,
              },
            ]
          : [],
        dueDate: session.dueDate,
        idempotencyKey: session.idempotencyKey,
      },
      ctx.user.id,
    );

    // El carrito se limpia sólo cuando la venta ya está en la base.
    this.sessions.clear(ctx.user.id);

    await this.edit(
      ctx,
      renderSaleReceipt({
        saleNumber: sale.saleNumber,
        invoiceNumber: sale.invoice?.number,
        total: sale.total,
        paidAmount: sale.paidAmount,
        pendingAmount: sale.pendingAmount,
        customerName: sale.customer?.name,
      }),
      Markup.inlineKeyboard([
        [Markup.button.callback('🧾 Enviar factura', `invoice:pdf:${sale.invoice?.id ?? ''}`)],
        [Markup.button.callback('🛒 Nueva venta', 'sale:new')],
        [Markup.button.callback('🏠 Menú', CALLBACK.MENU)],
      ]),
    );
  }

  // ── Utilidades ─────────────────────────────────────────────

  /** Valor de los productos ya descontado, sin recargo. */
  private base(ctx: BotContext): Prisma.Decimal {
    const session = this.sessions.get(ctx.user.id);
    const discount = session.discount ? money(session.discount) : money(0);
    return money(cartTotal(session.cart).minus(discount));
  }

  /**
   * Recargo por pagar con tarjeta, sólo para mostrarlo en pantalla. El importe que se guarda
   * lo vuelve a calcular SalesService dentro de la transacción, desde la misma configuración:
   * el bot muestra, no decide cuánto se cobra.
   */
  private async surcharge(ctx: BotContext): Promise<Prisma.Decimal> {
    const session = this.sessions.get(ctx.user.id);
    if (session.paymentMethod !== PaymentMethod.CARD) {
      return money(0);
    }

    const percent = await this.settings.getNumber(SettingKey.CARD_SURCHARGE_PERCENT, 10);
    return money(this.base(ctx).times(new Prisma.Decimal(percent).dividedBy(100)));
  }

  private async totalWithSurcharge(ctx: BotContext): Promise<Prisma.Decimal> {
    return money(this.base(ctx).plus(await this.surcharge(ctx)));
  }

  private async assertCreditAllowed(ctx: BotContext): Promise<boolean> {
    const session = this.sessions.get(ctx.user.id);

    if (!session.customerId) {
      await ctx.answerCbQuery(
        'Una venta a crédito necesita cliente: hay que saber quién debe.',
        { show_alert: true },
      );
      return false;
    }

    const enabled = await this.settings.getBoolean(SettingKey.CREDIT_ENABLED, true);
    if (!enabled) {
      await ctx.answerCbQuery('Las ventas a crédito están desactivadas.', { show_alert: true });
      return false;
    }

    return true;
  }

  private can(ctx: BotContext, permission: 'sales.create'): boolean {
    return ctx.user.permissions.includes(permission);
  }

  private salesMenuText(): string {
    return ['*🛒 VENTAS*', '', '¿Qué quieres hacer?'].join('\n');
  }

  private salesMenuKeyboard(): ReturnType<typeof Markup.inlineKeyboard> {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🆕 Nueva venta', 'sale:new')],
      [Markup.button.callback('📋 Ventas de hoy', 'reports:sales:today')],
      [Markup.button.callback('🏠 Menú', CALLBACK.MENU)],
    ]);
  }

  private customerStepText(): string {
    return ['*🛒 NUEVA VENTA*', '', '*Paso 1: cliente*'].join('\n');
  }

  private customerStepKeyboard(): ReturnType<typeof Markup.inlineKeyboard> {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🔍 Buscar cliente', 'sale:cust:search')],
      [Markup.button.callback('➕ Cliente nuevo', 'sale:cust:new')],
      [Markup.button.callback('🚶 Sin cliente', 'sale:cust:none')],
      [Markup.button.callback('❌ Cancelar', 'sale:cancel')],
    ]);
  }

  private productStepText(customerName?: string): string {
    return [
      '*🛒 NUEVA VENTA*',
      customerName ? `Cliente: ${escapeMarkdown(customerName)}` : 'Sin cliente',
      '',
      '*Paso 2: productos*',
    ].join('\n');
  }

  private productStepKeyboard(): ReturnType<typeof Markup.inlineKeyboard> {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🔍 Buscar producto', 'sale:prod:search')],
      [Markup.button.callback('🛒 Ver carrito', 'sale:cart')],
      [Markup.button.callback('❌ Cancelar', 'sale:cancel')],
    ]);
  }

  /** Muestra el importe para que el descuento se decida viendo la cifra, no a ciegas. */
  private methodStepText(ctx: BotContext): string {
    const session = this.sessions.get(ctx.user.id);
    const discount = session.discount ? money(session.discount) : money(0);
    const lines = ['*💳 FORMA DE PAGO*', ''];

    if (discount.greaterThan(0)) {
      lines.push(
        `Productos: ${amount(cartTotal(session.cart))}`,
        `Descuento: \\-${amount(discount)}`,
      );
    }

    lines.push(`Total: *${amount(this.base(ctx))}*`, '', '¿Con qué te paga?');
    return lines.join('\n');
  }

  private methodKeyboard(): ReturnType<typeof Markup.inlineKeyboard> {
    return Markup.inlineKeyboard([
      [Markup.button.callback('💵 Efectivo', `sale:method:${PaymentMethod.CASH}`)],
      [Markup.button.callback('🏦 Transferencia', `sale:method:${PaymentMethod.BANK_TRANSFER}`)],
      [Markup.button.callback('💳 Tarjeta (+10%)', `sale:method:${PaymentMethod.CARD}`)],
      [Markup.button.callback('📱 Pago móvil', `sale:method:${PaymentMethod.MOBILE_PAYMENT}`)],
      [Markup.button.callback('💲 Aplicar descuento', 'sale:discount:pay')],
      [Markup.button.callback('🛒 Volver al carrito', 'sale:cart')],
      [Markup.button.callback('❌ Cancelar', 'sale:cancel')],
    ]);
  }

  private discountText(ctx: BotContext): string {
    const session = this.sessions.get(ctx.user.id);
    const current = session.discount ? money(session.discount) : money(0);
    const lines = ['*💲 DESCUENTO*', '', `Total sin descuento: ${amount(cartTotal(session.cart))}`];

    if (current.greaterThan(0)) {
      lines.push(`Descuento actual: ${amount(current)}`);
    }

    lines.push('', 'Escribe el monto a descontar\\.');
    return lines.join('\n');
  }

  private discountKeyboard(): ReturnType<typeof Markup.inlineKeyboard> {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🚫 Quitar descuento', 'sale:discount:clear')],
      [Markup.button.callback('❌ Cancelar venta', 'sale:cancel')],
    ]);
  }

  private async paymentStepText(ctx: BotContext): Promise<string> {
    const base = this.base(ctx);
    const surcharge = await this.surcharge(ctx);
    const lines = ['*💰 PAGO*', ''];

    if (surcharge.greaterThan(0)) {
      lines.push(
        `Productos: ${amount(base)}`,
        `Recargo por tarjeta: ${amount(surcharge)}`,
        '',
      );
    }

    lines.push(`Total: *${amount(money(base.plus(surcharge)))}*`, '', '¿Cuánto te paga ahora?');

    return lines.join('\n');
  }

  private paymentKeyboard(): ReturnType<typeof Markup.inlineKeyboard> {
    return Markup.inlineKeyboard([
      [Markup.button.callback('💵 Paga todo', 'sale:pay:full')],
      [Markup.button.callback('🧮 Paga una parte', 'sale:pay:partial')],
      [Markup.button.callback('💳 Todo a crédito', 'sale:pay:none')],
      [Markup.button.callback('💳 Cambiar forma de pago', 'sale:checkout')],
      [Markup.button.callback('❌ Cancelar', 'sale:cancel')],
    ]);
  }

  private cancelKeyboard(): ReturnType<typeof Markup.inlineKeyboard> {
    return Markup.inlineKeyboard([[Markup.button.callback('❌ Cancelar', 'sale:cancel')]]);
  }
}

export { formatLocalDate };
