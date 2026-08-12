import { Prisma } from '@prisma/client';
import { serialize } from './serialization.interceptor';

describe('serialize', () => {
  it('convierte Decimal a string sin perder precisión', () => {
    expect(serialize(new Prisma.Decimal('2600.00'))).toBe('2600');
    expect(serialize(new Prisma.Decimal('12345678901.99'))).toBe('12345678901.99');
  });

  it('convierte BigInt a string', () => {
    expect(serialize(1234567890123n)).toBe('1234567890123');
  });

  it('convierte Date a ISO 8601', () => {
    expect(serialize(new Date('2026-08-14T00:00:00.000Z'))).toBe('2026-08-14T00:00:00.000Z');
  });

  it('recorre objetos anidados y arreglos', () => {
    const sale = {
      id: 'abc',
      total: new Prisma.Decimal('2100.00'),
      customer: { telegramUserId: 987654321n },
      items: [{ unitPrice: new Prisma.Decimal('700.00'), quantity: 2 }],
    };

    expect(serialize(sale)).toEqual({
      id: 'abc',
      total: '2100',
      customer: { telegramUserId: '987654321' },
      items: [{ unitPrice: '700', quantity: 2 }],
    });
  });

  it('respeta null y undefined', () => {
    expect(serialize(null)).toBeNull();
    expect(serialize(undefined)).toBeUndefined();
    expect(serialize({ a: null })).toEqual({ a: null });
  });

  it('no altera valores primitivos', () => {
    expect(serialize('texto')).toBe('texto');
    expect(serialize(42)).toBe(42);
    expect(serialize(true)).toBe(true);
  });
});
