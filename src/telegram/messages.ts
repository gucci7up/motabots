import type { AuthenticatedUser } from '../users/users.service';

/** Escapa los caracteres reservados de MarkdownV2 de Telegram. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (char) => `\\${char}`);
}

export function displayName(user: AuthenticatedUser): string {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  if (name.length > 0) {
    return name;
  }
  return user.username ? `@${user.username}` : `ID ${user.telegramUserId.toString()}`;
}

export function welcomeMessage(user: AuthenticatedUser, storeName: string): string {
  return [
    `*${escapeMarkdown(storeName.toUpperCase())} ADMIN*`,
    '',
    `Hola, ${escapeMarkdown(displayName(user))}\\.`,
    `Rol: *${escapeMarkdown(user.roleName)}*`,
    '',
    'Elige una opción:',
  ].join('\n');
}

export function menuMessage(storeName: string): string {
  return [`*${escapeMarkdown(storeName.toUpperCase())} ADMIN*`, '', 'Elige una opción:'].join('\n');
}

export function accountMessage(user: AuthenticatedUser): string {
  return [
    '*👤 MI CUENTA*',
    '',
    `Nombre: ${escapeMarkdown(displayName(user))}`,
    `ID de Telegram: \`${user.telegramUserId.toString()}\``,
    `Rol: *${escapeMarkdown(user.roleName)}*`,
    `Permisos: ${user.permissions.length}`,
  ].join('\n');
}

export function pendingSectionMessage(label: string, phase: number): string {
  return [
    `*${escapeMarkdown(label)}*`,
    '',
    `Esta sección todavía no está disponible\\. Llega en la fase ${phase}\\.`,
  ].join('\n');
}

export const ACCESS_DENIED_MESSAGE =
  'No tienes acceso a este sistema. Si crees que es un error, contacta al administrador.';

export const GENERIC_ERROR_MESSAGE =
  '❌ No pudimos completar la operación. Inténtalo nuevamente.';

export const NO_PERMISSION_MESSAGE = '🔒 No tienes permiso para realizar esta operación.';

export function helpMessage(): string {
  return [
    '*AYUDA*',
    '',
    'Comandos disponibles:',
    '/start \\- Iniciar y ver el menú',
    '/menu \\- Menú principal',
    '/ayuda \\- Esta ayuda',
    '',
    'Casi todo se hace con los botones del menú\\.',
  ].join('\n');
}
