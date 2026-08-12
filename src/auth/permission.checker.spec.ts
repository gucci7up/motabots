import { DomainException } from '../common/exceptions/domain.exception';
import { ROLE_PERMISSIONS } from '../roles/permissions';
import { assertPermission, hasAnyPermission, hasPermission } from './permission.checker';

const seller = { permissions: ROLE_PERMISSIONS.SELLER };
const accountant = { permissions: ROLE_PERMISSIONS.ACCOUNTANT };
const admin = { permissions: ROLE_PERMISSIONS.ADMIN };

describe('permission.checker', () => {
  it('el ADMIN tiene todos los permisos', () => {
    expect(hasPermission(admin, 'users.manage')).toBe(true);
    expect(hasPermission(admin, 'sales.cancel')).toBe(true);
    expect(hasPermission(admin, 'settings.manage')).toBe(true);
  });

  it('el SELLER puede vender y cobrar pero no cancelar ventas ni administrar usuarios', () => {
    expect(hasPermission(seller, 'sales.create')).toBe(true);
    expect(hasPermission(seller, 'credits.collect')).toBe(true);
    expect(hasPermission(seller, 'sales.cancel')).toBe(false);
    expect(hasPermission(seller, 'users.manage')).toBe(false);
    expect(hasPermission(seller, 'settings.manage')).toBe(false);
  });

  it('el ACCOUNTANT consulta pero no vende ni ajusta inventario', () => {
    expect(hasPermission(accountant, 'accounting.read')).toBe(true);
    expect(hasPermission(accountant, 'reports.read')).toBe(true);
    expect(hasPermission(accountant, 'sales.create')).toBe(false);
    expect(hasPermission(accountant, 'inventory.adjust')).toBe(false);
  });

  it('hasAnyPermission acepta si tiene al menos uno', () => {
    expect(hasAnyPermission(seller, ['users.manage', 'sales.create'])).toBe(true);
    expect(hasAnyPermission(seller, ['users.manage', 'settings.manage'])).toBe(false);
    expect(hasAnyPermission(seller, [])).toBe(false);
  });

  it('assertPermission lanza DomainException cuando falta el permiso', () => {
    expect(() => assertPermission(seller, 'sales.create')).not.toThrow();
    expect(() => assertPermission(seller, 'users.manage')).toThrow(DomainException);
  });

  it('el mensaje del error no revela detalles internos', () => {
    try {
      assertPermission(seller, 'users.manage');
      fail('debió lanzar');
    } catch (error) {
      const payload = (error as DomainException).getResponse() as { message: string };
      expect(payload.message).toBe('No tienes permiso para realizar esta operación.');
    }
  });
});
