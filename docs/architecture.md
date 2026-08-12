# Arquitectura — MotaParfum Admin

## 1. Propósito

Sistema administrativo (mini ERP/POS) para MotaParfum. La interfaz principal es un bot de
Telegram; el núcleo es una API NestJS + PostgreSQL. Un dashboard web es una segunda etapa:
la API se diseña desde el inicio para soportarlo, pero no se implementa ahora.

## 2. Independencia de n8n

Requisito crítico. Este sistema:

- No lee ni escribe la base de datos de n8n.
- No llama webhooks de n8n como parte de ninguna operación de negocio.
- No asume nada sobre los workflows existentes.
- Funciona completo con n8n apagado.

Las integraciones futuras (n8n, WhatsApp, tienda web, Instagram) entrarán como **consumidores
de la API REST**, nunca como dependencias del núcleo. Ver §9.

## 3. Vista de alto nivel

```
                 ┌──────────────────────────────┐
   Telegram ────►│  TelegramModule (transporte) │
                 │  handlers / scenes / keyboards│
                 └───────────────┬──────────────┘
                                 │  (sólo llamadas a servicios)
   HTTP/REST ───►┌───────────────▼──────────────┐
   (futuro web)  │   Módulos de dominio         │
                 │   sales, credits, cash, ...  │
                 └───────────────┬──────────────┘
                                 │
                 ┌───────────────▼──────────────┐
                 │   PrismaService (transacciones)│
                 └───────────────┬──────────────┘
                                 │
                          ┌──────▼──────┐
                          │ PostgreSQL  │
                          └─────────────┘
```

Regla dura: **Telegram nunca toca SQL ni Prisma directamente.** Un handler de Telegram
solamente: (a) parsea la intención del usuario, (b) construye un DTO, (c) llama a un servicio
de aplicación, (d) formatea la respuesta. Toda la lógica de negocio vive en los servicios de
dominio, de modo que el dashboard web futuro reutilice exactamente la misma lógica.

## 4. Estructura de carpetas

```
src/
  main.ts                 bootstrap, Swagger, filtros globales
  app.module.ts
  config/                 configuración tipada + validación de env (Joi/zod)
  common/                 decoradores, filtros, interceptores, pipes, utilidades (Money, paginación)
  database/               PrismaModule, PrismaService, helpers de transacción
  health/                 /health (liveness/readiness)
  auth/                   resolución de identidad Telegram → User, guards
  users/
  roles/                  roles + permisos
  telegram/               transporte del bot: comandos, callbacks, sesiones, teclados
  customers/
  categories/
  products/               productos + variantes
  inventory/              movimientos de inventario
  sales/
  payments/
  credits/
  invoices/               numeración, PDF, almacenamiento
  cash/                   sesiones de caja
  expenses/
  accounting/             asientos + cálculo de utilidad
  reports/
  audit/                  audit_logs
  settings/               configuración de la tienda
prisma/
  schema.prisma
  migrations/
  seed.ts
docs/
test/
```

Cada módulo de dominio expone: `*.module.ts`, `*.service.ts`, `*.controller.ts` (cuando aplica),
`dto/`, y tests. Los módulos de dominio **no importan** el módulo de Telegram; la dependencia
va en un solo sentido (Telegram → dominio).

## 5. Decisiones técnicas

### 5.1 Dinero
Nunca `float`/`number` para dinero. En Prisma: `Decimal @db.Decimal(14,2)` para importes y
`Decimal @db.Decimal(14,4)` para costos unitarios (permite promediar costos sin perder centavos).
En TypeScript se usa `Prisma.Decimal` (decimal.js) end-to-end. Se prohíbe convertir a `number`
salvo para presentación final ya formateada. Utilidad `common/money.ts` centraliza suma, resta,
multiplicación y redondeo `ROUND_HALF_UP` a 2 decimales.

### 5.2 Transacciones
Toda operación que toque dinero o inventario corre dentro de `prisma.$transaction(fn, { isolationLevel: Serializable })`
o `ReadCommitted` + bloqueo explícito según el caso (ver §5.3). Una venta es atómica: o se crean
venta, items, movimientos de inventario, factura, pago, crédito, movimiento de caja, asientos y
auditoría — o no se crea nada.

### 5.3 Concurrencia de inventario
El riesgo: dos ventas simultáneas del último producto. Estrategia:

1. Dentro de la transacción, `SELECT ... FOR UPDATE` sobre las filas de `product_variants`
   involucradas, **ordenadas por id ascendente** (evita deadlocks entre transacciones que
   compran los mismos productos en distinto orden).
2. Recalcular el stock disponible desde la fila bloqueada.
3. Validar contra `allowNegativeStock` de settings.
4. Escribir el movimiento y actualizar `currentStock`.

`currentStock` en la variante es una **proyección** mantenida transaccionalmente; la fuente de
verdad es `inventory_movements`. Existe un comando de reconciliación que recomputa `currentStock`
desde los movimientos y reporta diferencias.

