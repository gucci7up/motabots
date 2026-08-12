import { ROLE_PERMISSIONS } from '../../roles/permissions';
import type { AuthenticatedUser } from '../../users/users.service';
import { CALLBACK, mainMenuKeyboard, navigationKeyboard, visibleEntries } from './main-menu.keyboard';

function userWithRole(roleName: keyof typeof ROLE_PERMISSIONS): AuthenticatedUser {
  return {
    id: 'u1',
    telegramUserId: 7045646241n,
    username: 'kmota',
    firstName: 'K',
    lastName: null,
    roleId: 'r1',
    roleName,
    isActive: true,
    permissions: [...ROLE_PERMISSIONS[roleName]],
  };
}

describe('mainMenuKeyboard', () => {
  it('el ADMIN ve todas las secciones', () => {
    const entries = visibleEntries(userWithRole('ADMIN'));
    expect(entries.map((e) => e.callback)).toContain(CALLBACK.SETTINGS);
    expect(entries).toHaveLength(11);
  });

  it('el SELLER no ve Configuración', () => {
    const callbacks = visibleEntries(userWithRole('SELLER')).map((e) => e.callback);
    expect(callbacks).toContain(CALLBACK.SALES);
    expect(callbacks).toContain(CALLBACK.CASH);
    expect(callbacks).not.toContain(CALLBACK.SETTINGS);
  });

  it('Mi cuenta es visible para cualquier usuario, incluso sin permisos', () => {
    const sinPermisos: AuthenticatedUser = { ...userWithRole('SELLER'), permissions: [] };
    const callbacks = visibleEntries(sinPermisos).map((e) => e.callback);
    expect(callbacks).toEqual([CALLBACK.ACCOUNT]);
  });

  it('organiza los botones en filas de dos', () => {
    const keyboard = mainMenuKeyboard(userWithRole('ADMIN'));
    const rows = keyboard.reply_markup.inline_keyboard;
    expect(rows.every((row) => row.length <= 2)).toBe(true);
    expect(rows.flat()).toHaveLength(11);
  });

  it('el teclado de navegación siempre ofrece volver al menú', () => {
    const soloMenu = navigationKeyboard().reply_markup.inline_keyboard.flat();
    expect(soloMenu).toHaveLength(1);

    const conAtras = navigationKeyboard('menu:sales').reply_markup.inline_keyboard.flat();
    expect(conAtras).toHaveLength(2);
  });
});
