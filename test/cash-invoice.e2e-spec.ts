import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CashMovementType, MeasurementUnit, PaymentMethod, Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { CashService } from '../src/cash/cash.service';
import { PrismaService } from '../src/database/prisma.service';
import { InvoicesService } from '../src/invoices/invoices.service';
import { SalesService } from '../src/sales/sales.service';

describe('Caja y facturación (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cash: CashService;
  let sales: SalesService;
  let invoices: InvoicesService;

  let userId: string;
  let variantId: string;
  let customerId: string;

  async function resetDatabase(): Promise<void> {
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

  async function createFixtures(): Promise<void> {
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

    const product = await prisma.product.create({ data: { name: 'Summer Hammer' } });
    const variant = await prisma.productVariant.create({
      data: {
        productId: product.id,
        name: '30ml',
        unit: MeasurementUnit.ML,
        salePrice: new Prisma.Decimal('700.00'),
        costPrice: new Prisma.Decimal('245.20'),
        currentStock: new Prisma.Decimal(20),
      },
    });
    variantId = variant.id;

    const customer = await prisma.customer.create({
      data: { name: 'Juan Pérez', phone: '8091234567', identificationNumber: '001-1234567-8' },
    });
    customerId = customer.id;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    cash = app.get(CashService);
    sales = app.get(SalesService);
    invoices = app.get(InvoicesService);
  }, 60_000);

  beforeEach(async () => {
    await resetDatabase();
    await createFixtures();
  });

  afterAll(async () => {
    await resetDatabase();
    await app?.close();
  });

  describe('caja', () => {
    it('abre la caja con el efectivo inicial', async () => {
      const session = await cash.open('5000.00', userId);

      expect(session.status).toBe('OPEN');
      expect(session.openingAmount.toString()).toBe('5000');

      const summary = await cash.getSummary();
      expect(summary.expectedCash.toString()).toBe('5000');
    });

    it('impide abrir dos cajas a la vez', async () => {
      await cash.open('5000.00', userId);

      await expect(cash.open('1000.00', userId)).rejects.toThrow(/Ya hay una caja abierta/);
    });

    it('rechaza un efectivo inicial negativo', async () => {
      await expect(cash.open('-100', userId)).rejects.toThrow(/no puede ser negativo/);
    });

    it('calcula el efectivo esperado con entradas y salidas', async () => {
      await cash.open('5000.00', userId);

      await cash.registerMovement({
        type: CashMovementType.MANUAL_IN,
        amount: '10000.00',
        description: 'Ventas del día',
        userId,
      });
      await cash.registerMovement({
        type: CashMovementType.EXPENSE,
        amount: '400.00',
        description: 'Delivery',
        userId,
      });

      const summary = await cash.getSummary();
      expect(summary.totalIn.toString()).toBe('15000');
      expect(summary.totalOut.toString()).toBe('400');
      expect(summary.expectedCash.toString()).toBe('14600');
    });

    it('el escenario del requerimiento: esperado 14,600 y contado 14,550 dan -50', async () => {
      await cash.open('5000.00', userId);
      await cash.registerMovement({
        type: CashMovementType.MANUAL_IN,
        amount: '10000.00',
        userId,
      });
      await cash.registerMovement({ type: CashMovementType.EXPENSE, amount: '400.00', userId });

      const result = await cash.close('14550.00', userId, 'Faltó cambio');

      expect(result.expectedCash.toString()).toBe('14600');
      expect(result.session.actualCash?.toString()).toBe('14550');
      expect(result.difference.toString()).toBe('-50');
      expect(result.session.status).toBe('CLOSED');
    });

    it('registra sobrante cuando se cuenta de más', async () => {
      await cash.open('1000.00', userId);

      const result = await cash.close('1025.00', userId);

      expect(result.difference.toString()).toBe('25');
    });

    it('no permite cerrar si no hay caja abierta', async () => {
      await expect(cash.close('100.00', userId)).rejects.toThrow(/No hay ninguna caja abierta/);
    });

    it('no permite registrar movimientos sin caja abierta', async () => {
      await expect(
        cash.registerMovement({ type: CashMovementType.MANUAL_IN, amount: '100', userId }),
      ).rejects.toThrow(/No hay caja abierta/);
    });

    it('rechaza movimientos de importe cero', async () => {
      await cash.open('1000.00', userId);

      await expect(
        cash.registerMovement({ type: CashMovementType.MANUAL_IN, amount: '0', userId }),
      ).rejects.toThrow(/mayor que cero/);
    });

    it('permite abrir una caja nueva después de cerrar la anterior', async () => {
      await cash.open('1000.00', userId);
      await cash.close('1000.00', userId);

      const session = await cash.open('2000.00', userId);
      expect(session.status).toBe('OPEN');
    });

    it('deja auditoría de la apertura y el cierre', async () => {
      await cash.open('1000.00', userId);
      await cash.close('950.00', userId);

      const logs = await prisma.auditLog.findMany({
        where: { entity: 'CashSession' },
        orderBy: { createdAt: 'asc' },
      });

      expect(logs.map((log) => log.action)).toEqual(['cash.opened', 'cash.closed']);
    });
  });

  describe('factura PDF', () => {
    async function createSale(onCredit = false) {
      return sales.create(
        {
          customerId,
          items: [{ productVariantId: variantId, quantity: '2' }],
          payments: onCredit
            ? [{ amount: '500.00', method: PaymentMethod.CASH }]
            : [{ amount: '1400.00', method: PaymentMethod.CASH }],
          ...(onCredit ? { dueDate: '2026-09-14' } : {}),
        },
        userId,
      );
    }

    it('genera un PDF válido y lo guarda en el almacenamiento', async () => {
      const sale = await createSale();
      const invoice = await invoices.findBySale(sale.id);

      const { buffer, filename } = await invoices.getPdf(invoice.id);

      // Un PDF siempre empieza por %PDF-
      expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
      expect(buffer.length).toBeGreaterThan(1000);
      expect(filename).toBe(`${invoice.number}.pdf`);

      const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(stored.pdfStorageKey).toContain('invoices/');
      expect(stored.pdfSizeBytes).toBe(buffer.length);
      expect(stored.pdfChecksum).toHaveLength(64);
    });

    it('reutiliza el PDF ya generado', async () => {
      const sale = await createSale();
      const invoice = await invoices.findBySale(sale.id);

      const first = await invoices.getPdf(invoice.id);
      const second = await invoices.getPdf(invoice.id);

      expect(second.buffer.equals(first.buffer)).toBe(true);
    });

    it('genera el PDF de una venta a crédito con saldo pendiente', async () => {
      const sale = await createSale(true);
      const invoice = await invoices.findBySale(sale.id);

      expect(invoice.pendingAmount.toString()).toBe('900');

      const { buffer } = await invoices.getPdf(invoice.id);
      expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('anula la factura dejando el motivo y la auditoría', async () => {
      const sale = await createSale();
      const invoice = await invoices.findBySale(sale.id);

      const cancelled = await invoices.cancel(invoice.id, 'Datos incorrectos', userId);

      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.cancellationReason).toBe('Datos incorrectos');

      const log = await prisma.auditLog.findFirst({
        where: { entity: 'Invoice', entityId: invoice.id },
      });
      expect(log?.action).toBe('invoice.cancelled');
    });

    it('no permite anular dos veces', async () => {
      const sale = await createSale();
      const invoice = await invoices.findBySale(sale.id);

      await invoices.cancel(invoice.id, 'Primera', userId);
      await expect(invoices.cancel(invoice.id, 'Segunda', userId)).rejects.toThrow(
        /ya estaba anulada/,
      );
    });

    it('genera el PDF de una factura anulada sin fallar', async () => {
      const sale = await createSale();
      const invoice = await invoices.findBySale(sale.id);
      await invoices.cancel(invoice.id, 'Anulada', userId);

      const { buffer } = await invoices.getPdf(invoice.id, true);
      expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    });
  });
});
