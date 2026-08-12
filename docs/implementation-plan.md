# Plan de implementación — MotaParfum Admin

## Estado actual

| Fase | Contenido | Estado |
|------|-----------|--------|
| 0 | Análisis, arquitectura, modelo de datos | ✅ Hecho |
| 1 | Infraestructura: NestJS, Prisma, PostgreSQL, config, logging, Swagger, Docker | ✅ Hecho |
| 2 | Usuarios, roles, permisos, autenticación Telegram | ✅ Hecho |
| 3 | Categorías, productos, variantes | ⬜ |
| 4 | Inventario y movimientos | ⬜ |
| 5 | Clientes | ⬜ |
| 6 | Ventas | ⬜ |
| 7 | Pagos y créditos | ⬜ |
| 8 | Facturación + PDF | ⬜ |
| 9 | Caja | ⬜ |
| 10 | Gastos y contabilidad | ⬜ |
| 11 | Reportes | ⬜ |
| 12 | UX completa del bot | ⬜ |
| 13 | Auditoría | ⬜ |
| 14 | Testing exhaustivo | ⬜ |
| 15 | Docker / Dokploy / producción | ⬜ |

Nota: auditoría y tests no se dejan «para el final». Cada fase escribe sus propios audit logs y
sus propios tests; las fases 13 y 14 son de consolidación y cobertura, no de estreno.

## Definition of Done (por fase)

Una fase está terminada cuando:

1. `npm run build` compila sin errores de TypeScript (strict).
2. `npm run lint` pasa.
3. `npm test` pasa (unitarios + integración de la fase).
4. `npx prisma migrate deploy` aplica limpio sobre una base vacía.
5. La app arranca y `/health` responde `ok`.
6. No hay secretos en el repositorio.
7. La documentación de `docs/` está actualizada.

---

## Detalle de fases

### FASE 1 — Infraestructura
- `package.json`, `tsconfig.json` (strict), ESLint, Prettier, Jest.
- NestJS bootstrap con `ValidationPipe` global (whitelist + forbidNonWhitelisted), filtro de
  excepciones, interceptor de correlación.
- Config tipada con validación de entorno al arrancar.
- Logging estructurado (Pino) con redacción de secretos.
- `PrismaModule` + `PrismaService` con hooks de ciclo de vida y helper de transacción.
- Schema Prisma completo (todas las entidades) + primera migración.
- Seed: roles, permisos, categorías, categorías de gasto, settings, admin inicial.
- Swagger en `/docs`.
- `/health` con verificación real de conexión a PostgreSQL.
- `Dockerfile` multi-stage, `docker-compose.yml`, `.env.example`.
- Tests: config, money, health, prisma.

### FASE 2 — Usuarios y permisos
Resolución de identidad Telegram → `User`, allowlist por `TELEGRAM_ADMIN_IDS`, `RolesGuard`,
`PermissionsGuard`, CRUD de usuarios con `users.manage`, audit log de login.

### FASE 3 — Catálogo
Categorías, productos, variantes; validación de SKU/barcode únicos; precios y costos como
Decimal. Sin lógica de stock todavía (la variante nace con stock 0).

### FASE 4 — Inventario
`InventoryService.registerMovement()` transaccional con lock `FOR UPDATE`, tipos de movimiento,
stock mínimo, comando de reconciliación `currentStock` ↔ movimientos.

### FASE 5 — Clientes
CRUD, búsqueda por nombre/teléfono/identificación, historial agregado, límite de crédito.

### FASE 6 — Ventas
`SalesService.create()` con la transacción completa descrita en `architecture.md §6`,
snapshots de precio y costo, idempotencia, y `cancel()` con reversión total.

### FASE 7 — Pagos y créditos
Pagos inmutables con reversión, cuentas de crédito, abonos parciales, recálculo de estado,
job de marcado `OVERDUE`.

### FASE 8 — Facturación
Secuencia consecutiva con lock, generación de PDF, `StorageService` (filesystem con contrato
S3/MinIO), envío del PDF por Telegram, anulación de factura.

