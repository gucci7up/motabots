# Modelo de datos — MotaParfum Admin

PostgreSQL 17 + Prisma. Todas las tablas usan `id` CUID (texto), `createdAt`/`updatedAt`.
Los importes son `Decimal(14,2)`; los costos unitarios `Decimal(14,4)`; las cantidades
`Decimal(14,3)` (permite vender fracciones si algún día se venden decantados a granel).

## Convenciones

- **Sin borrado físico** en: sales, sale_items, payments, invoices, inventory_movements,
  credit_accounts, accounting_entries, audit_logs, cash_sessions. Se usan estados y
  operaciones inversas.
- **Snapshots**: las líneas de venta copian nombre, precio y costo al momento de vender.
  Cambiar el precio de un producto mañana no altera ventas pasadas.
- **Índices** en toda columna usada para filtrar reportes: `createdAt`, `customerId`,
  `status`, `productVariantId`.

---

## Identidad y acceso

### roles
`id, name (único: ADMIN|SELLER|ACCOUNTANT|…), description, isSystem, createdAt, updatedAt`

`isSystem` protege los roles base para que no se borren desde Telegram.

### permissions
`id, code (único, ej. "sales.create"), description, group`

Catálogo sembrado por el seed. Código estable, nunca se renombra.

### role_permissions
`roleId, permissionId` — PK compuesta.

### users
`id, telegramUserId (BigInt, único), username, firstName, lastName, roleId, isActive,
lastLoginAt, createdAt, updatedAt`

`telegramUserId` es la identidad. No hay contraseñas: la autenticación es la posesión de la
cuenta de Telegram, más una allowlist (`TELEGRAM_ADMIN_IDS` para el primer admin, luego la
tabla `users` con `isActive`).

---

## Catálogo

### categories
`id, name (único), description, isActive, createdAt, updatedAt`

### products
`id, name, sku (único, opcional), categoryId, description, brand, isActive, createdAt, updatedAt`

### product_variants
`id, productId, name, sku (único, opcional), barcode (único, opcional), size, unit,
salePrice Decimal(14,2), costPrice Decimal(14,4), minimumStock Decimal(14,3),
currentStock Decimal(14,3), isActive, createdAt, updatedAt`

`size` es texto libre y `unit` un enum extensible (`ML`, `OZ`, `G`, `UNIT`, `PACK`): no se
asume que todo se mide en ml. Todo producto tiene al menos una variante; los productos sin
tamaño usan una variante `unit = UNIT`.

`currentStock` es una proyección mantenida dentro de transacción — la verdad está en
`inventory_movements`.

---

## Inventario

### inventory_movements
`id, productVariantId, type, quantity Decimal(14,3) (siempre positiva),
direction (IN|OUT), stockBefore, stockAfter, unitCost Decimal(14,4), totalCost Decimal(14,2),
referenceType, referenceId, userId, notes, createdAt`

`type`: `PURCHASE | SALE | RETURN | ADJUSTMENT_IN | ADJUSTMENT_OUT | DAMAGE | INITIAL_STOCK | SALE_CANCELLATION`

`referenceType`/`referenceId` apuntan a la venta, compra o ajuste que originó el movimiento
(relación polimórfica ligera; se valida en la capa de servicio).

Índices: `(productVariantId, createdAt)`, `(referenceType, referenceId)`.

---

## Clientes

### customers
`id, name, phone, email, address, identificationNumber, notes, creditLimit Decimal(14,2)?,
isActive, createdAt, updatedAt`

Índices de búsqueda: `name` (trigram/`ILIKE`), `phone`, `identificationNumber`.

El saldo pendiente **no se guarda** como columna: se calcula como
`SUM(credit_accounts.balance WHERE status IN (PENDING, PARTIAL, OVERDUE))`. Evita un campo
desincronizado. Si el volumen lo exige, se añadirá una vista materializada.

---

## Ventas

### sales
`id, saleNumber (único), invoiceId?, customerId?, userId, subtotal, discount, taxAmount,
total, paidAmount, pendingAmount, paymentStatus, saleStatus, notes, idempotencyKey (único, opcional),
cancelledAt?, cancelledBy?, cancellationReason?, createdAt, updatedAt`

- `saleStatus`: `COMPLETED | CANCELLED`
- `paymentStatus`: `PAID | PARTIAL | CREDIT`

Invariante: `total = subtotal - discount + taxAmount` y `paidAmount + pendingAmount = total`.
Se valida en el servicio y con un `CHECK` a nivel de base de datos.

### sale_items
`id, saleId, productVariantId, descriptionSnapshot, quantity, unitPrice, discount,
unitCostSnapshot Decimal(14,4), subtotal, total`

`unitCostSnapshot` es la base de todo cálculo de utilidad. No se recalcula jamás.

---

## Pagos y créditos

### payments
`id, saleId?, creditAccountId?, customerId?, amount, method, reference, notes, userId,
cashSessionId?, isReversal, reversedPaymentId?, idempotencyKey (único, opcional), createdAt`

`method`: `CASH | BANK_TRANSFER | CARD | MOBILE_PAYMENT | OTHER`

Un pago nunca se borra ni se edita. Corregir un pago = crear un pago de reversión
(`isReversal = true`, monto negativo respecto al original, `reversedPaymentId` apuntando al
original).

`paidAmount` de una venta se deriva siempre de la suma de sus pagos: no se toca a mano.

