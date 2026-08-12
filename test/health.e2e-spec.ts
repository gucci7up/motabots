import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import type { HealthResult } from '../src/health/health.service';

/**
 * Prueba de integración real: arranca la aplicación completa contra PostgreSQL.
 * Requiere DATABASE_URL apuntando a una base accesible (ver docs/development.md).
 */
describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['health', 'health/ready'] });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  const get = (path: string) => request(app.getHttpServer() as Server).get(path);

  it('GET /health responde ok', async () => {
    const response = await get('/health').expect(200);
    const body = response.body as { status: string; uptimeSeconds: number };

    expect(body.status).toBe('ok');
    expect(typeof body.uptimeSeconds).toBe('number');
  });

  it('GET /health/ready confirma la conexión con PostgreSQL', async () => {
    const response = await get('/health/ready').expect(200);
    const body = response.body as HealthResult;

    expect(body.status).toBe('ok');
    expect(body.checks.database.status).toBe('up');
  });

  it('devuelve 404 con formato de error estándar en una ruta inexistente', async () => {
    const response = await get('/no-existe').expect(404);
    const body = response.body as { statusCode: number; code: string; correlationId: string };

    expect(body).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    expect(typeof body.correlationId).toBe('string');
  });
});
