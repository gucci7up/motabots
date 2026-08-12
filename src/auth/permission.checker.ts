import { DomainException } from '../common/exceptions/domain.exception';
import { PermissionCode } from '../roles/permissions';
import { AuthenticatedUser } from '../users/users.service';

/**
 * Comprobación de permisos compartida por Telegram y por la futura API HTTP.
 * Una sola implementación evita que un botón del bot ejecute algo que el guard HTTP prohibiría.
 */
export function hasPermission(
  user: Pick<AuthenticatedUser, 'permissions'>,
  permission: PermissionCode,
): boolean {
  return user.permissions.includes(permission);
}

export function hasAnyPermission(
  user: Pick<AuthenticatedUser, 'permissions'>,
  permissions: readonly PermissionCode[],
): boolean {
  return permissions.some((permission) => hasPermission(user, permission));
}

/** Lanza DomainException.forbidden si falta el permiso. */
export function assertPermission(
  user: Pick<AuthenticatedUser, 'permissions'>,
  permission: PermissionCode,
): void {
  if (!hasPermission(user, permission)) {
    throw DomainException.forbidden(permission);
  }
}
