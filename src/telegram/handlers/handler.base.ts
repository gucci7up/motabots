import { Logger } from '@nestjs/common';
import { Markup, Telegraf } from 'telegraf';
import type { InlineKeyboardMarkup } from 'telegraf/types';
import { assertPermission } from '../../auth/permission.checker';
import { PermissionCode } from '../../roles/permissions';
import type { BotContext } from '../telegram.context';

/** Contrato de todo grupo de handlers del bot. */
export interface BotHandler {
  register(bot: Telegraf<BotContext>): void;
}

export const PAGE_SIZE = 8;

/**
 * Utilidades compartidas por los handlers.
 *
 * Los handlers son sólo transporte: interpretan la intención, llaman a un servicio de
 * dominio y formatean la respuesta. Nunca consultan la base de datos directamente.
 */
export abstract class BaseHandler implements BotHandler {
  protected readonly logger = new Logger(this.constructor.name);

  abstract register(bot: Telegraf<BotContext>): void;

  /**
   * Edita el mensaje actual. Telegram falla si el contenido es idéntico al anterior:
   * ese error es inofensivo y se ignora, cualquier otro se propaga.
   */
  protected async edit(
    ctx: BotContext,
    text: string,
    keyboard: Markup.Markup<InlineKeyboardMarkup>,
  ): Promise<void> {
    try {
      await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...keyboard });
    } catch (error) {
      if (this.isUnchangedMessageError(error)) {
        return;
      }
      throw error;
    }
  }

  protected async reply(
    ctx: BotContext,
    text: string,
    keyboard?: Markup.Markup<InlineKeyboardMarkup>,
  ): Promise<void> {
    await ctx.reply(text, { parse_mode: 'MarkdownV2', ...(keyboard ?? {}) });
  }

  /** Comprueba el permiso y avisa al usuario si no lo tiene, sin ejecutar la acción. */
  protected async ensure(ctx: BotContext, permission: PermissionCode): Promise<boolean> {
    try {
      assertPermission(ctx.user, permission);
      return true;
    } catch {
      await ctx.answerCbQuery('🔒 No tienes permiso para esto', { show_alert: true });
      return false;
    }
  }

  /** Fila de paginación. Devuelve un arreglo vacío si sólo hay una página. */
  protected paginationRow(
    prefix: string,
    page: number,
    totalPages: number,
  ): ReturnType<typeof Markup.button.callback>[] {
    if (totalPages <= 1) {
      return [];
    }

    const buttons: ReturnType<typeof Markup.button.callback>[] = [];

    if (page > 1) {
      buttons.push(Markup.button.callback('⬅️', `${prefix}:${page - 1}`));
    }
    buttons.push(Markup.button.callback(`${page}/${totalPages}`, 'noop'));
    if (page < totalPages) {
      buttons.push(Markup.button.callback('➡️', `${prefix}:${page + 1}`));
    }

    return buttons;
  }

  /** Extrae el parámetro de un callback con formato `prefijo:valor`. */
  protected callbackParam(ctx: BotContext): string | undefined {
    const query = ctx.callbackQuery;
    if (!query || !('data' in query)) {
      return undefined;
    }
    const [, ...rest] = query.data.split(':');
    return rest.length > 0 ? rest.join(':') : undefined;
  }

  protected pageFromCallback(ctx: BotContext): number {
    const raw = this.callbackParam(ctx);
    const page = Number(raw);
    return Number.isInteger(page) && page > 0 ? page : 1;
  }

  private isUnchangedMessageError(error: unknown): boolean {
    return (
      error instanceof Error && error.message.includes('message is not modified')
    );
  }
}
