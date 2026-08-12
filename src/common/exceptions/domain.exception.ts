import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Códigos de error de negocio. Son estables: la interfaz de Telegram y el futuro dashboard
 * pueden reaccionar a ellos sin depender del texto del mensaje.
 */
export enum DomainErrorCode {
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  NOT_FOUND = 'NOT_FOUND',
  FORBIDDEN = 'FORBIDDEN',
  UNAUTHENTICATED = 'UNAUTHENTICATED',
  CONFLICT = 'CONFLICT',
  INSUFFICIENT_STOCK = 'INSUFFICIENT_STOCK',
  CREDIT_LIMIT_EXCEEDED = 'CREDIT_LIMIT_EXCEEDED',
  CREDIT_NOT_ALLOWED = 'CREDIT_NOT_ALLOWED',
  INVALID_AMOUNT = 'INVALID_AMOUNT',
  SALE_ALREADY_CANCELLED = 'SALE_ALREADY_CANCELLED',
  CASH_SESSION_ALREADY_OPEN = 'CASH_SESSION_ALREADY_OPEN',
  CASH_SESSION_NOT_OPEN = 'CASH_SESSION_NOT_OPEN',
  CASH_SESSION_CLOSED = 'CASH_SESSION_CLOSED',
  INVOICE_ALREADY_CANCELLED = 'INVOICE_ALREADY_CANCELLED',
}

const STATUS_BY_CODE: Record<DomainErrorCode, HttpStatus> = {
  [DomainErrorCode.VALIDATION_FAILED]: HttpStatus.BAD_REQUEST,
  [DomainErrorCode.NOT_FOUND]: HttpStatus.NOT_FOUND,
  [DomainErrorCode.FORBIDDEN]: HttpStatus.FORBIDDEN,
  [DomainErrorCode.UNAUTHENTICATED]: HttpStatus.UNAUTHORIZED,
  [DomainErrorCode.CONFLICT]: HttpStatus.CONFLICT,
  [DomainErrorCode.INSUFFICIENT_STOCK]: HttpStatus.CONFLICT,
  [DomainErrorCode.CREDIT_LIMIT_EXCEEDED]: HttpStatus.CONFLICT,
  [DomainErrorCode.CREDIT_NOT_ALLOWED]: HttpStatus.CONFLICT,
  [DomainErrorCode.INVALID_AMOUNT]: HttpStatus.BAD_REQUEST,
  [DomainErrorCode.SALE_ALREADY_CANCELLED]: HttpStatus.CONFLICT,
  [DomainErrorCode.CASH_SESSION_ALREADY_OPEN]: HttpStatus.CONFLICT,
  [DomainErrorCode.CASH_SESSION_NOT_OPEN]: HttpStatus.CONFLICT,
  [DomainErrorCode.CASH_SESSION_CLOSED]: HttpStatus.CONFLICT,
  [DomainErrorCode.INVOICE_ALREADY_CANCELLED]: HttpStatus.CONFLICT,
};

/**
 * Error de negocio esperado. Su mensaje es apto para mostrarse al usuario final:
 * no contiene detalles técnicos, nombres de tabla ni stack traces.
 */
export class DomainException extends HttpException {
  readonly code: DomainErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: DomainErrorCode, message: string, details?: Record<string, unknown>) {
    super({ code, message, details }, STATUS_BY_CODE[code]);
    this.code = code;
    this.details = details;
  }

  static notFound(entity: string, identifier?: string): DomainException {
    return new DomainException(
      DomainErrorCode.NOT_FOUND,
      `No encontramos ${entity}${identifier ? ` (${identifier})` : ''}.`,
      { entity, identifier },
    );
  }

  static forbidden(permission: string): DomainException {
    return new DomainException(
      DomainErrorCode.FORBIDDEN,
      'No tienes permiso para realizar esta operación.',
      { permission },
    );
  }
}
