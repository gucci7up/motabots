/**
 * Importa el catálogo y el inventario inicial desde el CSV de MotaParfum.
 *
 * Formato esperado (separador `;`):
 *   Perfume;Presentación (ml);Cantidad;Costo unitario (RD$);Precio venta (RD$);...
 * Las filas posteriores a "RESUMEN" se ignoran.
 *
 * Es idempotente: si el producto o la variante ya existen no se duplican, y el stock
 * inicial sólo se registra si la variante todavía no tiene movimientos. Ejecutarlo dos
 * veces no duplica inventario.
 *
 * Uso:
 *   npm run import:inventory -- "C:\\ruta\\MotaParfum_Inventario_COMPLETO.csv"
 *   npm run import:inventory -- ruta.csv --dry-run
 */
import 'dotenv/config';
import {
  InventoryMovementType,
  MeasurementUnit,
  MovementDirection,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { readFileSync } from 'node:fs';

const prisma = new PrismaClient();

interface CsvRow {
  productName: string;
  sizeMl: string;
  quantity: Prisma.Decimal;
  unitCost: Prisma.Decimal;
  salePrice: Prisma.Decimal;
  line: number;
}

const CATEGORY_NAME = 'Perfumes';
/** Stock mínimo por defecto: con inventarios de 1–3 unidades, avisar en 1 es razonable. */
const DEFAULT_MINIMUM_STOCK = 1;

function parseCsv(path: string): CsvRow[] {
  const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/);
  const rows: CsvRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.length === 0) {
      continue;
    }
    // El archivo incluye un bloque de totales al final que no son productos.
    if (line.toUpperCase().startsWith('RESUMEN')) {
      break;
    }

    const columns = line.split(';');
    if (columns.length < 5) {
      continue;
    }

    const [productName, sizeMl, qty, unitCost, salePrice] = columns;

    if (!/^\d+([.,]\d+)?$/.test(qty.trim())) {
      console.warn(`  Línea ${i + 1} ignorada (cantidad no numérica): ${productName}`);
      continue;
    }

    rows.push({
      productName: productName.trim(),
      sizeMl: sizeMl.trim(),
      quantity: new Prisma.Decimal(qty.replace(',', '.').trim()),
      unitCost: new Prisma.Decimal(unitCost.replace(',', '.').trim()),
      salePrice: new Prisma.Decimal(salePrice.replace(',', '.').trim()),
      line: i + 1,
    });
  }

  return rows;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const path = args.find((arg) => !arg.startsWith('--'));

  if (!path) {
    throw new Error('Falta la ruta del CSV. Uso: npm run import:inventory -- ruta.csv');
  }

  const rows = parseCsv(path);
  console.log(`Filas de producto leídas: ${rows.length}`);

  if (rows.length === 0) {
    throw new Error('El CSV no contiene filas de producto válidas.');
  }

  // Agrupa por nombre: el mismo perfume en 30ml y 10ml es un producto con dos variantes.
  const grouped = new Map<string, CsvRow[]>();
  for (const row of rows) {
    const existing = grouped.get(row.productName);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(row.productName, [row]);
    }
  }

  const totalUnits = rows.reduce((acc, row) => acc.plus(row.quantity), new Prisma.Decimal(0));
  const totalCost = rows.reduce(
    (acc, row) => acc.plus(row.quantity.times(row.unitCost)),
    new Prisma.Decimal(0),
  );
  const totalSaleValue = rows.reduce(
    (acc, row) => acc.plus(row.quantity.times(row.salePrice)),
    new Prisma.Decimal(0),
  );

  console.log(`Productos distintos: ${grouped.size}`);
  console.log(`Variantes: ${rows.length}`);
  console.log(`Unidades: ${totalUnits.toString()}`);
  console.log(`Costo total: RD$${totalCost.toFixed(2)}`);
  console.log(`Valor de venta: RD$${totalSaleValue.toFixed(2)}`);
  console.log(`Ganancia potencial: RD$${totalSaleValue.minus(totalCost).toFixed(2)}`);

  if (dryRun) {
    console.log('\n--dry-run: no se escribió nada en la base de datos.');
    return;
  }

  const category = await prisma.category.upsert({
    where: { name: CATEGORY_NAME },
    update: {},
    create: { name: CATEGORY_NAME },
  });

  let productsCreated = 0;
  let variantsCreated = 0;
  let stockRegistered = 0;
  let skipped = 0;

  for (const [productName, variantRows] of grouped) {
    let product = await prisma.product.findFirst({ where: { name: productName } });

    if (!product) {
      product = await prisma.product.create({
        data: { name: productName, categoryId: category.id },
      });
      productsCreated++;
    }

    for (const row of variantRows) {
      const variantName = `${row.sizeMl}ml`;

      let variant = await prisma.productVariant.findFirst({
        where: { productId: product.id, name: variantName },
      });

      if (!variant) {
        variant = await prisma.productVariant.create({
          data: {
            productId: product.id,
            name: variantName,
            size: row.sizeMl,
            unit: MeasurementUnit.ML,
            salePrice: row.salePrice,
            costPrice: row.unitCost,
            minimumStock: new Prisma.Decimal(DEFAULT_MINIMUM_STOCK),
            currentStock: new Prisma.Decimal(0),
          },
        });
        variantsCreated++;
      }

      // El stock inicial se registra una sola vez: si la variante ya tiene movimientos,
      // volver a cargarlo duplicaría el inventario.
      const existingMovements = await prisma.inventoryMovement.count({
        where: { productVariantId: variant.id },
      });

      if (existingMovements > 0) {
        skipped++;
        continue;
      }

      if (row.quantity.lessThanOrEqualTo(0)) {
        continue;
      }

      const variantId = variant.id;
      await prisma.$transaction(async (tx) => {
        await tx.inventoryMovement.create({
          data: {
            productVariantId: variantId,
            type: InventoryMovementType.INITIAL_STOCK,
            direction: MovementDirection.IN,
            quantity: row.quantity,
            stockBefore: new Prisma.Decimal(0),
            stockAfter: row.quantity,
            unitCost: row.unitCost,
            totalCost: row.quantity.times(row.unitCost).toDecimalPlaces(2),
            referenceType: 'IMPORT',
            referenceId: `csv:${row.line}`,
            notes: 'Inventario inicial importado desde CSV',
          },
        });

        await tx.productVariant.update({
          where: { id: variantId },
          data: { currentStock: row.quantity },
        });
      });

      stockRegistered++;
    }
  }

  console.log('');
  console.log(`Productos creados: ${productsCreated}`);
  console.log(`Variantes creadas: ${variantsCreated}`);
  console.log(`Variantes con stock inicial registrado: ${stockRegistered}`);
  console.log(`Variantes omitidas (ya tenían movimientos): ${skipped}`);

  const value = await prisma.$queryRaw<{ units: Prisma.Decimal; cost: Prisma.Decimal }[]>`
    SELECT COALESCE(SUM("currentStock"), 0) AS units,
           COALESCE(SUM("currentStock" * "costPrice"), 0) AS cost
    FROM product_variants WHERE "isActive" = true
  `;
  console.log(
    `\nInventario en base: ${value[0].units.toString()} unidades, ` +
      `costo RD$${new Prisma.Decimal(value[0].cost).toFixed(2)}`,
  );
}

main()
  .catch((error: unknown) => {
    console.error('La importación falló:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
