import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Telegraf } from 'telegraf';
import type { Update } from 'telegraf/types';
import { TelegramAuthService } from '../auth/telegram-auth.service';
import { DomainException } from '../common/exceptions/domain.exception';
import { AppConfigService } from '../config/app-config.service';
import { UsersService } from '../users/users.service';
import {
  CALLBACK,
  MENU_ENTRIES,
  mainMenuKeyboard,
  navigationKeyboard,
} from './keyboards/main-menu.keyboard';
import {
  ACCESS_DENIED_MESSAGE,
  GENERIC_ERROR_MESSAGE,
  accountMessage,
  helpMessage,
  menuMessage,
  pendingSectionMessage,
  welcomeMessage,
} from './messages';
import type { BotContext } from './telegram.context';
import { TelegramUpdateService } from './telegram-update.service';
import { CashHandler } from './handlers/cash.handler';
import { CreditsHandler } from './handlers/credits.handler';
import { CustomersHandler } from './handlers/customers.handler';
import { DashboardHandler } from './handlers/dashboard.handler';
import { ExpensesHandler } from './handlers/expenses.handler';
import type { BotHandler } from './handlers/handler.base';
import { InventoryHandler } from './handlers/inventory.handler';
import { InvoicesHandler } from './handlers/invoices.handler';
import { ReportsHandler } from './handlers/reports.handler';
import { SaleHandler } from './handlers/sale.handler';
import { SettingsHandler } from './handlers/settings.handler';

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private bot?: Telegraf<BotContext>;

  constructor(
    private readonly config: AppConfigService,
    private readonly auth: TelegramAuthService,
    private readonly users: UsersService,
    private readonly updates: TelegramUpdateService,
    private readonly dashboard: DashboardHandler,
    private readonly sale: SaleHandler,
    private readonly customers: CustomersHandler,
    private readonly inventory: InventoryHandler,
    private readonly credits: CreditsHandler,
    private readonly invoices: InvoicesHandler,
    private readonly cash: CashHandler,
    private readonly expenses: ExpensesHandler,
    private readonly reports: ReportsHandler,
    private readonly settingsHandler: SettingsHandler,
  ) {}

  /**
   * Orden de registro: los handlers de sección van antes que los genéricos, porque
   * Telegraf ejecuta el primer manejador que coincide.
   */
  private get handlers(): BotHandler[] {
    return [
      this.dashboard,
      this.sale,
      this.customers,
      this.inventory,
      this.credits,
      this.invoices,
      this.cash,
      this.expenses,
      this.reports,
      this.settingsHandler,
    ];
  }

  async onModuleInit(): Promise<void> {
    const { botToken, adminIds, mode } = this.config.telegram;

    // Crea los administradores iniciales aunque el bot no esté configurado:
    // así el seed y el arranque dejan el sistema utilizable en cuanto llegue el token.
    await this.users.ensureAdmins(adminIds);

    if (!botToken) {
      this.logger.warn('TELEGRAM_BOT_TOKEN no configurado: el bot no se inicia');
      return;
    }

    this.bot = new Telegraf<BotContext>(botToken);
    this.registerMiddleware(this.bot);
    this.registerHandlers(this.bot);

    this.bot.catch((error, ctx) => {
      this.logger.error(
        { err: error, updateType: ctx.updateType },
        'Error no controlado en el bot de Telegram',
      );
      void ctx.reply(GENERIC_ERROR_MESSAGE).catch(() => undefined);
    });

    if (mode === 'webhook') {
      await this.configureWebhook(this.bot);
    } else {
      // `launch()` no se resuelve hasta que el bot se detiene: no debe esperarse aquí.
      void this.bot.launch({ dropPendingUpdates: false }).catch((error: unknown) => {
        this.logger.error({ err: error }, 'El polling de Telegram se detuvo con error');
      });
      this.logger.log('Bot de Telegram iniciado en modo polling');
    }
  }

  onModuleDestroy(): void {
    this.bot?.stop('SIGTERM');
  }

  /**
   * Envía un mensaje suelto a un usuario. Lo usan las alertas programadas.
   * Lanza si el bot no está configurado: quien envía debe enterarse de que no salió.
   */
  async sendMessage(telegramUserId: bigint, text: string): Promise<void> {
    if (!this.bot) {
      throw new Error('El bot de Telegram no está inicializado');
    }
    await this.bot.telegram.sendMessage(Number(telegramUserId), text);
  }

  /** Punto de entrada del webhook. El controlador ya validó el secret token. */
  async handleUpdate(update: Update): Promise<void> {
    if (!this.bot) {
      this.logger.warn('Update recibido pero el bot no está inicializado');
      return;
    }
    await this.bot.handleUpdate(update);
  }

  get isRunning(): boolean {
    return this.bot !== undefined;
  }

  private async configureWebhook(bot: Telegraf<BotContext>): Promise<void> {
    const { webhookSecret } = this.config.telegram;
    const appUrl = this.config.appUrl;

    if (!appUrl || !webhookSecret) {
      // La validación de entorno ya lo impide en producción; esto cubre el resto de casos.
      this.logger.error('Modo webhook sin APP_URL o TELEGRAM_WEBHOOK_SECRET: no se registra');
      return;
    }

    const url = `${appUrl.replace(/\/$/, '')}/api/v1/telegram/webhook`;
    await bot.telegram.setWebhook(url, {
      secret_token: webhookSecret,
      drop_pending_updates: false,
    });
    this.logger.log(`Webhook de Telegram registrado en ${url}`);
  }

  private registerMiddleware(bot: Telegraf<BotContext>): void {
    // 1. Idempotencia: descarta reentregas del mismo update_id.
    bot.use(async (ctx, next) => {
      const updateId = ctx.update.update_id;
      const isNew = await this.updates.claim(updateId);
      if (!isNew) {
        return;
      }

      try {
        await next();
      } catch (error) {
        await this.updates.markFailed(updateId, error);
        throw error;
      }
    });

    // 2. Autenticación: sin usuario activo no se ejecuta ningún handler.
    bot.use(async (ctx, next) => {
      const from = ctx.from;
      if (!from) {
        return;
      }

      const user = await this.auth.authenticate({
        telegramUserId: BigInt(from.id),
        username: from.username,
        firstName: from.first_name,
        lastName: from.last_name,
      });

      if (!user) {
        await ctx.reply(ACCESS_DENIED_MESSAGE);
        return;
      }

      ctx.user = user;
      await next();
    });

    // 3. Errores de negocio: mensaje claro al usuario, sin detalles técnicos.
    bot.use(async (ctx, next) => {
      try {
        await next();
      } catch (error) {
        if (error instanceof DomainException) {
          const payload = error.getResponse() as { message?: string };
          await ctx.reply(`⚠️ ${payload.message ?? GENERIC_ERROR_MESSAGE}`);
          return;
        }
        throw error;
      }
    });
  }

  private registerHandlers(bot: Telegraf<BotContext>): void {
    const storeName = this.config.store.name;

    bot.start(async (ctx) => {
      await this.auth.registerLogin(ctx.user, {
        telegramUserId: BigInt(ctx.from.id),
        username: ctx.from.username,
      });

      await ctx.replyWithMarkdownV2(
        welcomeMessage(ctx.user, storeName),
        mainMenuKeyboard(ctx.user),
      );
    });

    bot.command('menu', async (ctx) => {
      await ctx.replyWithMarkdownV2(menuMessage(storeName), mainMenuKeyboard(ctx.user));
    });

    bot.command('ayuda', async (ctx) => {
      await ctx.replyWithMarkdownV2(helpMessage(), navigationKeyboard());
    });

    bot.action(CALLBACK.MENU, async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageText(menuMessage(storeName), {
        parse_mode: 'MarkdownV2',
        ...mainMenuKeyboard(ctx.user),
      });
    });

    bot.action(CALLBACK.ACCOUNT, async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageText(accountMessage(ctx.user), {
        parse_mode: 'MarkdownV2',
        ...navigationKeyboard(),
      });
    });

    // Handlers de cada sección. Se registran antes que los avisos genéricos.
    for (const handler of this.handlers) {
      handler.register(bot);
    }

    bot.action('noop', async (ctx) => {
      await ctx.answerCbQuery();
    });

    // Secciones aún no construidas: avisan con claridad en lugar de fingir que funcionan.
    for (const entry of MENU_ENTRIES) {
      if (entry.pendingPhase === undefined) {
        continue;
      }

      const phase = entry.pendingPhase;
      bot.action(entry.callback, async (ctx) => {
        await ctx.answerCbQuery();
        await ctx.editMessageText(pendingSectionMessage(entry.label, phase), {
          parse_mode: 'MarkdownV2',
          ...navigationKeyboard(),
        });
      });
    }
  }
}
