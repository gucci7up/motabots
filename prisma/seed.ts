/* eslint-disable no-console */
import { PrismaClient, SettingType } from '@prisma/client';
import {
  PERMISSIONS,
  ROLE_DESCRIPTIONS,
  ROLE_PERMISSIONS,
  SYSTEM_ROLES,
  type SystemRole,
} from '../src/roles/permissions';

/**
 * Seed idempotente: puede ejecutarse tantas veces como haga falta.
 * No crea productos ni clientes ficticios — sólo el andamiaje que el sistema necesita.
 */

const prisma = new PrismaClient();

const CATEGORIES = ['Perfumes', 'Cremas', 'Body Oils', 'Gloss', 'Otros'];

const EXPENSE_CATEGORIES: { code: string; name: string }[] = [
  { code: 'INVENTORY', name: 'Inventario' },
  { code: 'PACKAGING', name: 'Empaque' },
  { code: 'DELIVERY', name: 'Delivery' },
  { code: 'MARKETING', name: 'Marketing' },
  { code: 'TRANSPORT', name: 'Transporte' },
  { code: 'SERVICES', name: 'Servicios' },
  { code: 'RENT', name: 'Alquiler' },
  { code: 'SALARY', name: 'Salarios' },
  { code: 'OTHER', name: 'Otros' },
];

async function seedPermissions(): Promise<void> {
  for (const permission of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { description: permission.description, group: permission.group },
      create: permission,
    });
  }
  console.log(`Permisos: ${PERMISSIONS.length}`);
}

async function seedRoles(): Promise<void> {
  const roleNames = Object.values(SYSTEM_ROLES);

  for (const name of roleNames) {
    await prisma.role.upsert({
      where: { name },
      update: { description: ROLE_DESCRIPTIONS[name], isSystem: true },
      create: { name, description: ROLE_DESCRIPTIONS[name], isSystem: true },
    });
  }

  for (const name of roleNames) {
    await assignPermissions(name, ROLE_PERMISSIONS[name]);
  }

  console.log(`Roles: ${roleNames.join(', ')}`);
}

async function assignPermissions(roleName: SystemRole, codes: readonly string[]): Promise<void> {
  const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
  const permissions = await prisma.permission.findMany({ where: { code: { in: [...codes] } } });

  for (const permission of permissions) {
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
      update: {},
      create: { roleId: role.id, permissionId: permission.id },
    });
  }

  // Un permiso retirado de la lista debe desaparecer del rol, no quedarse colgado.
  await prisma.rolePermission.deleteMany({
    where: { roleId: role.id, permissionId: { notIn: permissions.map((p) => p.id) } },
  });
}

async function seedCategories(): Promise<void> {
  for (const name of CATEGORIES) {
    await prisma.category.upsert({ where: { name }, update: {}, create: { name } });
  }
  console.log(`Categorías de producto: ${CATEGORIES.length}`);
}

async function seedExpenseCategories(): Promise<void> {
  for (const category of EXPENSE_CATEGORIES) {
    await prisma.expenseCategory.upsert({
      where: { code: category.code },
      update: { name: category.name, isSystem: true },
      create: { ...category, isSystem: true },
    });
  }
  console.log(`Categorías de gasto: ${EXPENSE_CATEGORIES.length}`);
}

async function seedInvoiceSequence(): Promise<void> {
  const prefix = process.env.INVOICE_PREFIX ?? 'MP';
  await prisma.invoiceSequence.upsert({
    where: { series: 'DEFAULT' },
    update: {},
    create: {
      series: 'DEFAULT',
      prefix,
      format: '{PREFIX}-{YYYY}-{SEQ}',
      nextNumber: 1,
      padding: 6,
    },
  });
  console.log(`Secuencia de facturas: ${prefix}-{YYYY}-{000001}`);
}

