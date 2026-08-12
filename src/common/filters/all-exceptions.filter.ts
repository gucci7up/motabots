import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { DomainErrorCode } from '../exceptions/domain.exception';

interface ErrorBody {
  statusCode: HttpStatus;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  correlationId: string;
  timestamp: string;
  path?: string;
}

const GENERIC_MESSAGE = 'No pudimos completar la operación. Inténtalo nuevamente.';

/**
 * Filtro global. Traduce cualquier excepción a una respuesta segura:
 * los errores de negocio conservan su mensaje; el resto se registra con stack trace
 * y devuelve un mensaje genérico. El usuario nunca ve un PrismaClientKnownRequestError.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const correlationId = randomUUID();

    const body = this.buildBody(exception, correlationId, request?.url);

    if (body.statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        {
          correlationId,
          path: request?.url,
          method: request?.method,
          err: exception,
        },
        'Error no controlado',
      );
    } else {
      this.logger.warn(
        { correlationId, path: request?.url, code: body.code, message: body.message },
        'Operación rechazada',
      );
    }

    response.status(body.statusCode).json(body);
  }

  private buildBody(exception: unknown, correlationId: string, path?: string): ErrorBody {
    const base = { correlationId, timestamp: new Date().toISOString(), path };

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();

      if (typeof payload === 'object' && payload !== null) {
        const record = payload as Record<string, unknown>;
        const message = record.message;
        return {
          ...base,
          statusCode: status,
          code: typeof record.code === 'string' ? record.code : this.codeFromStatus(status),
          message: Array.isArray(message)
            ? message.join('; ')
            : typeof message === 'string'
              ? message
              : exception.message,
          details:
            typeof record.details === 'object' && record.details !== null
              ? (record.details as Record<string, unknown>)
              : undefined,
        };
      }

      return {
        ...base,
        statusCode: status,
        code: this.codeFromStatus(status),
        message: typeof payload === 'string' ? payload : exception.message,
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      // P2002: violación de restricción única. Es la única que tiene un mensaje útil
      // y seguro para el usuario; el resto se trata como error interno.
      if (exception.code === 'P2002') {
        return {
          ...base,
          statusCode: HttpStatus.CONFLICT,
          code: DomainErrorCode.CONFLICT,
          message: 'Ya existe un registro con esos datos.',
        };
      }
    }

    return {
      ...base,
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: GENERIC_MESSAGE,
    };
  }

  private codeFromStatus(status: HttpStatus): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return DomainErrorCode.VALIDATION_FAILED;
      case HttpStatus.UNAUTHORIZED:
        return DomainErrorCode.UNAUTHENTICATED;
      case HttpStatus.FORBIDDEN:
        return DomainErrorCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return DomainErrorCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return DomainErrorCode.CONFLICT;
      default:
        return 'INTERNAL_ERROR';
    }
  }
}