### credit_accounts
`id, saleId (único), customerId, originalAmount, paidAmount, balance, dueDate, status,
closedAt?, cancelledAt?, createdAt, updatedAt`

`status`: `PENDING | PARTIAL | PAID | OVERDUE | CANCELLED`

`OVERDUE` lo asigna un job diario comparando `dueDate < hoy` con `balance > 0`; no es un estado
que el usuario asigne. `balance = originalAmount - paidAmount` (invariante con `CHECK >= 0`).

---

## Facturación

### invoice_sequences
`id, series (único), prefix, format, nextNumber, padding, isActive`

El consecutivo se toma con `SELECT ... FOR UPDATE` dentro de la transacción de la venta.

### invoices
`id, number (único), series, saleId (único), customerId?, issueDate, subtotal, discount,
taxAmount, total, paidAmount, pendingAmount, status, notes,
fiscalType?, fiscalNumber?, fiscalSequenceId?, customerTaxId?,
pdfStorageKey?, pdfChecksum?, pdfSizeBytes?,
cancelledAt?, cancelledBy?, cancellationReason?, createdAt, updatedAt`

`status`: `ISSUED | PAID | PARTIAL | CREDIT | CANCELLED`

Los campos `fiscal*` quedan definidos y nulos: es el gancho para NCF/e-CF de la DGII sin
migración destructiva futura. `fiscal_sequences` (rangos NCF autorizados, con vigencia y
consumo) se crea vacía y sin uso hasta que se solicite.

---

## Caja

### cash_sessions
`id, openedBy, openedAt, openingAmount, closedBy?, closedAt?, expectedCash?, actualCash?,
difference?, status (OPEN|CLOSED), notes`

Sólo puede existir **una** sesión `OPEN` a la vez: índice único parcial
`CREATE UNIQUE INDEX ... ON cash_sessions (status) WHERE status = 'OPEN'`.

Una sesión cerrada es inmutable. Reabrirla exige una operación de auditoría explícita que deja
registro (no disponible desde Telegram).

### cash_movements
`id, cashSessionId, type, direction (IN|OUT), amount, referenceType, referenceId, description,
userId, createdAt`

`type`: `OPENING | SALE | CREDIT_COLLECTION | EXPENSE | MANUAL_IN | MANUAL_OUT | CLOSING | ADJUSTMENT`

`expectedCash = openingAmount + SUM(IN) - SUM(OUT)`, calculado desde los movimientos.

---

## Gastos

### expense_categories
`id, code (único), name, isActive, isSystem`

Sembradas: `INVENTORY, PACKAGING, DELIVERY, MARKETING, TRANSPORT, SERVICES, RENT, SALARY, OTHER`.

### expenses
`id, expenseCategoryId, amount, description, paymentMethod, reference, userId, cashSessionId?,
expenseDate, createdAt, updatedAt`

Si `paymentMethod = CASH` y hay caja abierta, se crea el `cash_movement` correspondiente en la
misma transacción.

---

## Contabilidad

### accounting_entries
`id, entryDate, type, referenceType, referenceId, description, amount, userId, createdAt`

`type`: `REVENUE | COST_OF_GOODS_SOLD | EXPENSE | CREDIT_ISSUED | CREDIT_COLLECTED |
INVENTORY_IN | INVENTORY_ADJUSTMENT | CASH_IN | CASH_OUT`

Es un libro auxiliar administrativo, no una partida doble fiscal completa. La estructura
(`accounting_entries` + un futuro `accounting_entry_lines` con débito/haber) permite migrar a
partida doble sin rehacer el historial.

Utilidad, siempre desde snapshots:
```
Utilidad bruta = SUM(sale_items.total) - SUM(sale_items.quantity * unitCostSnapshot)
Utilidad neta  = Utilidad bruta - SUM(expenses.amount)
```
Sólo se consideran ventas con `saleStatus = COMPLETED`.

---

## Configuración

### settings
`id, key (único), value (Json), type, description, updatedBy, updatedAt`

Claves iniciales: `store.name`, `store.phone`, `store.address`, `store.logoStorageKey`,
`currency` (`DOP`), `currencySymbol` (`RD$`), `invoice.prefix`, `invoice.format`,
`tax.enabled`, `tax.rate`, `inventory.allowNegativeStock` (false), `credit.enabled`,
`credit.defaultDueDays`, `alerts.lowStock.enabled`, `alerts.dailySummary.hour`.

---

## Auditoría e idempotencia

### audit_logs
`id, userId?, action, entity, entityId, before (Json?), after (Json?), metadata (Json?),
ipAddress?, source (TELEGRAM|API|SYSTEM), createdAt`

Append-only. Sin endpoint ni botón de borrado. Índices: `(entity, entityId)`, `(userId, createdAt)`.

### telegram_updates
`id, updateId (BigInt, único), processedAt, status, error?`

Guarda los `update_id` ya procesados para descartar reentregas de Telegram (idempotencia del
webhook). Se purga con retención configurable (por defecto 30 días) mediante job, no manualmente.

---

## Diagrama de relaciones (resumen)

```
roles ──< users ──< sales ──< sale_items >── product_variants >── products >── categories
                      │                            │
                      ├──< payments                └──< inventory_movements
                      ├──1 invoices
                      ├──1 credit_accounts >── customers
                      └──< accounting_entries

cash_sessions ──< cash_movements
expense_categories ──< expenses ──> cash_sessions
users ──< audit_logs
```
