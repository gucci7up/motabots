import { Injectable, Logger } from '@nestjs/common';

/**
 * Estado conversacional del bot (carrito en construcción, importe que se está pidiendo).
 *
 * NO es fuente de verdad de negocio: sólo acumula la intención del usuario hasta que
 * confirma. Si se pierde, no se pierde ningún dato: simplemente hay que rehacer el flujo.
 * Por eso vive en memoria con TTL y no en la base de datos.
 */

export interface CartLine {
  productVariantId: string;
  description: string;
  quantity: string;
  unitPrice: string;
}

export type WizardStep =
  | 'idle'
  | 'sale:customer_search'
  | 'sale:customer_new_name'
  | 'sale:customer_new_phone'
  | 'sale:product_search'
  | 'sale:quantity'
  | 'sale:discount'
  | 'sale:payment_amount'
  | 'sale:due_date'
  | 'credit:amount'
  | 'credit:reference'
  | 'cash:open_amount'
  | 'cash:close_amount'
  | 'expense:amount'
  | 'expense:description'
  | 'customer:new_name'
  | 'customer:new_phone'
  | 'customer:search'
  | 'inventory:search'
  | 'inventory:quantity';

export interface SessionState {
  step: WizardStep;
  /** Clave de idempotencia del carrito: se genera al abrirlo y viaja hasta la confirmación. */
  idempotencyKey?: string;
  customerId?: string | null;
  customerName?: string;
  newCustomerName?: string;
  cart: CartLine[];
  discount?: string;
  /** A qué pantalla volver tras escribir el descuento, según desde dónde se pidió. */
  discountReturnTo?: 'cart' | 'payment';
  paidAmount?: string;
  paymentMethod?: string;
  dueDate?: string;
  /** Identificador del elemento sobre el que se está operando (crédito, variante, gasto). */
  targetId?: string;
  targetLabel?: string;
  expenseCategoryCode?: string;
  expenseAmount?: string;
  page?: number;
  updatedAt: number;
}

const TTL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

function emptyState(): SessionState {
  return { step: 'idle', cart: [], updatedAt: Date.now() };
}

@Injectable()
export class SessionStore {
  private readonly logger = new Logger(SessionStore.name);
  private readonly sessions = new Map<string, SessionState>();
  private readonly sweeper: NodeJS.Timeout;

  constructor() {
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    // No debe impedir que el proceso termine.
    this.sweeper.unref();
  }

  get(userId: string): SessionState {
    const existing = this.sessions.get(userId);

    if (!existing || Date.now() - existing.updatedAt > TTL_MS) {
      const fresh = emptyState();
      this.sessions.set(userId, fresh);
      return fresh;
    }

    return existing;
  }

  update(userId: string, patch: Partial<SessionState>): SessionState {
    const current = this.get(userId);
    const next: SessionState = { ...current, ...patch, updatedAt: Date.now() };
    this.sessions.set(userId, next);
    return next;
  }

  setStep(userId: string, step: WizardStep): SessionState {
    return this.update(userId, { step });
  }

  clear(userId: string): void {
    this.sessions.set(userId, emptyState());
  }

  addToCart(userId: string, line: CartLine): SessionState {
    const session = this.get(userId);
    return this.update(userId, { cart: [...session.cart, line] });
  }

  removeFromCart(userId: string, index: number): SessionState {
    const session = this.get(userId);
    return this.update(userId, { cart: session.cart.filter((_, i) => i !== index) });
  }

  private sweep(): void {
    const cutoff = Date.now() - TTL_MS;
    let removed = 0;

    for (const [userId, state] of this.sessions) {
      if (state.updatedAt < cutoff) {
        this.sessions.delete(userId);
        removed++;
      }
    }

    if (removed > 0) {
      this.logger.debug(`Sesiones expiradas eliminadas: ${removed}`);
    }
  }
}
