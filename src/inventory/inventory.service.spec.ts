import { Test } from '@nestjs/testing';
import { InventoryMovementType, MovementDirection, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { DomainException } from '../common/exceptions/domain.exception';
import { PrismaService } from '../database/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { InventoryService, directionOf } from './inventory.service';

describe('directionOf', () => {
  it('las entradas suman stock', () => {
    expect(directionOf(InventoryMovementType.PURCHASE)).toBe(MovementDirection.IN);
    expect(directionOf(InventoryMovementType.INITIAL_STOCK)).toBe(MovementDirection.IN);
    expect(directionOf(InventoryMovementType.RETURN)).toBe(MovementDirection.IN);
    expect(directionOf(InventoryMovementType.ADJUSTMENT_IN)).toBe(MovementDirection.IN);
    // Cancelar una venta devuelve la mercancía al inventario
    expect(directionOf(InventoryMovementType.SALE_CANCELLATION)).toBe(MovementDirection.IN);
  });

  it('las salidas restan stock', () => {
    expect(directionOf(InventoryMovementType.SALE)).toBe(MovementDirection.OUT);
    expect(directionOf(InventoryMovementType.DAMAGE)).toBe(MovementDirection.OUT);
    expect(directionOf(InventoryMovementType.ADJUSTMENT_OUT)).toBe(MovementDirection.OUT);
  });
});

describe('InventoryService.applyMovements', () => {
  let service: InventoryService;

  const tx = {
    $queryRaw: jest.fn(),
    inventoryMovement: { create: jest.fn() },
    productVariant: { update: jest.fn() },
  };
  const prisma = { transaction: jest.fn(), inventoryMovement: {}, productVariant: {} };
  const settings = { getBoolean: jest.fn() };
  const audit = { record: jest.fn() };

  function lockedVariant(stock: string, cost = '245.20') {
    return [
      {
        id: 'v1',
        name: 'Black Opium 30ml',
        currentStock: new Prisma.Decimal(stock),
        costPrice: new Prisma.Decimal(cost),
      },
    ];
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    settings.getBoolean.mockResolvedValue(false);
    tx.inventoryMovement.create.mockImplementation((args: { data: unknown }) => args.data);
    tx.productVariant.update.mockResolvedValue({});

    const moduleRef = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        { provide: SettingsService, useValue: settings },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = moduleRef.get(InventoryService);
  });

  it('no hace nada con una lista vacía', async () => {
    await expect(service.applyMovements(tx as never, [])).resolves.toEqual([]);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('registra una entrada y actualiza el stock', async () => {
    tx.$queryRaw.mockResolvedValue(lockedVariant('0'));

    const [movement] = (await service.applyMovements(tx as never, [
      { productVariantId: 'v1', type: InventoryMovementType.PURCHASE, quantity: 5 },
    ])) as unknown as { stockBefore: Prisma.Decimal; stockAfter: Prisma.Decimal }[];

    expect(movement.stockBefore.toString()).toBe('0');
    expect(movement.stockAfter.toString()).toBe('5');
    expect(tx.productVariant.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: { currentStock: expect.anything() },
    });
  });

  it('impide dejar el stock negativo en una venta', async () => {
    tx.$queryRaw.mockResolvedValue(lockedVariant('1'));

    await expect(
      service.applyMovements(tx as never, [
        { productVariantId: 'v1', type: InventoryMovementType.SALE, quantity: 2 },
      ]),
    ).rejects.toThrow(/Stock insuficiente/);

    expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
    expect(tx.productVariant.update).not.toHaveBeenCalled();
  });

  it('el mensaje de stock insuficiente dice cuánto hay y cuánto se pidió', async () => {
    tx.$queryRaw.mockResolvedValue(lockedVariant('1'));

    try {
      await service.applyMovements(tx as never, [
        { productVariantId: 'v1', type: InventoryMovementType.SALE, quantity: 3 },
      ]);
      fail('debió lanzar');
    } catch (error) {
      const payload = (error as DomainException).getResponse() as { message: string };
      expect(payload.message).toContain('Black Opium 30ml');
      expect(payload.message).toContain('disponible 1');
      expect(payload.message).toContain('solicitado 3');
    }
  });

  it('permite stock negativo si la configuración lo autoriza', async () => {
    tx.$queryRaw.mockResolvedValue(lockedVariant('1'));
    settings.getBoolean.mockResolvedValue(true);

    const [movement] = (await service.applyMovements(tx as never, [
      { productVariantId: 'v1', type: InventoryMovementType.SALE, quantity: 2 },
    ])) as unknown as { stockAfter: Prisma.Decimal }[];

    expect(movement.stockAfter.toString()).toBe('-1');
  });

  it('vender exactamente el stock disponible sí se permite', async () => {
    tx.$queryRaw.mockResolvedValue(lockedVariant('2'));

    const [movement] = (await service.applyMovements(tx as never, [
      { productVariantId: 'v1', type: InventoryMovementType.SALE, quantity: 2 },
    ])) as unknown as { stockAfter: Prisma.Decimal }[];

    expect(movement.stockAfter.toString()).toBe('0');
  });

  it('acumula dos líneas de la misma variante en lugar de partir del stock inicial', async () => {
    tx.$queryRaw.mockResolvedValue(lockedVariant('3'));

    const movements = (await service.applyMovements(tx as never, [
      { productVariantId: 'v1', type: InventoryMovementType.SALE, quantity: 2 },
      { productVariantId: 'v1', type: InventoryMovementType.SALE, quantity: 1 },
    ])) as unknown as { stockBefore: Prisma.Decimal; stockAfter: Prisma.Decimal }[];

    expect(movements[0].stockAfter.toString()).toBe('1');
    expect(movements[1].stockBefore.toString()).toBe('1');
    expect(movements[1].stockAfter.toString()).toBe('0');
  });

  it('rechaza la tercera unidad cuando sólo quedan dos entre dos líneas', async () => {
    tx.$queryRaw.mockResolvedValue(lockedVariant('2'));

    await expect(
      service.applyMovements(tx as never, [
        { productVariantId: 'v1', type: InventoryMovementType.SALE, quantity: 2 },
        { productVariantId: 'v1', type: InventoryMovementType.SALE, quantity: 1 },
      ]),
    ).rejects.toThrow(/Stock insuficiente/);
  });

  it('rechaza cantidades cero o negativas', async () => {
    tx.$queryRaw.mockResolvedValue(lockedVariant('10'));

    await expect(
      service.applyMovements(tx as never, [
        { productVariantId: 'v1', type: InventoryMovementType.SALE, quantity: 0 },
      ]),
    ).rejects.toThrow(/mayor que cero/);

    await expect(
      service.applyMovements(tx as never, [
        { productVariantId: 'v1', type: InventoryMovementType.SALE, quantity: -1 },
      ]),
    ).rejects.toThrow(/mayor que cero/);
  });

  it('usa el costo vigente de la variante si no se indica otro', async () => {
    tx.$queryRaw.mockResolvedValue(lockedVariant('10', '245.20'));

    const [movement] = (await service.applyMovements(tx as never, [
      { productVariantId: 'v1', type: InventoryMovementType.SALE, quantity: 2 },
    ])) as unknown as { unitCost: Prisma.Decimal; totalCost: Prisma.Decimal }[];

    expect(movement.unitCost.toString()).toBe('245.2');
    expect(movement.totalCost.toString()).toBe('490.4');
  });

  it('respeta el costo indicado en una compra', async () => {
    tx.$queryRaw.mockResolvedValue(lockedVariant('0', '245.20'));

    const [movement] = (await service.applyMovements(tx as never, [
      {
        productVariantId: 'v1',
        type: InventoryMovementType.PURCHASE,
        quantity: 3,
        unitCost: '300.55',
      },
    ])) as unknown as { unitCost: Prisma.Decimal; totalCost: Prisma.Decimal }[];

    expect(movement.unitCost.toString()).toBe('300.55');
    expect(movement.totalCost.toString()).toBe('901.65');
  });

  it('bloquea las variantes ordenadas por id para evitar deadlocks', async () => {
    tx.$queryRaw.mockResolvedValue([
      { id: 'a', name: 'A', currentStock: new Prisma.Decimal(5), costPrice: new Prisma.Decimal(1) },
      { id: 'b', name: 'B', currentStock: new Prisma.Decimal(5), costPrice: new Prisma.Decimal(1) },
    ]);

    await service.applyMovements(tx as never, [
      { productVariantId: 'b', type: InventoryMovementType.SALE, quantity: 1 },
      { productVariantId: 'a', type: InventoryMovementType.SALE, quantity: 1 },
    ]);

    // $queryRaw se invoca como template literal: [strings, ...valores interpolados].
    // El valor interpolado es el Prisma.join con los ids en el orden del bloqueo.
    const joined = tx.$queryRaw.mock.calls[0][1] as Prisma.Sql;
    expect(joined.values).toEqual(['a', 'b']);
  });

  it('falla si alguna variante no existe', async () => {
    tx.$queryRaw.mockResolvedValue([]);

    await expect(
      service.applyMovements(tx as never, [
        { productVariantId: 'inexistente', type: InventoryMovementType.SALE, quantity: 1 },
      ]),
    ).rejects.toThrow(DomainException);
  });
});
