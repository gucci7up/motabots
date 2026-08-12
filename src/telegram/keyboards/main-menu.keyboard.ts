import { Markup } from 'telegraf';
import type { InlineKeyboardMarkup } from 'telegraf/types';
import { hasAnyPermission } from '../../auth/permission.checker';
import { PermissionCode } from '../../roles/permissions';
import type { AuthenticatedUser } from '../../users/users.service';

export const CALLBACK = {
  MENU: 'menu',
  ACCOUNT: 'menu:account',
  SUMMARY: 'menu:summary',
  SALES: 'menu:sales',
  CUSTOMERS: 'menu:customers',
  INVENTORY: 'menu:inventory',
  CREDITS: 'menu:credits',
  INVOICES: 'menu:invoices',
  CASH: 'menu:cash',
  EXPENSES: 'menu:expenses',
  REPORTS: 'menu:reports',
  SETTINGS: 'menu:settings',
} as const;

export interface MenuEntry {
  label: string;
  callback: string;
  /** El botón se muestra si el usuario tiene al menos uno de estos permisos. */
  permissions: PermissionCode[];
  /**
   * Si la sección todavía no está construida, se indica la fase en la que llega.
   * El botón se muestra igual, pero avisa con claridad en vez de simular que funciona.
   */
  pendingPhase?: number;
}

export const MENU_ENTRIES: MenuEntry[] = [
  { label: '👤 Mi cuenta', callback: CALLBACK.ACCOUNT, permissions: [] },
  {
    label: '📊 Resumen',
    callback: CALLBACK.SUMMARY,
    permissions: ['reports.read', 'sales.read'],
  },
  {
    label: '🛒 Ventas',
    callback: CALLBACK.SALES,
    permissions: ['sales.create', 'sales.read'],
  },
  {
    label: '👥 Clientes',
    callback: CALLBACK.CUSTOMERS,
    permissions: ['customers.read'],
  },
  {
    label: '📦 Inventario',
    callback: CALLBACK.INVENTORY,
    permissions: ['inventory.read'],
  },
  {
    label: '💳 Créditos',
    callback: CALLBACK.CREDITS,
    permissions: ['credits.read'],
  },
  {
    label: '🧾 Facturas',
    callback: CALLBACK.INVOICES,
    permissions: ['invoices.read'],
  },
  {
    label: '💰 Caja',
    callback: CALLBACK.CASH,
    permissions: ['cash.read', 'cash.open'],
  },
  {
    label: '💸 Gastos',
    callback: CALLBACK.EXPENSES,
    permissions: ['expenses.create', 'expenses.read'],
  },
  {
    label: '📈 Reportes',
    callback: CALLBACK.REPORTS,
    permissions: ['reports.read'],
  },
  {
    label: '⚙️ Configuración',
    callback: CALLBACK.SETTINGS,
    permissions: ['settings.manage'],
    pendingPhase: 12,
  },
];

/** Entradas visibles para un usuario, según sus permisos. */
export function visibleEntries(user: AuthenticatedUser): MenuEntry[] {
  return MENU_ENTRIES.filter(
    (entry) => entry.permissions.length === 0 || hasAnyPermission(user, entry.permissions),
  );
}

/**
 * Menú principal filtrado por permisos: un botón que el usuario no puede usar no se muestra.
 * El filtrado visual no sustituye la comprobación en el handler, sólo evita frustración.
 */
export function mainMenuKeyboard(user: AuthenticatedUser): Markup.Markup<InlineKeyboardMarkup> {
  const buttons = visibleEntries(user).map((entry) =>
    Markup.button.callback(entry.label, entry.callback),
  );

  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }

  return Markup.inlineKeyboard(rows);
}

/** Botones de navegación estándar presentes en cualquier pantalla que no sea el menú. */
export function navigationKeyboard(backCallback?: string): Markup.Markup<InlineKeyboardMarkup> {
  const row = [];
  if (backCallback) {
    row.push(Markup.button.callback('⬅️ Atrás', backCallback));
  }
  row.push(Markup.button.callback('🏠 Menú', CALLBACK.MENU));
  return Markup.inlineKeyboard([row]);
}
