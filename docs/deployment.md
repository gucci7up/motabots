# Despliegue — Dokploy + Traefik

Este documento no asume nada sobre la configuración concreta de tu servidor: describe lo que
la aplicación necesita.

## 1. Componentes

| Componente | Notas |
|-----------|-------|
| `app` | Imagen construida desde el `Dockerfile` del repositorio. Expone el puerto 3000. |
| `postgres` | PostgreSQL 17 con volumen persistente. Base propia, separada de la de n8n. |
| `redis` | Opcional. Sesiones del bot, cache y rate limiting. |
| Traefik | Lo aporta Dokploy: reverse proxy y certificados TLS. |

## 2. Variables de entorno en Dokploy

Se configuran en la interfaz de Dokploy, nunca en el repositorio.

Obligatorias:

```
NODE_ENV=production
DATABASE_URL=postgresql://usuario:clave@postgres:5432/motaparfum_admin?schema=public
DIRECT_URL=postgresql://usuario:clave@postgres:5432/motaparfum_admin?schema=public
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ADMIN_IDS=...
TELEGRAM_MODE=webhook
TELEGRAM_WEBHOOK_SECRET=...
APP_URL=https://admin.motaparfum.com
JWT_SECRET=<mínimo 32 caracteres>
TZ=America/Santo_Domingo
```

Recomendadas: `REDIS_URL`, `STORAGE_DRIVER`, `LOG_LEVEL`, `STORE_NAME`, `STORE_PHONE`,
`STORE_ADDRESS`, `CURRENCY=DOP`, `CURRENCY_SYMBOL=RD$`.

Genera los secretos con:

```bash
openssl rand -hex 32
```

Si falta una variable obligatoria, la aplicación **no arranca** y explica cuál falta. Es
intencional: es preferible fallar en el despliegue que a mitad de una venta.

## 3. PostgreSQL

- Crea la base como servicio de Dokploy con volumen persistente.
- Usa un usuario dedicado, no `postgres`.
- No compartas la base con n8n: bases y credenciales separadas.
- Zona horaria del contenedor en `America/Santo_Domingo`.

## 4. Dominio y Traefik

En Dokploy, apunta el dominio (p. ej. `admin.motaparfum.com`) al servicio `app`, puerto `3000`,
con HTTPS y redirección desde HTTP. Traefik gestiona el certificado.

El healthcheck del contenedor consulta `GET /health`. Para readiness usa `GET /health/ready`,
que verifica la conexión con PostgreSQL y responde 503 si está caída.

## 5. Migraciones

Las migraciones **no** se aplican solas al arrancar: aplicarlas automáticamente en cada réplica
es una forma conocida de corromper una base. Ejecuta explícitamente en el despliegue:

```bash
npx prisma migrate deploy
```

Y el seed la primera vez (es idempotente, puede repetirse):

```bash
npm run prisma:seed
```

Antes de aplicar una migración en producción, toma un backup (ver `backups.md`).

## 6. Webhook de Telegram

En producción se usa webhook; polling queda para desarrollo.

Registro del webhook (sustituye los valores):

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" -d "url=https://admin.motaparfum.com/api/v1/telegram/webhook" -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

Verificación:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

La aplicación rechaza cualquier petición al webhook cuya cabecera
`X-Telegram-Bot-Api-Secret-Token` no coincida con `TELEGRAM_WEBHOOK_SECRET`. Además, cada
`update_id` se registra en `telegram_updates`: si Telegram reentrega un update (cosa que hace
ante timeouts), se descarta en lugar de duplicar una venta.

Con `TELEGRAM_MODE=webhook`, la aplicación registra el webhook sola al arrancar usando
`APP_URL`. El `curl` de arriba sólo hace falta para diagnosticar o para forzar el registro.

**Un solo consumidor.** Telegram entrega los updates a un único destino. Si dejas una instancia
en polling con el mismo token (por ejemplo, tu máquina), el bot responderá de forma errática.
Usa un bot distinto para desarrollo.

### Réplicas y tareas programadas

Las alertas (stock bajo, créditos vencidos, resumen diario) corren dentro de la aplicación con
un scheduler en proceso. **Con más de una réplica, cada una enviaría su propia copia.** Mientras
el despliegue tenga una sola instancia no hay problema; si algún día se escala, hay que mover
las alertas a un job externo o añadir un bloqueo compartido.

Las expresiones horarias usan la zona del contenedor: con `TZ=America/Santo_Domingo`, las 9:00
son las 9:00 de aquí.

## 7. Almacenamiento de archivos

Los PDFs de factura y el logo se guardan en el volumen montado en `/app/storage`
(`STORAGE_DRIVER=local`). Ese volumen debe incluirse en la estrategia de respaldo. Para migrar
a S3/MinIO basta cambiar `STORAGE_DRIVER` y las credenciales correspondientes: el contrato del
`StorageService` es el mismo.

## 8. Actualizaciones

1. Backup de la base de datos.
2. Build de la nueva imagen.
3. `npx prisma migrate deploy`.
4. Reinicio del servicio.
5. Verificar `GET /health/ready`.
6. Verificar `getWebhookInfo` si cambió el dominio.

## 9. Rollback

Las migraciones de Prisma no se revierten solas. El rollback seguro es: restaurar el backup
previo y desplegar la imagen anterior. Por eso el paso 1 no es opcional.

## 10. Paso de polling a webhook

El sistema arranca en `polling`, que funciona sin dominio y es lo correcto mientras se
desarrolla. Para pasar a producción:

1. Verifica que el dominio responde: `curl https://TU-DOMINIO/health` debe devolver `ok`.
2. En las variables de entorno de Dokploy:
   ```
   TELEGRAM_MODE=webhook
   APP_URL=https://TU-DOMINIO
   TELEGRAM_WEBHOOK_SECRET=<openssl rand -hex 32>
   ```
3. Redespliega. En el log de arranque debe aparecer
   `Webhook de Telegram registrado en https://TU-DOMINIO/api/v1/telegram/webhook`.
4. Comprueba: `curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"` — `url` debe coincidir
   y `last_error_message` estar vacío.

Si falta `APP_URL` o el secreto, la aplicación **no arranca**: es preferible fallar en el
despliegue que quedarse con un bot mudo sin saberlo.

Para volver a polling: `TELEGRAM_MODE=polling` y borrar el webhook en Telegram
(`curl "https://api.telegram.org/bot<TOKEN>/deleteWebhook"`). Si no lo borras, Telegram seguirá
intentando entregar por HTTP y el polling no recibirá nada.

## 11. Operación diaria

Ver [`runbook.md`](runbook.md): comprobaciones, síntomas frecuentes, tareas recurrentes y lo
que nunca se debe hacer.
