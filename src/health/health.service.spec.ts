import { Test } from '@nestjs/testing';
import { PrismaService } from '../database/prisma.service';
import { HealthService } from './health.service';

describe('HealthService', () => {
  let service: HealthService;
  const healthCheck = jest.fn();

  beforeEach(async () => {
    healthCheck.mockReset();

    const moduleRef = await Test.createTestingModule({
      providers: [HealthService, { provide: PrismaService, useValue: { healthCheck } }],
    }).compile();

    service = moduleRef.get(HealthService);
  });

  it('liveness responde sin tocar la base de datos', () => {
    const result = service.liveness();

    expect(result.status).toBe('ok');
    expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(healthCheck).not.toHaveBeenCalled();
  });

  it('readiness reporta ok cuando PostgreSQL responde', async () => {
    healthCheck.mockResolvedValue(true);

    const result = await service.readiness();

    expect(result.status).toBe('ok');
    expect(result.checks.database.status).toBe('up');
    expect(result.checks.database.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('readiness reporta degraded cuando PostgreSQL falla', async () => {
    healthCheck.mockRejectedValue(new Error('connection refused'));

    const result = await service.readiness();

    expect(result.status).toBe('degraded');
    expect(result.checks.database).toEqual({ status: 'down' });
  });
});
