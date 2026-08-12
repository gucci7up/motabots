/**
 * Configura los datos de la tienda que aparecen en la factura: logo, teléfono,
 * dirección y redes sociales.
 *
 * El logo se copia al almacenamiento de archivos y en la base sólo queda su clave,
 * nunca el binario.
 *
 * Uso:
 *   npm run store:info -- --logo "C:\\ruta\\logo.png"
 *   npm run store:info -- --phone "809-555-1234" --address "Santo Domingo, RD"
 *   npm run store:info -- --instagram "@motaparfum" --whatsapp "809-555-1234"
 */
import 'dotenv/config';
import { PrismaClient, SettingType } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function setSetting(key: string, value: unknown, type: SettingType): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    update: { value: value as never, type },
    create: { key, value: value as never, type },
  });
  console.log(`  ${key} = ${JSON.stringify(value)}`);
}

async function main(): Promise<void> {
  console.log('Configurando datos de la tienda…');

  const logoPath = arg('logo');
  if (logoPath) {
    const extension = extname(logoPath).toLowerCase();
    if (!['.png', '.jpg', '.jpeg'].includes(extension)) {
      throw new Error('El logo debe ser PNG o JPG.');
    }

    const content = readFileSync(logoPath);
    const key = `store/logo${extension}`;
    const root = resolve(process.env.STORAGE_LOCAL_PATH ?? './storage');
    const destination = join(root, key);

    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);

    const checksum = createHash('sha256').update(content).digest('hex').slice(0, 12);
    console.log(`  logo copiado a ${destination} (${content.length} bytes, ${checksum})`);

    await setSetting('store.logoStorageKey', key, SettingType.STRING);
  }

  const phone = arg('phone');
  if (phone) {
    await setSetting('store.phone', phone, SettingType.STRING);
  }

  const address = arg('address');
  if (address) {
    await setSetting('store.address', address, SettingType.STRING);
  }

  const social: Record<string, string> = {};
  for (const network of ['instagram', 'facebook', 'whatsapp', 'tiktok', 'web']) {
    const value = arg(network);
    if (value) {
      social[network] = value;
    }
  }

  if (Object.keys(social).length > 0) {
    const current = await prisma.setting.findUnique({ where: { key: 'store.socialMedia' } });
    const merged = {
      ...((current?.value as Record<string, string> | null) ?? {}),
      ...social,
    };
    await setSetting('store.socialMedia', merged, SettingType.JSON);
  }

  console.log('Listo.');
}

main()
  .catch((error: unknown) => {
    console.error('Falló la configuración:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
