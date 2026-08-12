import type { Context } from 'telegraf';
import type { AuthenticatedUser } from '../users/users.service';

/**
 * Contexto de Telegraf con el usuario ya resuelto por el middleware de autenticación.
 * Si un handler se ejecuta, `user` está garantizado: el middleware corta antes si no hay acceso.
 */
export interface BotContext extends Context {
  user: AuthenticatedUser;
}
