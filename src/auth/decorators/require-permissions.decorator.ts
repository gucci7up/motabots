import { SetMetadata } from '@nestjs/common';
import { PermissionCode } from '../../roles/permissions';

export const PERMISSIONS_METADATA_KEY = 'required_permissions';

/**
 * Marca los permisos necesarios para una ruta.
 * Ejemplo: `@RequirePermissions('sales.create')`
 */
export const RequirePermissions = (...permissions: PermissionCode[]) =>
  SetMetadata(PERMISSIONS_METADATA_KEY, permissions);
