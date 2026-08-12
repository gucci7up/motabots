import { Test } from '@nestjs/testing';
import { MeasurementUnit, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { DomainException } from '../common/exceptions/domain.exception';
import { PrismaService } from '../database/prisma.service';
import { ProductsService } from './products.service';

describe('ProductsService', () => {
  let service: ProductsService;

  const prisma = {
    product: { create: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), update: jest.fn() },
    productVariant: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    transaction: jest.fn(),
  };
  const audit = { record: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = moduleRef.get(ProductsService);
  });

  describe('create', () => {
    it('exige al menos una variante', async () => {
      await expect(
        service.create({ name: 'Black Opium', variants: [] }, null),
      ).rejects.toThrow(DomainException);
    });

    it('convierte precios y costos a Decimal sin perder centavos', async () => {
      prisma.product.create.mockResolvedValue({ id: 'p1', name: 'Black Opium', variants: [] });

      await service.create(
        {
          name: 'Black Opium Yves Saint Laurent',
          variants: [
            {
              name: '30ml',
              size: '30',
              unit: MeasurementUnit.ML,
              salePrice: '800.00',
              costPrice: '245.20',
            },
          ],
        },
        'u1',
      );

      const call = prisma.product.create.mock.calls[0][0] as {
        data: { variants: { create: { salePrice: Prisma.Decimal; costPrice: Prisma.Decimal }[] } };
      };
      const [variant] = call.data.variants.create;

      expect(variant.salePrice.toString()).toBe('800');
      expect(variant.costPrice.toString()).toBe('245.2');
    });

    it('rechaza un precio negativo', async () => {
      await expect(
        service.create(
          { name: 'X', variants: [{ name: '30ml', salePrice: '-1', costPrice: '10' }] },
          null,
        ),
      ).rejects.toThrow(/no puede ser negativo/);
    });

    it('rechaza un costo negativo', async () => {
      await expect(
        service.create(
          { name: 'X', variants: [{ name: '30ml', salePrice: '10', costPrice: '-1' }] },
          null,
        ),
      ).rejects.toThrow(/no puede ser negativo/);
    });

    it('registra auditoría de la creación', async () => {
      prisma.product.create.mockResolvedValue({ id: 'p1', name: 'X', variants: [{ id: 'v1' }] });

      await service.create(
        { name: 'X', variants: [{ name: '30ml', salePrice: '800', costPrice: '245.20' }] },
        'u1',
      );

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'product.created', entity: 'Product', userId: 'u1' }),
      );
    });

    it('usa UNIT como unidad por defecto cuando no se indica', async () => {
      prisma.product.create.mockResolvedValue({ id: 'p1', name: 'Gloss', variants: [] });

      await service.create(
        { name: 'Gloss', variants: [{ name: 'Único', salePrice: '350', costPrice: '100' }] },
        null,
      );

      const call = prisma.product.create.mock.calls[0][0] as {
        data: { variants: { create: { unit: MeasurementUnit }[] } };
      };
      expect(call.data.variants.create[0].unit).toBe(MeasurementUnit.UNIT);
    });
  });

  describe('updateVariant', () => {
    const existing = {
      id: 'v1',
      name: '30ml',
      salePrice: new Prisma.Decimal('800.00'),
      costPrice: new Prisma.Decimal('245.20'),
      minimumStock: new Prisma.Decimal('0'),
      isActive: true,
    };

    it('audita el precio anterior y el nuevo', async () => {
      prisma.productVariant.findUnique.mockResolvedValue(existing);
      prisma.productVariant.update.mockResolvedValue({
        ...existing,
        salePrice: new Prisma.Decimal('900.00'),
      });

      await service.updateVariant('v1', { salePrice: '900.00' }, 'u1');

      const entry = audit.record.mock.calls[0][0] as {
        before: { salePrice: Prisma.Decimal };
        after: { salePrice: Prisma.Decimal };
      };
      expect(entry.before.salePrice.toString()).toBe('800');
      expect(entry.after.salePrice.toString()).toBe('900');
    });

    it('sólo actualiza los campos enviados', async () => {
      prisma.productVariant.findUnique.mockResolvedValue(existing);
      prisma.productVariant.update.mockResolvedValue(existing);

      await service.updateVariant('v1', { salePrice: '900' }, null);

      const call = prisma.productVariant.update.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(Object.keys(call.data)).toEqual(['salePrice']);
    });

    it('falla si la variante no existe', async () => {
      prisma.productVariant.findUnique.mockResolvedValue(null);

      await expect(service.updateVariant('nope', { salePrice: '1' }, null)).rejects.toThrow(
        DomainException,
      );
    });
  });

  describe('search', () => {
    it('sin término devuelve el listado completo', async () => {
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(0);

      await service.search('   ', 1, 10);

      const call = prisma.product.findMany.mock.calls[0][0] as { where: { OR?: unknown } };
      expect(call.where.OR).toBeUndefined();
    });

    it('busca por nombre, marca, SKU y código de barras', async () => {
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(0);

      await service.search('opium', 1, 10);

      const call = prisma.product.findMany.mock.calls[0][0] as { where: { OR: unknown[] } };
      expect(call.where.OR).toHaveLength(5);
    });
  });

  describe('deactivate', () => {
    it('desactiva el producto y sus variantes, sin borrar nada', async () => {
      prisma.product.findUnique.mockResolvedValue({ id: 'p1', variants: [] });
      prisma.productVariant.updateMany.mockResolvedValue({ count: 2 });
      prisma.product.update.mockResolvedValue({ id: 'p1', isActive: false, variants: [] });

      await service.deactivate('p1', 'u1');

      expect(prisma.productVariant.updateMany).toHaveBeenCalledWith({
        where: { productId: 'p1' },
        data: { isActive: false },
      });
      expect(prisma.product.update).toHaveBeenCalled();
    });
  });
});
