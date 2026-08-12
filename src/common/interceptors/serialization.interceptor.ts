import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { map, Observable } from 'rxjs';

/**
 * `Prisma.Decimal` y `BigInt` no se serializan a JSON de forma nativa: el primero saldría
 * como un objeto interno de decimal.js y el segundo lanzaría TypeError.
 *
 * Se emiten como string para no perder precisión. Un cliente que reciba "2600.00" puede
 * decidir cómo formatearlo; si emitiéramos `number` perderíamos centavos en importes grandes.
 */
@Injectable()
export class SerializationInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((data) => serialize(data)));
  }
}

export function serialize(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (Prisma.Decimal.isDecimal(value)) {
    return value.toString();
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => serialize(item));
  }

  if (typeof value === 'object') {
    // Sólo se recorren objetos planos: instancias de clases con lógica propia se dejan intactas.
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return value;
    }

    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = serialize(item);
    }
    return result;
  }

  return value;
}
