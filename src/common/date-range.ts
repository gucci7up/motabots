/**
 * Rangos de fecha para reportes.
 *
 * Todo se almacena en UTC. Los cortes se calculan en hora de República Dominicana
 * (UTC−4, sin horario de verano): sin esto, una venta de las 9 PM aparecería en el
 * día siguiente y el cierre de caja nocturno caería en el día equivocado.
 */

/** Desfase fijo de República Dominicana. El país no aplica horario de verano. */
export const DO_UTC_OFFSET_HOURS = -4;

export interface DateRange {
  from: Date;
  to: Date;
  label: string;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Momento actual expresado en hora local dominicana. */
function nowLocal(reference = new Date()): Date {
  return new Date(reference.getTime() + DO_UTC_OFFSET_HOURS * HOUR_MS);
}

/** Convierte una hora local dominicana a UTC. */
function toUtc(local: Date): Date {
  return new Date(local.getTime() - DO_UTC_OFFSET_HOURS * HOUR_MS);
}

/** Inicio del día local (00:00:00.000) expresado en UTC. */
export function startOfLocalDay(reference = new Date()): Date {
  const local = nowLocal(reference);
  local.setUTCHours(0, 0, 0, 0);
  return toUtc(local);
}

/** Fin del día local (23:59:59.999) expresado en UTC. */
export function endOfLocalDay(reference = new Date()): Date {
  return new Date(startOfLocalDay(reference).getTime() + DAY_MS - 1);
}

export function today(reference = new Date()): DateRange {
  return { from: startOfLocalDay(reference), to: endOfLocalDay(reference), label: 'Hoy' };
}

export function yesterday(reference = new Date()): DateRange {
  const previous = new Date(reference.getTime() - DAY_MS);
  return { from: startOfLocalDay(previous), to: endOfLocalDay(previous), label: 'Ayer' };
}

/** Últimos 7 días, incluido hoy. */
export function thisWeek(reference = new Date()): DateRange {
  const start = new Date(reference.getTime() - 6 * DAY_MS);
  return { from: startOfLocalDay(start), to: endOfLocalDay(reference), label: 'Últimos 7 días' };
}

/** Del día 1 del mes local hasta hoy. */
export function thisMonth(reference = new Date()): DateRange {
  const local = nowLocal(reference);
  const firstDay = new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1, 0, 0, 0, 0),
  );

  return {
    from: toUtc(firstDay),
    to: endOfLocalDay(reference),
    label: 'Este mes',
  };
}

/** Rango personalizado a partir de fechas locales (YYYY-MM-DD). */
export function customRange(fromIso: string, toIso: string): DateRange {
  const from = parseLocalDate(fromIso);
  const to = parseLocalDate(toIso);

  if (from.getTime() > to.getTime()) {
    throw new RangeError('La fecha inicial no puede ser posterior a la final.');
  }

  return {
    from,
    to: new Date(to.getTime() + DAY_MS - 1),
    label: `${fromIso} a ${toIso}`,
  };
}

function parseLocalDate(iso: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!match) {
    throw new RangeError(`Fecha inválida: ${iso}. Usa el formato YYYY-MM-DD.`);
  }

  const [, year, month, day] = match;
  const local = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0));
  return toUtc(local);
}

/** Formatea una fecha UTC en hora local dominicana como DD/MM/YYYY. */
export function formatLocalDate(date: Date): string {
  const local = nowLocal(date);
  const day = String(local.getUTCDate()).padStart(2, '0');
  const month = String(local.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${local.getUTCFullYear()}`;
}
