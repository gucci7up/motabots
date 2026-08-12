import { Test } from '@nestjs/testing';
import type { Update } from 'telegraf/types';
import { AppConfigService } from '../config/app-config.service';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';

const update = { update_id: 1, message: { text: '/start' } } as unknown as Update;

describe('TelegramController (webhook)', () => {
  const handleUpdate = jest.fn();

  async function buildController(webhookSecret?: string): Promise<TelegramController> {
    handleUpdate.mockReset();
    handleUpdate.mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      controllers: [TelegramController],
      providers: [
        { provide: TelegramService, useValue: { handleUpdate } },
        {
          provide: AppConfigService,
          useValue: { telegram: { webhookSecret, botToken: 't', adminIds: [], mode: 'webhook' } },
        },
      ],
    }).compile();

    return moduleRef.get(TelegramController);
  }

  it('procesa el update cuando el secret token coincide', async () => {
    const controller = await buildController('secreto-correcto');

    await expect(controller.webhook(update, 'secreto-correcto')).resolves.toEqual({ ok: true });
    expect(handleUpdate).toHaveBeenCalledWith(update);
  });

  it('descarta el update si el secret token no coincide', async () => {
    const controller = await buildController('secreto-correcto');

    await controller.webhook(update, 'secreto-incorrecto');

    expect(handleUpdate).not.toHaveBeenCalled();
  });

  it('descarta el update si no llega el secret token', async () => {
    const controller = await buildController('secreto-correcto');

    await controller.webhook(update, undefined);

    expect(handleUpdate).not.toHaveBeenCalled();
  });

  it('descarta todo si el servidor no tiene secreto configurado', async () => {
    const controller = await buildController(undefined);

    await controller.webhook(update, 'lo-que-sea');

    expect(handleUpdate).not.toHaveBeenCalled();
  });

  it('responde 200 aunque falle el procesamiento, para que Telegram no reintente en bucle', async () => {
    const controller = await buildController('secreto-correcto');
    handleUpdate.mockRejectedValue(new Error('fallo interno'));

    await expect(controller.webhook(update, 'secreto-correcto')).resolves.toEqual({ ok: true });
  });

  it('responde igual ante un token inválido que ante uno válido, sin filtrar información', async () => {
    const controller = await buildController('secreto-correcto');

    const valido = await controller.webhook(update, 'secreto-correcto');
    const invalido = await controller.webhook(update, 'otro');

    expect(invalido).toEqual(valido);
  });
});