### FASE 9 — Caja
Apertura/cierre, movimientos, `expectedCash` vs `actualCash`, diferencia, inmutabilidad del
cierre.

### FASE 10 — Gastos y contabilidad
Gastos con impacto en caja, asientos contables, cálculo de utilidad bruta y neta desde
snapshots.

### FASE 11 — Reportes
Ventas por período, productos, clientes, inventario, créditos, caja. Consultas agregadas
indexadas, sin traer filas al proceso.

### FASE 12 — UX del bot
Menú principal, wizard de venta, navegación con Atrás/Menú, paginación, búsquedas, alertas
programadas (stock bajo, créditos vencidos, resumen diario).

### FASE 13 — Auditoría
Consolidación: verificar cobertura de todas las operaciones críticas, consulta de audit logs
desde Telegram (sólo lectura).

### FASE 14 — Testing
Los 14 escenarios obligatorios del requerimiento + pruebas de concurrencia reales (dos ventas
compitiendo por el último producto) con base de datos de prueba.

### FASE 15 — Producción
Webhook de Telegram con secret token, healthchecks, Dokploy, Traefik, backups, runbook.

---

## Problemas y riesgos identificados

Detectados durante el análisis, con la decisión tomada:

1. **Docker no está instalado en la máquina de desarrollo.** Se desarrolla contra el
   PostgreSQL 17 nativo de Windows. El `docker-compose.yml` se escribe igual para producción y
   Dokploy, pero no se puede validar localmente hasta que Docker esté instalado. Queda como
   deuda explícita de la Fase 15.

2. **Saldo del cliente: campo vs cálculo.** Un campo `balance` en `customers` se desincroniza
   ante cualquier fallo. Se calcula desde `credit_accounts`. Si el volumen lo exige, vista
   materializada — nunca un campo mutable a mano.

3. **`currentStock` es una proyección.** Guardarlo es necesario para rendimiento y para el lock
   `FOR UPDATE`, pero introduce el riesgo de divergir de los movimientos. Mitigación: se escribe
   sólo dentro de la misma transacción que crea el movimiento, más un comando de reconciliación.

4. **Costo de inventario: no hay método de valuación definido.** Al vender se guarda
   `unitCostSnapshot` desde `costPrice` de la variante. Si mañana se quiere costo promedio
   ponderado o FIFO, los movimientos de compra ya guardan `unitCost`, así que el dato existe.
   **Decisión abierta que afecta la utilidad reportada** — se implementa costo estándar
   (`costPrice` vigente) y se documenta; migrar a promedio ponderado es un cambio de servicio,
   no de esquema.

5. **Zona horaria.** «Ventas de hoy» depende de la zona horaria. Todo se almacena en UTC y los
   reportes se calculan sobre `America/Santo_Domingo` (UTC-4, sin horario de verano),
   configurable vía `TZ`. Sin esto los cierres de caja nocturnos caen en el día equivocado.

6. **Impuestos (ITBIS).** Se modela `taxAmount` a nivel de venta y la configuración
   `tax.enabled`/`tax.rate`, pero por defecto está **desactivado**. Cuando se active habrá que
   decidir si los precios son con impuesto incluido o sin él — decisión de negocio pendiente.

7. **Reentrega de updates de Telegram.** Sin control de `update_id` una venta puede duplicarse.
   Resuelto con la tabla `telegram_updates` + clave de idempotencia en la venta.

8. **Una sola caja abierta.** Se fuerza con índice único parcial. Si en el futuro hay varios
   vendedores con cajas simultáneas, habrá que añadir `terminalId` al índice.

9. **Cancelación de una venta a crédito ya abonada.** No se puede simplemente anular: hay
   dinero cobrado. La cancelación crea pagos de reversión y deja el crédito en `CANCELLED` con
   registro de auditoría; si el cliente ya pagó, el reembolso queda como salida de caja
   explícita. **Se pedirá confirmación al usuario en el flujo, no se decide en silencio.**

10. **`Decimal` de Prisma y JSON.** `Prisma.Decimal` no serializa a JSON de forma nativa. Se
    añade un interceptor de serialización que lo emite como string, para no perder precisión al
    exponer la API al futuro dashboard.
