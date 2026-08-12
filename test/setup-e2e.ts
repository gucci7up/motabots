import { config } from 'dotenv';

/**
 * Las pruebas de integración corren contra un esquema aislado (`TEST_DATABASE_URL`),
 * nunca contra los datos reales. Si no está configurado, se abortan: es preferible no
 * ejecutar pruebas a ejecutarlas sobre producción.
 */
config();

const testUrl = process.env.TEST_DATABASE_URL;

if (!testUrl) {
  throw new Error(
    'TEST_DATABASE_URL no está definida. Las pruebas de integración necesitan una base ' +
      'separada; consulta docs/development.md.',
  );
}

if (!/schema=/.test(testUrl)) {
  throw new Error('TEST_DATABASE_URL debe apuntar a un esquema propio (?schema=...).');
}

process.env.DATABASE_URL = testUrl;
process.env.DIRECT_URL = testUrl;
process.env.NODE_ENV = 'test';
// El bot no debe arrancar durante las pruebas.
delete process.env.TELEGRAM_BOT_TOKEN;
