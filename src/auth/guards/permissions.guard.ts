import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { DomainErrorCode, DomainException } from '../../common/exceptions/domain.exception';
import { PermissionCode } from '../../roles/permissions';
import { AuthenticatedUser } from '../../users/users.service';
import { PERMISSIONS_METADATA_KEY } from '../decorators/require-permissions.decorator';
import { hasPermission } from '../permission.checker';

type RequestWithUser = Request & { user?: AuthenticatedUser };

/**
 * Guard HTTP de permisos. Requiere que un guard de autenticación previo haya puesto
 * `request.user`; si no hay usuario, deniega. Nunca asume un usuario por defecto.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<PermissionCode[] | undefined>(
      PERMISSIONS_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;

    if (!user) {
      throw new DomainException(
        DomainErrorCode.UNAUTHENTICATED,
        'Necesitas iniciar sesión para realizar esta operación.',
      );
    }

    const missing = required.filter((permission) => !hasPermission(user, permission));
    if (missing.length > 0) {
      throw DomainException.forbidden(missing.join(', '));
    }

    return true;
  }
}
