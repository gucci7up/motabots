import { Prisma } from '@prisma/client';

/**
 * Utilidades monetarias. Todo el dinero del sistema pasa por aquí.
 *
 * Regla: nunca `number` para dinero. El punto flotante binario no representa 0.10 ni 0.20
 * exactamente, y sumar centavos mil veces produce diferencias reales en caja.
 */

export type Money = Prisma.Decimal;

/** Escala de importes (RD$ con centavos). */
export const MONEY_SCALE = 2;
/** Escala de costos unitarios: más precisión para no perder centavos al promediar. */
export const COST_SCALE = 4;
/** Escala de cantidades: permite fracciones (decantados, ml sueltos). */
export const QUANTITY_SCALE = 3;

export type MoneyInput = Prisma.Decimal | number | string;

/** Construye un Decimal a partir de un valor de entrada. Rechaza valores no finitos. */
export function toDecimal(value: MoneyInput): Prisma.Decimal {
  const decimal = new Prisma.Decimal(value);
  if (!decimal.isFinite()) {
    throw new TypeError(`Valor monetario inválido: ${String(value)}`);
  }
  return decimal;
}

/** Redondea a la escala de importes con ROUND_HALF_UP (redondeo comercial). */
export function money(value: MoneyInput): Prisma.Decimal {
  return toDecimal(value).toDecimalPlaces(MONEY_SCALE, Prisma.Decimal.ROUND_HALF_UP);
}

/** Redondea a la escala de costos unitarios. */
export function cost(value: MoneyInput): Prisma.Decimal {
  return toDecimal(value).toDecimalPlaces(COST_SCALE, Prisma.Decimal.ROUND_HALF_UP);
}

/** Redondea a la escala de cantidades. */
export function quantity(value: MoneyInput): Prisma.Decimal {
  return toDecimal(value).toDecimalPlaces(QUANTITY_SCALE, Prisma.Decimal.ROUND_HALF_UP);
}

export const ZERO = money(0);

/** Suma una lista de importes, redondeando el resultado a centavos. */
export function sum(values: readonly MoneyInput[]): Prisma.Decimal {
  return money(
    values.reduce<Prisma.Decimal>((acc, value) => acc.plus(toDecimal(value)), new Prisma.Decimal(0)),
  );
}

/** Multiplica cantidad × precio unitario y redondea a centavos. */
export function multiply(a: MoneyInput, b: MoneyInput): Prisma.Decimal {
  return money(toDecimal(a).times(toDecimal(b)));
}

export function isZero(value: MoneyInput): boolean {
  return toDecimal(value).isZero();
}

export function isNegative(value: MoneyInput): boolean {
  return toDecimal(value).isNegative();
}

export function isPositive(value: MoneyInput): boolean {
  return toDecimal(value).greaterThan(0);
}

export function equals(a: MoneyInput, b: MoneyInput): boolean {
  return toDecimal(a).equals(toDecimal(b));
}

export function greaterThan(a: MoneyInput, b: MoneyInput): boolean {
  return toDecimal(a).greaterThan(toDecimal(b));
}

/**
 * Formatea un importe para mostrarlo al usuario.
 * Ejemplo: formatMoney(2600) → "RD$2,600.00"
 */
export function formatMoney(value: MoneyInput, symbol = 'RD$'): string {
  const decimal = money(value);
  const negative = decimal.isNegative();
  const [integerPart, decimalPart] = decimal.abs().toFixed(MONEY_SCALE).split('.');
  const grouped = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${symbol}${grouped}.${decimalPart}`;
}

/**
 * Formatea una cantidad quitando los decimales sobrantes.
 * Ejemplo: formatQuantity(2.000) → "2"
 */
export function formatQuantity(value: MoneyInput): string {
  return quantity(value).toDecimalPlaces(QUANTITY_SCALE).toString();
}
