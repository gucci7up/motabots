/**
 * Catálogo de permisos del sistema. Es la única fuente de verdad: el seed lo siembra en la
 * base y los guards lo referencian. Los códigos son estables y no se renombran.
 */

export const PERMISSIONS = [
  { code: 'sales.create', group: 'sales', description: 'Registrar ventas' },
  { code: 'sales.read', group: 'sales', description: 'Consultar ventas' },
  { code: 'sales.cancel', group: 'sales', description: 'Cancelar ventas' },
  { code: 'customers.create', group: 'customers', description: 'Crear clientes' },
  { code: 'customers.read', group: 'customers', description: 'Consultar clientes' },
  { code: 'customers.update', group: 'customers', description: 'Modificar clientes' },
  { code: 'products.create', group: 'products', description: 'Crear productos y variantes' },
  { code: 'products.read', group: 'products', description: 'Consultar productos' },
  { code: 'products.update', group: 'products', description: 'Modificar productos y precios' },
  { code: 'inventory.read', group: 'inventory', description: 'Consultar inventario' },
  { code: 'inventory.adjust', group: 'inventory', description: 'Ajustar y mover inventario' },
  { code: 'invoices.create', group: 'invoices', description: 'Emitir facturas' },
  { code: 'invoices.read', group: 'invoices', description: 'Consultar facturas' },
  { code: 'invoices.cancel', group: 'invoices', description: 'Anular facturas' },
  { code: 'payments.create', group: 'payments', description: 'Registrar pagos' },
  { code: 'payments.read', group: 'payments', description: 'Consultar pagos' },
  { code: 'credits.read', group: 'credits', description: 'Consultar créditos' },
  { code: 'credits.collect', group: 'credits', description: 'Registrar abonos a créditos' },
  { code: 'cash.open', group: 'cash', description: 'Abrir caja' },
  { code: 'cash.close', group: 'cash', description: 'Cerrar caja' },
  { code: 'cash.read', group: 'cash', description: 'Consultar caja' },
  { code: 'expenses.create', group: 'expenses', description: 'Registrar gastos' },
  { code: 'expenses.read', group: 'expenses', description: 'Consultar gastos' },
  { code: 'accounting.read', group: 'accounting', description: 'Consultar contabilidad' },
  { code: 'reports.read', group: 'reports', description: 'Consultar reportes' },
  { code: 'audit.read', group: 'audit', description: 'Consultar auditoría' },
  { code: 'settings.manage', group: 'settings', description: 'Modificar configuración' },
  { code: 'users.manage', group: 'users', description: 'Administrar usuarios y roles' },
] as const;

export type PermissionCode = (typeof PERMISSIONS)[number]['code'];

export const ALL_PERMISSIONS: PermissionCode[] = PERMISSIONS.map((p) => p.code);

export const SYSTEM_ROLES = {
  ADMIN: 'ADMIN',
  SELLER: 'SELLER',
  ACCOUNTANT: 'ACCOUNTANT',
} as const;

export type SystemRole = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];

/** Permisos por rol. ADMIN los tiene todos. */
export const ROLE_PERMISSIONS: Record<SystemRole, PermissionCode[]> = {
  ADMIN: ALL_PERMISSIONS,
  SELLER: [
    'sales.create',
    'sales.read',
    'customers.create',
    'customers.read',
    'customers.update',
    'products.read',
    'inventory.read',
    'invoices.create',
    'invoices.read',
    'payments.create',
    'payments.read',
    'credits.read',
    'credits.collect',
    'cash.open',
    'cash.close',
    'cash.read',
    'expenses.create',
  ],
  ACCOUNTANT: [
    'sales.read',
    'customers.read',
    'products.read',
    'inventory.read',
    'invoices.read',
    'payments.read',
    'credits.read',
    'cash.read',
    'expenses.create',
    'expenses.read',
    'accounting.read',
    'reports.read',
    'audit.read',
  ],
};

export const ROLE_DESCRIPTIONS: Record<SystemRole, string> = {
  ADMIN: 'Acceso total al sistema',
  SELLER: 'Ventas, clientes, cobros y caja',
  ACCOUNTANT: 'Consulta financiera y contable',
};
