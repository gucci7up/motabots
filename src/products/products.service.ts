import { Injectable } from '@nestjs/common';
import { MeasurementUnit, Prisma, Product, ProductVariant } from '@prisma/client';
import { AuditAction, AuditService } from '../audit/audit.service';
import { PaginatedResult, paginate } from '../common/dto/pagination.dto';
import { DomainErrorCode, DomainException } from '../common/exceptions/domain.exception';
import { cost, isNegative, money, quantity } from '../common/money';
import { PrismaService } from '../database/prisma.service';
import { CreateProductDto, CreateVariantDto } from './dto/create-product.dto';
import { UpdateVariantDto } from './dto/update-variant.dto';

export type ProductWithVariants = Product & { variants: ProductVariant[] };

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(dto: CreateProductDto, actorId: string | null): Promise<ProductWithVariants> {
    if (dto.variants.length === 0) {
      throw new DomainException(
        DomainErrorCode.VALIDATION_FAILED,
        'El producto necesita al menos una variante.',
      );
    }

    const variants = dto.variants.map((variant) => this.toVariantData(variant));

    // Producto y variantes se crean juntos: un producto sin variantes no se puede vender.
    const product = await this.prisma.transaction(
      async (tx) =>
        tx.product.create({
          data: {
            name: dto.name.trim(),
            sku: dto.sku?.trim() || null,
            categoryId: dto.categoryId ?? null,
            brand: dto.brand?.trim() || null,
            description: dto.description?.trim() || null,
            variants: { create: variants },
          },
          include: { variants: true },
        }),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );

    await this.audit.record({
      userId: actorId,
      action: AuditAction.PRODUCT_CREATED,
      entity: 'Product',
      entityId: product.id,
      after: { name: product.name, variants: product.variants.length },
    });

    return product;
  }

  async addVariant(
    productId: string,
    dto: CreateVariantDto,
    actorId: string | null,
  ): Promise<ProductVariant> {
    await this.findById(productId);

    const variant = await this.prisma.productVariant.create({
      data: { productId, ...this.toVariantData(dto) },
    });

    await this.audit.record({
      userId: actorId,
      action: AuditAction.PRODUCT_UPDATED,
      entity: 'ProductVariant',
      entityId: variant.id,
      after: { name: variant.name, salePrice: variant.salePrice, costPrice: variant.costPrice },
    });

    return variant;
  }

  /**
   * Actualiza una variante. Cambiar precio o costo NO altera las ventas ya registradas:
   * cada línea de venta guarda su propio snapshot. El cambio queda auditado con el valor
   * anterior y el nuevo.
   */
  async updateVariant(
    variantId: string,
    dto: UpdateVariantDto,
    actorId: string | null,
  ): Promise<ProductVariant> {
    const before = await this.findVariantById(variantId);

    const data: Prisma.ProductVariantUpdateInput = {};
    if (dto.name !== undefined) {
      data.name = dto.name.trim();
    }
    if (dto.salePrice !== undefined) {
      data.salePrice = this.parseMoney(dto.salePrice, 'precio de venta');
    }
    if (dto.costPrice !== undefined) {
      data.costPrice = this.parseCost(dto.costPrice);
    }
    if (dto.minimumStock !== undefined) {
      data.minimumStock = this.parseQuantity(dto.minimumStock, 'stock mínimo');
    }
    if (dto.sku !== undefined) {
      data.sku = dto.sku.trim() || null;
    }
    if (dto.barcode !== undefined) {
      data.barcode = dto.barcode.trim() || null;
    }
    if (dto.isActive !== undefined) {
      data.isActive = dto.isActive;
    }

    const variant = await this.prisma.productVariant.update({ where: { id: variantId }, data });

    await this.audit.record({
      userId: actorId,
      action: AuditAction.PRODUCT_UPDATED,
      entity: 'ProductVariant',
      entityId: variantId,
      before: {
        name: before.name,
        salePrice: before.salePrice,
        costPrice: before.costPrice,
        minimumStock: before.minimumStock,
        isActive: before.isActive,
      },
      after: {
        name: variant.name,
        salePrice: variant.salePrice,
        costPrice: variant.costPrice,
        minimumStock: variant.minimumStock,
        isActive: variant.isActive,
      },
    });

    return variant;
  }

  async findById(id: string): Promise<ProductWithVariants> {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: { variants: { orderBy: { name: 'asc' } } },
    });

    if (!product) {
      throw DomainException.notFound('el producto', id);
    }

    return product;
  }

  async findVariantById(id: string): Promise<ProductVariant> {
    const variant = await this.prisma.productVariant.findUnique({ where: { id } });
    if (!variant) {
      throw DomainException.notFound('la variante', id);
    }
    return variant;
  }

  async findAll(
    page: number,
    pageSize: number,
    includeInactive = false,
  ): Promise<PaginatedResult<ProductWithVariants>> {
    const where: Prisma.ProductWhereInput = includeInactive ? {} : { isActive: true };

    const [products, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: { variants: { orderBy: { name: 'asc' } } },
        orderBy: { name: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.product.count({ where }),
    ]);

    return paginate(products, total, page, pageSize);
  }

  /**
   * Búsqueda para el bot: por nombre de producto, marca, SKU o código de barras.
   * Insensible a mayúsculas y a coincidencias parciales, que es como el usuario escribe.
   */
  async search(
    term: string,
    page: number,
    pageSize: number,
  ): Promise<PaginatedResult<ProductWithVariants>> {
    const query = term.trim();

    if (query.length === 0) {
      return this.findAll(page, pageSize);
    }

    const where: Prisma.ProductWhereInput = {
      isActive: true,
      OR: [
        { name: { contains: query, mode: 'insensitive' } },
        { brand: { contains: query, mode: 'insensitive' } },
        { sku: { contains: query, mode: 'insensitive' } },
        { variants: { some: { sku: { contains: query, mode: 'insensitive' } } } },
        { variants: { some: { barcode: query } } },
      ],
    };

    const [products, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: { variants: { orderBy: { name: 'asc' } } },
        orderBy: { name: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.product.count({ where }),
    ]);

    return paginate(products, total, page, pageSize);
  }

  /** Desactiva el producto y sus variantes. No se borra: hay ventas que lo referencian. */
  async deactivate(id: string, actorId: string | null): Promise<ProductWithVariants> {
    await this.findById(id);

    const product = await this.prisma.transaction(
      async (tx) => {
        await tx.productVariant.updateMany({ where: { productId: id }, data: { isActive: false } });
        return tx.product.update({
          where: { id },
          data: { isActive: false },
          include: { variants: true },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );

    await this.audit.record({
      userId: actorId,
      action: AuditAction.PRODUCT_UPDATED,
      entity: 'Product',
      entityId: id,
      after: { isActive: false },
    });

    return product;
  }

  private toVariantData(dto: CreateVariantDto): Prisma.ProductVariantCreateWithoutProductInput {
    return {
      name: dto.name.trim(),
      size: dto.size?.trim() || null,
      unit: dto.unit ?? MeasurementUnit.UNIT,
      salePrice: this.parseMoney(dto.salePrice, 'precio de venta'),
      costPrice: this.parseCost(dto.costPrice),
      minimumStock: dto.minimumStock
        ? this.parseQuantity(dto.minimumStock, 'stock mínimo')
        : new Prisma.Decimal(0),
      sku: dto.sku?.trim() || null,
      barcode: dto.barcode?.trim() || null,
    };
  }

  private parseMoney(value: string, label: string): Prisma.Decimal {
    const amount = money(value);
    if (isNegative(amount)) {
      throw new DomainException(
        DomainErrorCode.INVALID_AMOUNT,
        `El ${label} no puede ser negativo.`,
      );
    }
    return amount;
  }

  private parseCost(value: string): Prisma.Decimal {
    const amount = cost(value);
    if (isNegative(amount)) {
      throw new DomainException(DomainErrorCode.INVALID_AMOUNT, 'El costo no puede ser negativo.');
    }
    return amount;
  }

  private parseQuantity(value: string, label: string): Prisma.Decimal {
    const amount = quantity(value);
    if (isNegative(amount)) {
      throw new DomainException(
        DomainErrorCode.INVALID_AMOUNT,
        `El ${label} no puede ser negativo.`,
      );
    }
    return amount;
  }
}
