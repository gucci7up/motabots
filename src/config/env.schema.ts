import { z } from 'zod';

/**
 * Esquema de variables de entorno. Se valida al arrancar: si algo falta o es inválido,
 * la aplicación no arranca. Es preferible fallar en el arranque que a mitad de una venta.
 */

/**
 * Una variable presente pero vacía (`APP_URL=` en el .env) equivale a no definida.
 * Sin esto, copiar `.env.example` tal cual haría fallar el arranque por variables opcionales.
 */
function optional<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema.optional(),
  );
}

const booleanFromString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const csvOfBigInts = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  )
  .refine((parts) => parts.every((part) => /^-?\d+$/.test(part)), {
    message: 'TELEGRAM_ADMIN_IDS debe ser una lista de IDs numéricos separados por coma',
  })
  .transform((parts) => parts.map((part) => BigInt(part)));

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    APP_URL: optional(z.string().url()),
    TZ: z.string().default('America/Santo_Domingo'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatoria'),
    DIRECT_URL: optional(z.string().min(1)),

    TELEGRAM_BOT_TOKEN: optional(z.string().min(1)),
    TELEGRAM_ADMIN_IDS: csvOfBigInts.default(''),
    TELEGRAM_WEBHOOK_SECRET: optional(z.string().min(1)),
    TELEGRAM_MODE: z.enum(['polling', 'webhook']).default('polling'),

    JWT_SECRET: optional(z.string().min(32, 'JWT_SECRET debe tener al menos 32 caracteres')),

    REDIS_URL: optional(z.string().min(1)),

    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_PATH: z.string().default('./storage'),

    STORE_NAME: z.string().default('MotaParfum'),
    STORE_PHONE: z.string().default(''),
    STORE_ADDRESS: z.string().default(''),
    CURRENCY: z.string().length(3).default('DOP'),
    CURRENCY_SYMBOL: z.string().default('RD$'),

    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info'),
    LOG_PRETTY: booleanFromString.default('false'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      if (!env.TELEGRAM_BOT_TOKEN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TELEGRAM_BOT_TOKEN'],
          message: 'TELEGRAM_BOT_TOKEN es obligatorio en producción',
        });
      }
      if (!env.JWT_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JWT_SECRET'],
          message: 'JWT_SECRET es obligatorio en producción',
        });
      }
      if (env.TELEGRAM_MODE === 'webhook') {
        if (!env.APP_URL) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['APP_URL'],
            message: 'APP_URL es obligatoria cuando TELEGRAM_MODE=webhook',
          });
        }
        if (!env.TELEGRAM_WEBHOOK_SECRET) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['TELEGRAM_WEBHOOK_SECRET'],
            message: 'TELEGRAM_WEBHOOK_SECRET es obligatorio cuando TELEGRAM_MODE=webhook',
          });
        }
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Valida el entorno. Lanza un error legible con todos los problemas a la vez,
 * sin imprimir nunca el valor de las variables (podrían ser secretos).
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuración de entorno inválida:\n${details}`);
  }

  return result.data;
}
