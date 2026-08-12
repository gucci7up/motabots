import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TelegramUpdateService } from './telegram-update.service';

describe('TelegramUpdateService', () => {
  let service: TelegramUpdateService;
  const create = jest.fn();
  const update = jest.fn();

  beforeEach(async () => {
    create.mockReset();
    update.mockReset();

    const moduleRef = await Test.createTestingModule({
      providers: [
        TelegramUpdateService,
        { provide: PrismaService, useValue: { telegramUpdate: { create, update } } },
      ],
    }).compile();

    service = moduleRef.get(TelegramUpdateService);
  });

  it('acepta un update nuevo', async () => {
    create.mockResolvedValue({});

    await expect(service.claim(1001)).resolves.toBe(true);
    expect(create).toHaveBeenCalledWith({
      data: { updateId: 1001n, status: 'PROCESSED' },
    });
  });

  it('descarta un update reentregado por Telegram', async () => {
    // P2002 = violación de la restricción única sobre updateId
    create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: '6.19.3',
      }),
    );

    await expect(service.claim(1001)).resolves.toBe(false);
  });

  it('propaga cualquier otro error de base de datos', async () => {
    create.mockRejectedValue(new Error('conexión perdida'));

    await expect(service.claim(1002)).rejects.toThrow('conexión perdida');
  });

  it('registra el motivo del fallo truncado', async () => {
    update.mockResolvedValue({});

    await service.markFailed(1003, new Error('x'.repeat(600)));

    const [call] = update.mock.calls as unknown as [{ data: { error: string; status: string } }][];
    expect(call[0].data.status).toBe('FAILED');
    expect(call[0].data.error).toHaveLength(500);
  });

  it('no lanza si no puede marcar el fallo', async () => {
    update.mockRejectedValue(new Error('base caída'));

    await expect(service.markFailed(1004, new Error('original'))).resolves.toBeUndefined();
  });
});
