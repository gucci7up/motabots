import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  CreditStatus,
  InvoiceStatus,
  MeasurementUnit,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  SaleStatus,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { CreditsService } from '../src/credits/credits.service';
import { CustomersService } from '../src/customers/customers.service';
import { PrismaService } from '../src/database/prisma.service';
import { SalesService } from '../src/sales/sales.service';

/**
 * Pruebas de integración de las operaciones que mueven dinero e inventario.
 * Corren contra el esquema aislado de TEST_DATABASE_URL.
 */
describe('Ventas, créditos e inventario (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sales: SalesService;
  let credits: CreditsService;
  let customers: CustomersService;

  let userId: string;
  let variantId: string;
  let customerId: string;

  const PRICE = '800.00';
  const COST = '245.20';

  async function resetDatabase(): Promise<void> {
    // El orden respeta las claves foráneas; TRUNCATE CASCADE lo resuelve de una vez.
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE
        accounting_entries, audit_logs, payments, credit_accounts, invoices,
        sale_items, sales, inventory_movements, product_variants, products,
        categories, customers, cash_movements, cash_sessions, expenses,
        invoice_sequences, users, role_permissions, permissions, roles,
        telegram_updates, settings
      RESTART IDENTITY CASCADE
    `);
  }

  async function createFixtures(stock = 10): Promise<void> {
    const role = await prisma.role.create({ data: { name: 'ADMIN', isSystem: true } });
    const user = await prisma.user.create({
      data: { telegramUserId: BigInt(Date.now()), roleId: role.id },
    });
    userId = user.id;

    await prisma.invoiceSequence.createMany({
      data: [
        { series: 'DEFAULT', prefix: 'MP', format: '{PREFIX}-{YYYY}-{SEQ}', nextNumber: 1, padding: 6 },
        { series: 'SALE', prefix: 'V', format: '{PREFIX}-{SEQ}', nextNumber: 1, padding: 6 },
      ],
    });

    const category = await prisma.category.create({ data: { name: 'Perfumes' } });
    const product = await prisma.product.create({
      data: { name: 'Summer Hammer', categoryId: category.id },
    });
    const variant = await prisma.productVariant.create({
      data: {
        productId: product.id,
        name: '30ml',
        size: '30',
        unit: MeasurementUnit.ML,
        salePrice: new Prisma.Decimal(PRICE),
        costPrice: new Prisma.Decimal(COST),
        currentStock: new Prisma.Decimal(stock),
        minimumStock: new Prisma.Decimal(1),
      },
    });
    variantId = variant.id;

    const customer = await prisma.customer.create({ data: { name: 'Juan Pérez', phone: '8091234567' } });
    customerId = customer.id;
  }

  async function stockOf(id = variantId): Promise<string> {
    const variant = await prisma.productVariant.findUniqueOrThrow({ where: { id } });
    return variant.currentStock.toString();
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    sales = app.get(SalesService);
    credits = app.get(CreditsService);
    customers = app.get(CustomersService);
  }, 60_000);

  beforeEach(async () => {
    await resetDatabase();
    await createFixtures();
  });

  afterAll(async () => {
    await resetDatabase();
    await app?.close();
  });

  describe('venta pagada completa', () => {
    it('marca PAID, descuenta inventario y emite factura pagada', async () => {
      const sale = await sales.create(
        {
          customerId,
          items: [{ productVariantId: variantId, quantity: '2' }],
          payments: [{ amount: '1600.00', method: PaymentMethod.CASH }],
        },
        userId,
      );

      expect(sale.total.toString()).toBe('1600');
      expect(sale.paidAmount.toString()).toBe('1600');
      expect(sale.pendingAmount.toString()).toBe('0');
      expect(sale.paymentStatus).toBe(PaymentStatus.PAID);
      expect(sale.saleStatus).toBe(SaleStatus.COMPLETED);
      expect(sale.invoice?.status).toBe(InvoiceStatus.PAID);
      expect(sale.creditAccount).toBeNull();

      expect(await stockOf()).toBe('8');
    });

    it('numera la factura con el formato configurado', async () => {
      const sale = await sales.create(
        {
          items: [{ productVariantId: variantId, quantity: '1' }],
          payments: [{ amount: PRICE, method: PaymentMethod.CASH }],
        },
        userId,
      );

      const year = new Date().getFullYear();
      expect(sale.invoice?.number).toBe(`MP-${year}-000001`);
      expect(sale.saleNumber).toBe('V-000001');
    });

    it('el consecutivo avanza entre ventas', async () => {
      await sales.create(
        {
          items: [{ productVariantId: variantId, quantity: '1' }],
          payments: [{ amount: PRICE, method: PaymentMethod.CASH }],
        },
        userId,
      );
      const second = await sales.create(
        {
          items: [{ productVariantId: variantId, quantity: '1' }],
          payments: [{ amount: PRICE, method: PaymentMethod.CASH }],
        },
        userId,
      );

      expect(second.saleNumber).toBe('V-000002');
      expect(second.invoice?.number).toContain('000002');
    });

    it('registra el movimiento de inventario con stock antes y después', async () => {
      const sale = await sales.create(
        {
          items: [{ productVariantId: variantId, quantity: '3' }],
          payments: [{ amount: '2400.00', method: PaymentMethod.CASH }],
        },
        userId,
      );

      const movements = await prisma.inventoryMovement.findMany({
        where: { referenceId: sale.id },
      });

      expect(movements).toHaveLength(1);
      expect(movements[0].direction).toBe('OUT');
      expect(movements[0].stockBefore.toString()).toBe('10');
      expect(movements[0].stockAfter.toString()).toBe('7');
    });
  });

  describe('venta parcial', () => {
    it('el escenario del requerimiento: RD$2,600 con RD$1,000 de inicial', async () => {
      const sale = await sales.create(
        {
          customerId,
          items: [
            { productVariantId: variantId, quantity: '3', unitPrice: '800.00' },
            { productVariantId: variantId, quantity: '1', unitPrice: '200.00' },
          ],
          payments: [{ amount: '1000.00', method: PaymentMethod.CASH }],
          dueDate: '2026-08-27',
        },
        userId,
      );

      expect(sale.total.toString()).toBe('2600');
      expect(sale.paidAmount.toString()).toBe('1000');
      expect(sale.pendingAmount.toString()).toBe('1600');
      expect(sale.paymentStatus).toBe(PaymentStatus.PARTIAL);
      expect(sale.creditAccount?.balance.toString()).toBe('1600');
      expect(sale.creditAccount?.status).toBe(CreditStatus.PENDING);
      expect(sale.invoice?.status).toBe(InvoiceStatus.PARTIAL);
    });
  });

  describe('venta a crédito', () => {
    it('sin pago inicial queda en CREDIT con el total pendiente', async () => {
      const sale = await sales.create(
        {
          customerId,
          items: [{ productVariantId: variantId, quantity: '2' }],
          dueDate: '2026-09-01',
        },
        userId,
      );

      expect(sale.paymentStatus).toBe(PaymentStatus.CREDIT);
      expect(sale.pendingAmount.toString()).toBe('1600');
      expect(sale.creditAccount?.originalAmount.toString()).toBe('1600');
      expect(sale.invoice?.status).toBe(InvoiceStatus.CREDIT);
    });

    it('exige cliente: no se puede fiar a un desconocido', async () => {
      await expect(
        sales.create({ items: [{ productVariantId: variantId, quantity: '1' }] }, userId),
      ).rejects.toThrow(/necesita un cliente/);
    });

    it('usa los días de vencimiento por defecto si no se indica fecha', async () => {
      const sale = await sales.create(
        { customerId, items: [{ productVariantId: variantId, quantity: '1' }] },
        userId,
      );

      const dueDate = sale.creditAccount!.dueDate;
      const days = Math.round((dueDate.getTime() - Date.now()) / 86_400_000);
      expect(days).toBeGreaterThanOrEqual(14);
      expect(days).toBeLessThanOrEqual(15);
    });

    it('respeta el límite de crédito del cliente', async () => {
      await prisma.customer.update({
        where: { id: customerId },
        data: { creditLimit: new Prisma.Decimal('1000.00') },
      });

      await expect(
        sales.create(
          { customerId, items: [{ productVariantId: variantId, quantity: '2' }] },
          userId,
        ),
      ).rejects.toThrow(/límite/);

      // Y la venta rechazada no dejó rastro: el inventario sigue intacto.
      expect(await stockOf()).toBe('10');
    });
  });

  describe('abonos', () => {
    async function saleOnCredit() {
      return sales.create(
        {
          customerId,
          items: [{ productVariantId: variantId, quantity: '2' }],
          payments: [{ amount: '400.00', method: PaymentMethod.CASH }],
          dueDate: '2026-09-01',
        },
        userId,
      );
    }

    it('el abono reduce el saldo y deja el crédito en PARTIAL', async () => {
      const sale = await saleOnCredit();

      const result = await credits.registerInstallment({
        creditAccountId: sale.creditAccount!.id,
        amount: '500.00',
        method: PaymentMethod.CASH,
        userId,
      });

      expect(result.credit.balance.toString()).toBe('700');
      expect(result.credit.status).toBe(CreditStatus.PARTIAL);
      expect(result.fullyPaid).toBe(false);
    });

    it('el saldo del cliente refleja el abono', async () => {
      const sale = await saleOnCredit();

      await credits.registerInstallment({
        creditAccountId: sale.creditAccount!.id,
        amount: '500.00',
        method: PaymentMethod.CASH,
        userId,
      });

      const balance = await customers.getBalance(customerId);
      expect(balance.balance.toString()).toBe('700');
    });

    it('al saldar, el crédito, la venta y la factura quedan pagados', async () => {
      const sale = await saleOnCredit();

      await credits.registerInstallment({
        creditAccountId: sale.creditAccount!.id,
        amount: '500.00',
        method: PaymentMethod.CASH,
        userId,
      });
      const final = await credits.registerInstallment({
        creditAccountId: sale.creditAccount!.id,
        amount: '700.00',
        method: PaymentMethod.BANK_TRANSFER,
        reference: 'TRF-991',
        userId,
      });

      expect(final.fullyPaid).toBe(true);
      expect(final.credit.status).toBe(CreditStatus.PAID);
      expect(final.credit.balance.toString()).toBe('0');

      const updated = await sales.findById(sale.id);
      expect(updated.paymentStatus).toBe(PaymentStatus.PAID);
      expect(updated.pendingAmount.toString()).toBe('0');
      expect(updated.invoice?.status).toBe(InvoiceStatus.PAID);

      const balance = await customers.getBalance(customerId);
      expect(balance.balance.toString()).toBe('0');
    });

    it('rechaza un abono mayor que el saldo', async () => {
      const sale = await saleOnCredit();

      await expect(
        credits.registerInstallment({
          creditAccountId: sale.creditAccount!.id,
          amount: '5000.00',
          method: PaymentMethod.CASH,
          userId,
        }),
      ).rejects.toThrow(/supera el saldo/);
    });

    it('rechaza un abono de cero o negativo', async () => {
      const sale = await saleOnCredit();

      await expect(
        credits.registerInstallment({
          creditAccountId: sale.creditAccount!.id,
          amount: '0',
          method: PaymentMethod.CASH,
          userId,
        }),
      ).rejects.toThrow(/mayor que cero/);
    });

    it('rechaza abonar a un crédito ya saldado', async () => {
      const sale = await saleOnCredit();
      const creditId = sale.creditAccount!.id;

      await credits.registerInstallment({
        creditAccountId: creditId,
        amount: '1200.00',
        method: PaymentMethod.CASH,
        userId,
      });

      await expect(
        credits.registerInstallment({
          creditAccountId: creditId,
          amount: '100.00',
          method: PaymentMethod.CASH,
          userId,
        }),
      ).rejects.toThrow(/ya está saldado/);
    });
  });

  describe('stock', () => {
    it('impide vender más de lo que hay', async () => {
      await expect(
        sales.create(
          {
            items: [{ productVariantId: variantId, quantity: '11' }],
            payments: [{ amount: '8800.00', method: PaymentMethod.CASH }],
          },
          userId,
        ),
      ).rejects.toThrow(/Stock insuficiente/);
    });

    it('una venta rechazada por stock no crea nada: rollback completo', async () => {
      await expect(
        sales.create(
          {
            items: [{ productVariantId: variantId, quantity: '99' }],
            payments: [{ amount: '79200.00', method: PaymentMethod.CASH }],
          },
          userId,
        ),
      ).rejects.toThrow();

      expect(await prisma.sale.count()).toBe(0);
      expect(await prisma.invoice.count()).toBe(0);
      expect(await prisma.payment.count()).toBe(0);
      expect(await prisma.inventoryMovement.count()).toBe(0);
      expect(await stockOf()).toBe('10');
    });

    it('permite vender exactamente todo el stock', async () => {
      const sale = await sales.create(
        {
          items: [{ productVariantId: variantId, quantity: '10' }],
          payments: [{ amount: '8000.00', method: PaymentMethod.CASH }],
        },
        userId,
      );

      expect(sale.saleStatus).toBe(SaleStatus.COMPLETED);
      expect(await stockOf()).toBe('0');
    });
  });

  describe('concurrencia', () => {
    async function setStock(units: number): Promise<void> {
      await prisma.productVariant.update({
        where: { id: variantId },
        data: { currentStock: new Prisma.Decimal(units) },
      });
    }

    function sellOne() {
      return sales.create(
        {
          items: [{ productVariantId: variantId, quantity: '1' }],
          payments: [{ amount: PRICE, method: PaymentMethod.CASH }],
        },
        userId,
      );
    }

    it('dos ventas simultáneas de la última unidad: sólo una se completa', async () => {
      await setStock(1);

      const results = await Promise.allSettled([sellOne(), sellOne()]);

      const completed = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');

      expect(completed).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      expect(await prisma.sale.count()).toBe(1);
      expect(await stockOf()).toBe('0');
    });

    it('cinco ventas simultáneas con tres unidades: se completan exactamente tres', async () => {
      await setStock(3);

      const results = await Promise.allSettled([
        sellOne(),
        sellOne(),
        sellOne(),
        sellOne(),
        sellOne(),
      ]);

      const completed = results.filter((result) => result.status === 'fulfilled');

      expect(completed).toHaveLength(3);
      expect(await prisma.sale.count()).toBe(3);
      expect(await stockOf()).toBe('0');
    }, 60_000);

    it('el inventario nunca queda negativo bajo concurrencia', async () => {
      await setStock(2);

      await Promise.allSettled([sellOne(), sellOne(), sellOne(), sellOne()]);

      const variant = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } });
      expect(variant.currentStock.greaterThanOrEqualTo(0)).toBe(true);
    }, 60_000);

    it('los movimientos de inventario cuadran con el stock final', async () => {
      await setStock(3);

      await Promise.allSettled([sellOne(), sellOne(), sellOne(), sellOne(), sellOne()]);

      const movements = await prisma.inventoryMovement.findMany({
        where: { productVariantId: variantId },
      });
      const sold = movements.reduce(
        (acc, movement) => acc.plus(movement.quantity),
        new Prisma.Decimal(0),
      );

      // Se partió de 3 unidades: lo vendido más lo que queda tiene que dar 3.
      const variant = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } });
      expect(sold.plus(variant.currentStock).toString()).toBe('3');
    }, 60_000);

    it('cada venta simultánea obtiene un número distinto', async () => {
      await setStock(3);

      await Promise.allSettled([sellOne(), sellOne(), sellOne()]);

      const sales = await prisma.sale.findMany();
      const numbers = new Set(sales.map((sale) => sale.saleNumber));
      const invoices = await prisma.invoice.findMany();
      const invoiceNumbers = new Set(invoices.map((invoice) => invoice.number));

      expect(numbers.size).toBe(sales.length);
      expect(invoiceNumbers.size).toBe(invoices.length);
    }, 60_000);

    it('dos abonos simultáneos no dejan el saldo del crédito inconsistente', async () => {
      const sale = await sales.create(
        {
          customerId,
          items: [{ productVariantId: variantId, quantity: '2' }],
          dueDate: '2026-09-01',
        },
        userId,
      );
      const creditId = sale.creditAccount!.id;

      const pay = (value: string) =>
        credits.registerInstallment({
          creditAccountId: creditId,
          amount: value,
          method: PaymentMethod.CASH,
          userId,
        });

      // 1000 + 1000 = 1600 no cabe: el saldo es 1600, así que uno de los dos debe fallar
      // o quedar el saldo exacto. Lo que no puede pasar es un saldo negativo.
      await Promise.allSettled([pay('1000.00'), pay('1000.00')]);

      const credit = await prisma.creditAccount.findUniqueOrThrow({ where: { id: creditId } });
      const payments = await prisma.payment.findMany({ where: { creditAccountId: creditId } });
      const collected = payments.reduce(
        (acc, payment) => acc.plus(payment.amount),
        new Prisma.Decimal(0),
      );

      expect(credit.balance.greaterThanOrEqualTo(0)).toBe(true);
      expect(credit.paidAmount.toString()).toBe(collected.toString());
      expect(credit.balance.toString()).toBe(
        credit.originalAmount.minus(credit.paidAmount).toString(),
      );
    }, 60_000);
  });

  describe('cancelación', () => {
    it('devuelve el inventario y anula factura y crédito', async () => {
      const sale = await sales.create(
        {
          customerId,
          items: [{ productVariantId: variantId, quantity: '2' }],
          payments: [{ amount: '600.00', method: PaymentMethod.CASH }],
          dueDate: '2026-09-01',
        },
        userId,
      );

      expect(await stockOf()).toBe('8');

      const cancelled = await sales.cancel(sale.id, 'Cliente devolvió el producto', userId);

      expect(cancelled.saleStatus).toBe(SaleStatus.CANCELLED);
      expect(cancelled.cancellationReason).toBe('Cliente devolvió el producto');
      expect(cancelled.invoice?.status).toBe(InvoiceStatus.CANCELLED);
      expect(cancelled.creditAccount?.status).toBe(CreditStatus.CANCELLED);
      // El saldo histórico se conserva; lo que anula la deuda es el estado CANCELLED.
      expect(cancelled.creditAccount?.balance.toString()).toBe('1000');

      expect(await stockOf()).toBe('10');
    });

    it('revierte el pago con un pago de reversión, sin borrar el original', async () => {
      const sale = await sales.create(
        {
          customerId,
          items: [{ productVariantId: variantId, quantity: '1' }],
          payments: [{ amount: PRICE, method: PaymentMethod.CASH }],
        },
        userId,
      );

      await sales.cancel(sale.id, 'Error de digitación', userId);

      const payments = await prisma.payment.findMany({ where: { saleId: sale.id } });
      expect(payments).toHaveLength(2);

      const original = payments.find((p) => !p.isReversal);
      const reversal = payments.find((p) => p.isReversal);
      expect(original?.amount.toString()).toBe('800');
      expect(reversal?.amount.toString()).toBe('-800');
      expect(reversal?.reversedPaymentId).toBe(original?.id);
    });

    it('crea el movimiento de inventario inverso, no borra el original', async () => {
      const sale = await sales.create(
        {
          items: [{ productVariantId: variantId, quantity: '2' }],
          payments: [{ amount: '1600.00', method: PaymentMethod.CASH }],
        },
        userId,
      );

      await sales.cancel(sale.id, 'Devolución', userId);

      const movements = await prisma.inventoryMovement.findMany({
        orderBy: { createdAt: 'asc' },
      });
      expect(movements).toHaveLength(2);
      expect(movements[0].type).toBe('SALE');
      expect(movements[1].type).toBe('SALE_CANCELLATION');
      expect(movements[1].direction).toBe('IN');
    });

    it('no permite cancelar dos veces', async () => {
      const sale = await sales.create(
        {
          items: [{ productVariantId: variantId, quantity: '1' }],
          payments: [{ amount: PRICE, method: PaymentMethod.CASH }],
        },
        userId,
      );

      await sales.cancel(sale.id, 'Primera', userId);
      await expect(sales.cancel(sale.id, 'Segunda', userId)).rejects.toThrow(/ya estaba cancelada/);
    });

    it('la venta cancelada deja de contar en el saldo del cliente', async () => {
      const sale = await sales.create(
        { customerId, items: [{ productVariantId: variantId, quantity: '2' }] },
        userId,
      );

      expect((await customers.getBalance(customerId)).balance.toString()).toBe('1600');

      await sales.cancel(sale.id, 'Anulada', userId);

      expect((await customers.getBalance(customerId)).balance.toString()).toBe('0');
    });
  });

  describe('snapshots de precio y costo', () => {
    it('cambiar el precio del producto no altera las ventas pasadas', async () => {
      const sale = await sales.create(
        {
          items: [{ productVariantId: variantId, quantity: '2' }],
          payments: [{ amount: '1600.00', method: PaymentMethod.CASH }],
        },
        userId,
      );

      await prisma.productVariant.update({
        where: { id: variantId },
        data: {
          salePrice: new Prisma.Decimal('1200.00'),
          costPrice: new Prisma.Decimal('400.00'),
        },
      });

      const stored = await sales.findById(sale.id);
      expect(stored.items[0].unitPrice.toString()).toBe('800');
      expect(stored.items[0].unitCostSnapshot.toString()).toBe('245.2');
      expect(stored.total.toString()).toBe('1600');
    });

    it('la utilidad se calcula desde el snapshot de costo', async () => {
      await sales.create(
        {
          items: [{ productVariantId: variantId, quantity: '2' }],
          payments: [{ amount: '1600.00', method: PaymentMethod.CASH }],
        },
        userId,
      );

      await prisma.productVariant.update({
        where: { id: variantId },
        data: { costPrice: new Prisma.Decimal('700.00') },
      });

      const items = await prisma.saleItem.findMany();
      const revenue = items.reduce((acc, item) => acc.plus(item.total), new Prisma.Decimal(0));
      const cogs = items.reduce(
        (acc, item) => acc.plus(item.quantity.times(item.unitCostSnapshot)),
        new Prisma.Decimal(0),
      );

      expect(revenue.toString()).toBe('1600');
      expect(cogs.toFixed(2)).toBe('490.40');
      expect(revenue.minus(cogs).toFixed(2)).toBe('1109.60');
    });
  });

  describe('idempotencia', () => {
    it('confirmar dos veces la misma venta no la duplica', async () => {
      const dto = {
        customerId,
        items: [{ productVariantId: variantId, quantity: '1' }],
        payments: [{ amount: PRICE, method: PaymentMethod.CASH }],
        idempotencyKey: 'carrito-abc-123',
      };

      const first = await sales.create(dto, userId);
      const second = await sales.create(dto, userId);

      expect(second.id).toBe(first.id);
      expect(await prisma.sale.count()).toBe(1);
      expect(await stockOf()).toBe('9');
    });
  });

  describe('validaciones de importes', () => {
    it('rechaza un pago mayor que el total', async () => {
      await expect(
        sales.create(
          {
            items: [{ productVariantId: variantId, quantity: '1' }],
            payments: [{ amount: '5000.00', method: PaymentMethod.CASH }],
          },
          userId,
        ),
      ).rejects.toThrow(/supera el total/);
    });

    it('rechaza un descuento mayor que el subtotal', async () => {
      await expect(
        sales.create(
          {
            items: [{ productVariantId: variantId, quantity: '1' }],
            discount: '5000.00',
          },
          userId,
        ),
      ).rejects.toThrow(/no puede superar el total/);
    });

    it('aplica el descuento global al total', async () => {
      const sale = await sales.create(
        {
          items: [{ productVariantId: variantId, quantity: '2' }],
          discount: '100.00',
          payments: [{ amount: '1500.00', method: PaymentMethod.CASH }],
        },
        userId,
      );

      expect(sale.subtotal.toString()).toBe('1600');
      expect(sale.discount.toString()).toBe('100');
      expect(sale.total.toString()).toBe('1500');
      expect(sale.paymentStatus).toBe(PaymentStatus.PAID);
    });
  });

  describe('contabilidad', () => {
    it('una venta a crédito genera ingreso, costo y crédito otorgado', async () => {
      const sale = await sales.create(
        {
          customerId,
          items: [{ productVariantId: variantId, quantity: '2' }],
          payments: [{ amount: '600.00', method: PaymentMethod.CASH }],
        },
        userId,
      );

      const entries = await prisma.accountingEntry.findMany({ where: { referenceId: sale.id } });
      const byType = new Map(entries.map((entry) => [entry.type, entry.amount.toString()]));

      expect(byType.get('REVENUE')).toBe('1600');
      expect(byType.get('COST_OF_GOODS_SOLD')).toBe('490.4');
      expect(byType.get('CREDIT_ISSUED')).toBe('1000');
    });

    it('la cancelación genera asientos inversos', async () => {
      const sale = await sales.create(
        {
          items: [{ productVariantId: variantId, quantity: '1' }],
          payments: [{ amount: PRICE, method: PaymentMethod.CASH }],
        },
        userId,
      );

      await sales.cancel(sale.id, 'Anulada', userId);

      const reversals = await prisma.accountingEntry.findMany({
        where: { referenceType: 'SALE_CANCELLATION' },
      });

      expect(reversals).toHaveLength(2);
      expect(reversals.some((entry) => entry.amount.toString() === '-800')).toBe(true);
    });
  });

  describe('auditoría', () => {
    it('registra la venta y su cancelación', async () => {
      const sale = await sales.create(
        {
          items: [{ productVariantId: variantId, quantity: '1' }],
          payments: [{ amount: PRICE, method: PaymentMethod.CASH }],
        },
        userId,
      );
      await sales.cancel(sale.id, 'Prueba', userId);

      const logs = await prisma.auditLog.findMany({
        where: { entity: 'Sale', entityId: sale.id },
        orderBy: { createdAt: 'asc' },
      });

      expect(logs.map((log) => log.action)).toEqual(['sale.created', 'sale.cancelled']);
      expect(logs[0].userId).toBe(userId);
    });
  });
});
