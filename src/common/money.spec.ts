import { Prisma } from '@prisma/client';
import {
  cost,
  formatMoney,
  formatQuantity,
  greaterThan,
  isNegative,
  isZero,
  money,
  multiply,
  quantity,
  sum,
  toDecimal,
} from './money';

describe('money', () => {
  it('no pierde centavos donde el punto flotante sí lo haría', () => {
    // 0.1 + 0.2 === 0.30000000000000004 en aritmética de punto flotante
    expect(sum([0.1, 0.2]).toString()).toBe('0.3');
  });

  it('suma mil centavos sin acumular error', () => {
    const values = Array.from({ length: 1000 }, () => '0.01');
    expect(sum(values).toString()).toBe('10');
  });

  it('redondea a centavos con ROUND_HALF_UP', () => {
    expect(money('2.005').toString()).toBe('2.01');
    expect(money('2.004').toString()).toBe('2');
    expect(money('-2.005').toString()).toBe('-2.01');
  });

  it('mantiene cuatro decimales en costos unitarios', () => {
    expect(cost('12.34567').toString()).toBe('12.3457');
  });

  it('mantiene tres decimales en cantidades', () => {
    expect(quantity('2.0004').toString()).toBe('2');
    expect(quantity('0.3335').toString()).toBe('0.334');
  });

  it('multiplica cantidad por precio redondeando a centavos', () => {
    expect(multiply(3, '233.333').toString()).toBe('700');
    expect(multiply(2, 700).toString()).toBe('1400');
  });

  it('rechaza valores no finitos', () => {
    expect(() => toDecimal(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => toDecimal(Number.NaN)).toThrow(TypeError);
  });

  it('rechaza valores no numéricos', () => {
    expect(() => toDecimal('mil pesos')).toThrow();
  });

  it('acepta Prisma.Decimal como entrada', () => {
    expect(money(new Prisma.Decimal('1500.5')).toString()).toBe('1500.5');
  });

  describe('predicados', () => {
    it('detecta cero, negativos y comparaciones', () => {
      expect(isZero(0)).toBe(true);
      expect(isZero('0.00')).toBe(true);
      expect(isNegative('-0.01')).toBe(true);
      expect(greaterThan('1100.01', '1100')).toBe(true);
      expect(greaterThan('1100', '1100')).toBe(false);
    });
  });

  describe('formatMoney', () => {
    it('formatea con separador de miles y dos decimales', () => {
      expect(formatMoney(2600)).toBe('RD$2,600.00');
      expect(formatMoney('1100.5')).toBe('RD$1,100.50');
      expect(formatMoney(0)).toBe('RD$0.00');
      expect(formatMoney(999)).toBe('RD$999.00');
      expect(formatMoney(1234567.891)).toBe('RD$1,234,567.89');
    });

    it('coloca el signo negativo antes del símbolo', () => {
      expect(formatMoney(-50)).toBe('-RD$50.00');
    });

    it('permite otro símbolo de moneda', () => {
      expect(formatMoney(20, '$')).toBe('$20.00');
    });
  });

  describe('formatQuantity', () => {
    it('quita los decimales sobrantes', () => {
      expect(formatQuantity('2.000')).toBe('2');
      expect(formatQuantity('2.500')).toBe('2.5');
    });
  });

  describe('escenario del requerimiento', () => {
    it('calcula el saldo de una venta a crédito con abonos', () => {
      const total = money(2600);
      const inicial = money(1000);
      let saldo = money(total.minus(inicial));
      expect(saldo.toString()).toBe('1600');

      saldo = money(saldo.minus(money(500)));
      expect(formatMoney(saldo)).toBe('RD$1,100.00');

      saldo = money(saldo.minus(money(1100)));
      expect(isZero(saldo)).toBe(true);
    });

    it('calcula la diferencia de un cierre de caja', () => {
      const esperado = money(14600);
      const contado = money(14550);
      expect(formatMoney(contado.minus(esperado))).toBe('-RD$50.00');
    });
  });
});
