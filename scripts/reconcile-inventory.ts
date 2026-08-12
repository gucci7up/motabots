/**
 * Verifica que el stock guardado en cada variante coincida con la suma de sus movimientos.
 *
 * `currentStock` es una proyección que existe por rendimiento y para poder bloquear la fila;
 * la verdad son los movimientos. Este comando detecta cualquier divergencia.
 *
 * Uso:
 *   npm run reconcile:inventory            → sólo reporta
 *   npm run reconcile:inventory -- --fix   → corrige currentStock desde los movimientos
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { InventoryService } from '../src/inventory/inventory.service';

async function main(): Promise<void> {
  const fix = process.argv.includes('--fix');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });

  try {
    const inventory = app.get(InventoryService);
    const differences = await inventory.reconcile(fix);

    if (differences.length === 0) {
      console.log('✅ El inventario cuadra: ninguna variante diverge de sus movimientos.');
      return;
    }

    console.log(`⚠️  Variantes con stock divergente: ${differences.length}\n`);
    for (const row of differences) {
      console.log(
        `  ${row.name}\n` +
          `    guardado: ${row.stored.toString()}  ·  calculado: ${row.computed.toString()}`,
      );
    }

    if (fix) {
      console.log('\n✅ Corregidas: currentStock ahora refleja los movimientos.');
    } else {
      console.log('\nEjecuta con --fix para corregirlas.');
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error('Falló la reconciliación:', error);
  process.exitCode = 1;
});
