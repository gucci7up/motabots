# Runbook de operación

Qué hacer cuando algo va mal, y las tareas recurrentes de mantenimiento.

## Comprobaciones rápidas

```bash
curl https://TU-DOMINIO/health/ready
```

- `{"status":"ok"}` → la aplicación responde y PostgreSQL está accesible.
- `{"status":"degraded"}` con HTTP 503 → la aplicación vive pero la base no responde.
- Sin respuesta → el contenedor está caído; revisa los logs en Dokploy.

Estado del webhook de Telegram:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

Interesa `pending_update_count` (si crece, el bot no está procesando) y `last_error_message`.

---

## Síntomas y causas

### El bot no responde a `/start`

1. **¿La aplicación está viva?** `curl /health`. Si no, revisa logs y reinicia en Dokploy.
2. **¿Modo webhook sin URL correcta?** `getWebhookInfo` debe apuntar a
   `https://TU-DOMINIO/api/v1/telegram/webhook`. Si cambió el dominio, hay que volver a
   registrarlo.
3. **¿El usuario existe?** Sólo responden los usuarios registrados y activos. Un usuario
   desconocido recibe el mensaje de acceso denegado y queda en `audit_logs` con la acción
   `login.denied`.
4. **¿Token equivocado?** Si `TELEGRAM_BOT_TOKEN` no corresponde al bot, el log de arranque
   muestra el error de Telegram.

### El bot responde dos veces / mensajes duplicados

Hay dos instancias corriendo (por ejemplo, polling en local y webhook en producción con el
mismo token). Telegram sólo permite un consumidor: apaga una. **Nunca uses el mismo token
para desarrollo y producción.**

### «No pudimos completar la operación»

Es el mensaje genérico de un error no controlado. En los logs busca el `correlationId` de esa
franja horaria: ahí está el stack trace real. Los errores de negocio (stock insuficiente,
crédito excedido) llevan su propio mensaje y no salen así.

### Una venta falló y no sé si se registró

No se registró. La venta es una única transacción: o se crea todo (venta, líneas, inventario,
factura, pagos, crédito, asientos y auditoría) o no se crea nada. Verifícalo:

```sql
SELECT "saleNumber", total, "saleStatus" FROM sales ORDER BY "createdAt" DESC LIMIT 5;
```

### El stock no cuadra con lo que hay en la tienda

Primero descarta un problema del sistema:

```bash
npm run reconcile:inventory
```

Si reporta `✅ cuadra`, el sistema es coherente consigo mismo y la diferencia es física
(mercancía no registrada, merma, robo). Regístrala como ajuste, no la «arregles» a mano en
la base.

Si reporta divergencias, corrígelas y **avisa**: significa que algo escribió `currentStock`
fuera de una transacción, y eso es un bug que hay que investigar.

```bash
npm run reconcile:inventory -- --fix
```

### La caja no cuadra al cerrar

Es normal que haya diferencias pequeñas. El sistema registra el faltante o sobrante y no lo
oculta. **No borres movimientos para cuadrarla**: falsea el histórico y el descuadre vuelve a
aparecer al día siguiente, ya sin rastro de dónde salió.

Para ver el detalle de la sesión:

```sql
SELECT type, direction, amount, description, "createdAt"
FROM cash_movements WHERE "cashSessionId" = '<ID>' ORDER BY "createdAt";
```

---

## Tareas recurrentes

| Frecuencia | Tarea |
|-----------|-------|
| Diaria (automática) | Backup de PostgreSQL — ver `backups.md` |
| Diaria (automática) | Alertas de stock bajo y créditos vencidos, 9:00 AM |
| Diaria (automática) | Resumen del día, 9:00 PM |
| Semanal | `npm run reconcile:inventory` |
| Mensual | Restaurar un backup en un entorno de prueba y comparar totales |
| Trimestral | Revisar usuarios activos y sus roles |

## Antes de cada despliegue

1. Backup de la base (`backups.md`).
2. `npx prisma migrate deploy`.
3. Verificar `/health/ready`.
4. Enviar `/start` al bot.

Si el despliegue incluye migraciones y algo sale mal, el rollback es **restaurar el backup y
desplegar la imagen anterior**. Las migraciones de Prisma no se revierten solas.

---

## Consultas útiles

Cuentas por cobrar:

```sql
SELECT c.name, SUM(ca.balance) AS saldo
FROM credit_accounts ca JOIN customers c ON c.id = ca."customerId"
WHERE ca.status IN ('PENDING','PARTIAL','OVERDUE')
GROUP BY c.name ORDER BY saldo DESC;
```

Ventas del día:

```sql
SELECT "saleNumber", total, "paidAmount", "pendingAmount", "paymentStatus"
FROM sales WHERE "createdAt" >= CURRENT_DATE AND "saleStatus" = 'COMPLETED'
ORDER BY "createdAt";
```

Auditoría de una venta concreta:

```sql
SELECT action, "createdAt", metadata FROM audit_logs
WHERE entity = 'Sale' AND "entityId" = '<ID>' ORDER BY "createdAt";
```

---

## Lo que nunca se debe hacer

- **Borrar filas de** `sales`, `payments`, `invoices`, `inventory_movements`,
  `credit_accounts`, `accounting_entries` o `audit_logs`. Todo se corrige con operaciones
  inversas: cancelar la venta, registrar un pago de reversión, hacer un ajuste de inventario.
- **Editar importes directamente en la base.** Los `CHECK` de PostgreSQL rechazarán lo que no
  cuadre, pero lo que sí cuadre quedará sin rastro en la auditoría.
- **Dejar `inventory.allowNegativeStock` activado** de forma permanente. Es un escape puntual,
  no una configuración de trabajo.
- **Reutilizar el token del bot** entre desarrollo y producción.
