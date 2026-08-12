/**
 * Renderiza una factura a un PDF local para revisar el diseño sin pasar por Telegram.
 *
 * Uso:
 *   npm run render:invoice -- MP-2026-000001 salida.pdf
 *   npm run render:invoice -- --last salida.pdf
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { writeFileSync } from 'node:fs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { InvoicePdfService } from '../src/invoices/invoice-pdf.service';
import { InvoicesService } from '../src/invoices/invoices.service';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const useLast = args.includes('--last');
  const positional = args.filter((arg) => !arg.startsWith('--'));
  const number = useLast ? undefined : positional[0];
  const output = (useLast ? positional[0] : positional[1]) ?? 'factura.pdf';

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });

  try {
    const prisma = app.get(PrismaService);
    const invoices = app.get(InvoicesService);
    const pdf = app.get(InvoicePdfService);

    const invoice = number
      ? await invoices.findByNumber(number)
      : await (async () => {
          const last = await prisma.invoice.findFirst({ orderBy: { createdAt: 'desc' } });
          if (!last) {
            throw new Error('No hay facturas en la base de datos.');
          }
          return invoices.findById(last.id);
        })();

    const buffer = await pdf.generate(invoice);
    writeFileSync(output, buffer);

    console.log(`Factura ${invoice.number} renderizada en ${output} (${buffer.length} bytes)`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error('Falló el render:', error);
  process.exitCode = 1;
});
