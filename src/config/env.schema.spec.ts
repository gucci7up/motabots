import { validateEnv } from './env.schema';

const base = { DATABASE_URL: 'postgresql://user:pass@localhost:5432/db' };

describe('validateEnv', () => {
  it('aplica los valores por defecto de desarrollo', () => {
    const env = validateEnv({ ...base });

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.TZ).toBe('America/Santo_Domingo');
    expect(env.CURRENCY).toBe('DOP');
    expect(env.CURRENCY_SYMBOL).toBe('RD$');
    expect(env.TELEGRAM_MODE).toBe('polling');
    expect(env.TELEGRAM_ADMIN_IDS).toEqual([]);
  });

  it('trata una variable opcional vacía como no definida', () => {
    // Es exactamente lo que ocurre al copiar .env.example tal cual.
    const env = validateEnv({
      ...base,
      APP_URL: '',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_WEBHOOK_SECRET: '',
      JWT_SECRET: '',
      REDIS_URL: '',
      DIRECT_URL: '',
      TELEGRAM_ADMIN_IDS: '',
    });

    expect(env.APP_URL).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.JWT_SECRET).toBeUndefined();
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.TELEGRAM_ADMIN_IDS).toEqual([]);
  });

  it('sigue validando el formato cuando la variable opcional trae valor', () => {
    expect(() => validateEnv({ ...base, APP_URL: 'no-es-una-url' })).toThrow(/APP_URL/);
  });

  it('falla si falta DATABASE_URL', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
  });

  it('convierte PORT a número', () => {
    expect(validateEnv({ ...base, PORT: '8080' }).PORT).toBe(8080);
  });

  it('rechaza un puerto fuera de rango', () => {
    expect(() => validateEnv({ ...base, PORT: '70000' })).toThrow(/PORT/);
  });

  it('parsea TELEGRAM_ADMIN_IDS como lista de BigInt', () => {
    const env = validateEnv({ ...base, TELEGRAM_ADMIN_IDS: '123456789, 987654321' });
    expect(env.TELEGRAM_ADMIN_IDS).toEqual([123456789n, 987654321n]);
  });

  it('rechaza IDs de Telegram no numéricos', () => {
    expect(() => validateEnv({ ...base, TELEGRAM_ADMIN_IDS: 'juan,123' })).toThrow(
      /TELEGRAM_ADMIN_IDS/,
    );
  });

  it('rechaza un JWT_SECRET corto', () => {
    expect(() => validateEnv({ ...base, JWT_SECRET: 'corto' })).toThrow(/JWT_SECRET/);
  });

  describe('en producción', () => {
    const production = {
      ...base,
      NODE_ENV: 'production',
      TELEGRAM_BOT_TOKEN: 'token-de-prueba',
      JWT_SECRET: 'x'.repeat(32),
    };

    it('exige TELEGRAM_BOT_TOKEN y JWT_SECRET', () => {
      expect(() => validateEnv({ ...base, NODE_ENV: 'production' })).toThrow(
        /TELEGRAM_BOT_TOKEN/,
      );
    });

    it('acepta una configuración completa con polling', () => {
      expect(validateEnv(production).NODE_ENV).toBe('production');
    });

    it('exige APP_URL y secreto cuando el modo es webhook', () => {
      expect(() => validateEnv({ ...production, TELEGRAM_MODE: 'webhook' })).toThrow(
        /APP_URL|TELEGRAM_WEBHOOK_SECRET/,
      );
    });

    it('acepta webhook con APP_URL y secreto', () => {
      const env = validateEnv({
        ...production,
        TELEGRAM_MODE: 'webhook',
        APP_URL: 'https://admin.motaparfum.com',
        TELEGRAM_WEBHOOK_SECRET: 'secreto',
      });
      expect(env.TELEGRAM_MODE).toBe('webhook');
    });
  });

  it('no incluye el valor de las variables en el mensaje de error', () => {
    const secret = 'valor-secretisimo';
    try {
      validateEnv({ ...base, JWT_SECRET: secret, NODE_ENV: 'produccion-mal-escrito' });
      fail('debió lanzar');
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});