async function seedSettings(): Promise<void> {
  const settings: { key: string; value: unknown; type: SettingType; description: string }[] = [
    {
      key: 'store.name',
      value: process.env.STORE_NAME ?? 'MotaParfum',
      type: SettingType.STRING,
      description: 'Nombre de la tienda mostrado en facturas y mensajes',
    },
    {
      key: 'store.phone',
      value: process.env.STORE_PHONE ?? '',
      type: SettingType.STRING,
      description: 'Teléfono de contacto',
    },
    {
      key: 'store.address',
      value: process.env.STORE_ADDRESS ?? '',
      type: SettingType.STRING,
      description: 'Dirección de la tienda',
    },
    {
      key: 'store.logoStorageKey',
      value: '',
      type: SettingType.STRING,
      description: 'Clave del logo en el almacenamiento de archivos',
    },
    {
      key: 'store.socialMedia',
      value: {},
      type: SettingType.JSON,
      description: 'Redes sociales mostradas en la factura',
    },
    {
      key: 'currency',
      value: process.env.CURRENCY ?? 'DOP',
      type: SettingType.STRING,
      description: 'Moneda del sistema',
    },
    {
      key: 'currencySymbol',
      value: process.env.CURRENCY_SYMBOL ?? 'RD$',
      type: SettingType.STRING,
      description: 'Símbolo de la moneda',
    },
    {
      key: 'invoice.prefix',
      value: process.env.INVOICE_PREFIX ?? 'MP',
      type: SettingType.STRING,
      description: 'Prefijo del número de factura',
    },
    {
      key: 'invoice.format',
      value: '{PREFIX}-{YYYY}-{SEQ}',
      type: SettingType.STRING,
      description: 'Formato del número de factura',
    },
    {
      key: 'tax.enabled',
      value: false,
      type: SettingType.BOOLEAN,
      description: 'Aplicar impuestos a las ventas',
    },
    {
      key: 'tax.rate',
      value: 0,
      type: SettingType.NUMBER,
      description: 'Tasa de impuesto en porcentaje (ITBIS = 18)',
    },
    {
      key: 'inventory.allowNegativeStock',
      value: false,
      type: SettingType.BOOLEAN,
      description: 'Permitir vender por debajo del stock disponible',
    },
    {
      key: 'credit.enabled',
      value: true,
      type: SettingType.BOOLEAN,
      description: 'Permitir ventas a crédito',
    },
    {
      key: 'credit.defaultDueDays',
      value: 15,
      type: SettingType.NUMBER,
      description: 'Días de vencimiento por defecto de un crédito',
    },
    {
      key: 'payments.enabledMethods',
      value: ['CASH', 'BANK_TRANSFER', 'CARD', 'MOBILE_PAYMENT'],
      type: SettingType.JSON,
      description: 'Métodos de pago habilitados (Efectivo, Transferencia, Tarjeta, Pago móvil)',
    },
    {
      key: 'alerts.lowStock.enabled',
      value: true,
      type: SettingType.BOOLEAN,
      description: 'Enviar alertas de stock bajo por Telegram',
    },
    {
      key: 'alerts.dailySummary.hour',
      value: 21,
      type: SettingType.NUMBER,
      description: 'Hora local del resumen diario',
    },
  ];

  for (const setting of settings) {
    await prisma.setting.upsert({
      where: { key: setting.key },
      // La configuración se administra desde Telegram: el seed no pisa valores ya ajustados.
      update: { description: setting.description, type: setting.type },
      create: {
        key: setting.key,
        value: setting.value as never,
        type: setting.type,
        description: setting.description,
      },
    });
  }

  console.log(`Configuración: ${settings.length} claves`);
}

async function seedAdminUsers(): Promise<void> {
  const raw = process.env.TELEGRAM_ADMIN_IDS ?? '';
  const ids = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => /^\d+$/.test(part));

  if (ids.length === 0) {
    console.log(
      'TELEGRAM_ADMIN_IDS vacío: no se creó ningún administrador. ' +
        'Defínelo en .env y vuelve a ejecutar el seed.',
    );
    return;
  }

  const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: 'ADMIN' } });

  for (const id of ids) {
    await prisma.user.upsert({
      where: { telegramUserId: BigInt(id) },
      update: { roleId: adminRole.id, isActive: true },
      create: { telegramUserId: BigInt(id), roleId: adminRole.id, isActive: true },
    });
  }

  console.log(`Administradores: ${ids.length}`);
}

async function main(): Promise<void> {
  console.log('Ejecutando seed de MotaParfum Admin…');
  await seedPermissions();
  await seedRoles();
  await seedCategories();
  await seedExpenseCategories();
  await seedInvoiceSequence();
  await seedSettings();
  await seedAdminUsers();
  console.log('Seed completado.');
}

main()
  .catch((error: unknown) => {
    console.error('El seed falló:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
