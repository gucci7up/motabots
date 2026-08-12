import { Prisma } from '@prisma/client';
import { formatLocalDate } from '../common/date-range';
import { formatMoney, formatQuantity, money } from '../common/money';
import { escapeMarkdown } from './messages';
import type { CartLine } from './session/session.store';

/** Importe escapado para MarkdownV2 (el punto y el signo menos son caracteres reservados). */
export function amount(value: Prisma.Decimal | string | number, symbol = 'RD$'): string {
  return escapeMarkdown(formatMoney(value, symbol));
}

export function qty(value: Prisma.Decimal | string | number): string {
  return escapeMarkdown(formatQuantity(value));
}

export function date(value: Date): string {
  return escapeMarkdown(formatLocalDate(value));
}

export function percent(value: number): string {
  return escapeMarkdown(`${value.toFixed(1)}%`);
}

/** Días de atraso de una fecha de vencimiento. Negativo si aún no vence. */
export function daysOverdue(dueDate: Date): number {
  return Math.floor((Date.now() - dueDate.getTime()) / 86_400_000);
}

export function cartTotal(cart: readonly CartLine[]): Prisma.Decimal {
  return cart.reduce(
    (acc, line) => acc.plus(money(line.quantity).times(money(line.unitPrice))),
    new Prisma.Decimal(0),
  );
}

export function renderCart(cart: readonly CartLine[], customerName?: string): string {
  if (cart.length === 0) {
    return ['*🛒 CARRITO*', '', 'El carrito está vacío\\.'].join('\n');
  }

  const lines = cart.map(
    (line, index) =>
      `${index + 1}\\. ${qty(line.quantity)} × ${escapeMarkdown(line.description)}\n` +
      `    ${amount(money(line.quantity).times(money(line.unitPrice)))}`,
  );

  return [
    '*🛒 CARRITO*',
    customerName ? `Cliente: ${escapeMarkdown(customerName)}` : 'Sin cliente',
    '',
    ...lines,
    '',
    `*Total: ${amount(cartTotal(cart))}*`,
  ].join('\n');
}

export interface SaleSummaryData {
  storeName: string;
  customerName?: string;
  cart: readonly CartLine[];
  discount: Prisma.Decimal;
  /** Recargo por pago con tarjeta. */
  surcharge?: Prisma.Decimal;
  total: Prisma.Decimal;
  paid: Prisma.Decimal;
  pending: Prisma.Decimal;
  dueDate?: Date;
}

/** Resumen previo a confirmar la venta. Es la última pantalla antes de tocar la base. */
export function renderSaleSummary(data: SaleSummaryData): string {
  const lines = data.cart.map(
    (line) =>
      `${qty(line.quantity)} × ${escapeMarkdown(line.description)}\n` +
      `    ${amount(money(line.quantity).times(money(line.unitPrice)))}`,
  );

  const parts = [
    `*${escapeMarkdown(data.storeName.toUpperCase())}*`,
    '',
    `Cliente: ${escapeMarkdown(data.customerName ?? 'Sin cliente')}`,
    '',
    ...lines,
    '',
  ];

  if (data.discount.greaterThan(0)) {
    parts.push(`Descuento: ${amount(data.discount)}`);
  }

  if (data.surcharge?.greaterThan(0)) {
    parts.push(`Recargo por tarjeta: ${amount(data.surcharge)}`);
  }

  parts.push(`*Total: ${amount(data.total)}*`);
  parts.push(`Pago: ${amount(data.paid)}`);

  if (data.pending.greaterThan(0)) {
    parts.push(`*Crédito: ${amount(data.pending)}*`);
    if (data.dueDate) {
      parts.push(`Vencimiento: ${date(data.dueDate)}`);
    }
  }

  parts.push('', '¿Confirmar?');

  return parts.join('\n');
}

export function renderSaleReceipt(sale: {
  saleNumber: string;
  invoiceNumber?: string;
  total: Prisma.Decimal;
  paidAmount: Prisma.Decimal;
  pendingAmount: Prisma.Decimal;
  customerName?: string | null;
}): string {
  const parts = [
    '*✅ VENTA REGISTRADA*',
    '',
    `Venta: \`${escapeMarkdown(sale.saleNumber)}\``,
  ];

  if (sale.invoiceNumber) {
    parts.push(`Factura: \`${escapeMarkdown(sale.invoiceNumber)}\``);
  }
  if (sale.customerName) {
    parts.push(`Cliente: ${escapeMarkdown(sale.customerName)}`);
  }

  parts.push('', `Total: ${amount(sale.total)}`, `Pagado: ${amount(sale.paidAmount)}`);

  if (sale.pendingAmount.greaterThan(0)) {
    parts.push(`*Saldo pendiente: ${amount(sale.pendingAmount)}*`);
  }

  return parts.join('\n');
}