### 5.4 Idempotencia
- **Webhook de Telegram**: cada `update_id` se inserta en `telegram_updates` con constraint único
  antes de procesarse. Si ya existe, el update se descarta con 200 OK. Telegram reintenta ante
  timeouts, y sin esto una venta podría duplicarse.
- **Ventas y pagos**: aceptan una `idempotencyKey` opcional (única). El flujo de Telegram genera
  la clave al construir el carrito, de modo que un doble tap en «Confirmar» no crea dos ventas.

### 5.5 Historial financiero inmutable
No hay borrado físico de ventas, pagos, facturas, movimientos de inventario, asientos contables
ni audit logs. Las correcciones se hacen con **operaciones inversas** (cancelación, nota de
crédito, ajuste), no con `DELETE` ni `UPDATE` silencioso.

### 5.6 Errores
`AllExceptionsFilter` global. Los errores de dominio son `DomainException` con código estable
(`INSUFFICIENT_STOCK`, `CREDIT_LIMIT_EXCEEDED`, …) y mensaje apto para el usuario final.
Cualquier otra excepción se registra con stack trace y `correlationId`, y al usuario se le
devuelve un mensaje genérico. Telegram nunca muestra `PrismaClientKnownRequestError`.

### 5.7 Logging
Pino (`nestjs-pino`) con salida JSON estructurada. Cada request/update recibe un `correlationId`
propagado por `AsyncLocalStorage`. Redacción automática de `token`, `authorization`, `password`,
`secret`, `apiKey`. Niveles: `info` para operaciones de negocio, `warn` para reglas violadas,
`error` para fallos inesperados.

### 5.8 Configuración
`@nestjs/config` con validación de esquema al arrancar: si falta `DATABASE_URL` o
`TELEGRAM_BOT_TOKEN` la app no arranca. Configuración *de negocio* (prefijo de factura, impuestos,
días de crédito por defecto) vive en la tabla `settings`, no en env, para poder cambiarla desde
Telegram.

### 5.9 Sesiones del bot
Estado conversacional (carrito en construcción, wizard de venta) en Redis con TTL cuando
`REDIS_URL` está presente; fallback en memoria para desarrollo. El estado de sesión **nunca**
es fuente de verdad de negocio: sólo acumula la intención hasta que se confirma y se persiste.

### 5.10 Permisos
`RolesGuard` + `PermissionsGuard` sobre metadatos `@RequirePermissions('sales.create')`.
El mismo chequeo se aplica en el lado Telegram mediante un `PermissionChecker` compartido, para
que un botón no ejecute algo que el usuario no puede hacer.

## 6. Flujo de una venta (resumen)

```
Telegram wizard → CreateSaleDto → SalesService.create()
  └─ $transaction(Serializable)
       1. resolver usuario y permisos
       2. lock de variantes (FOR UPDATE, orden por id)
       3. validar stock y precios; snapshot de precio y costo
       4. crear Sale + SaleItems
       5. crear InventoryMovement (SALE) por item, actualizar currentStock
       6. crear Invoice con número consecutivo (secuencia con lock)
       7. crear Payment si hay monto pagado
       8. crear CreditAccount si hay saldo pendiente
       9. crear CashMovement si el pago fue en efectivo y hay caja abierta
      10. crear AccountingEntry (ingreso + costo de ventas)
      11. crear AuditLog
  └─ commit  → si algo falla, ROLLBACK total
```

## 7. Facturación

Numeración consecutiva por serie mediante tabla `invoice_sequences` con lock de fila
(`FOR UPDATE`) dentro de la misma transacción de la venta. Formato configurable, por defecto
`MP-{YYYY}-{000000}`.

La estructura queda preparada para NCF/e-CF de República Dominicana: la factura lleva
`fiscalType`, `fiscalNumber`, `fiscalSequenceId` y `customerTaxId` nulos por ahora, y existe la
tabla `fiscal_sequences` (rangos NCF con vigencia). **No se implementa integración con DGII.**

## 8. Almacenamiento de archivos

Los PDFs no se guardan en PostgreSQL. `StorageService` es una interfaz con implementación
`LocalFilesystemStorage` (por defecto) y contrato compatible con S3/MinIO. La factura guarda
`storageKey`, `mimeType`, `sizeBytes` y `checksum`, no el binario.

## 9. Integraciones futuras

La API REST versionada (`/api/v1`) es el único punto de entrada para terceros. Se prevé
autenticación por API key con scopes para integraciones máquina-a-máquina, y JWT para el
dashboard web. Nada de esto se implementa en la Fase 1, pero los módulos de dominio no asumen
que la única entrada es Telegram.

## 10. Despliegue

Docker multi-stage → imagen de producción sin dev-dependencies. `docker-compose.yml` para
desarrollo (app + postgres + redis) y para Dokploy, que provee Traefik como reverse proxy y
TLS. En producción el bot usa **webhook** (`POST /telegram/webhook`, validado con
`X-Telegram-Bot-Api-Secret-Token`); en desarrollo, **polling**. Ver `deployment.md`.
