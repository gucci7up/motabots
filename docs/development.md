# Entorno de desarrollo

## Requisitos

- Node.js 20+ (probado con 24.18)
- PostgreSQL 17 (nativo en Windows o vía Docker)
- Docker Desktop (opcional en desarrollo; necesario para validar el stack de producción)

## 1. Instalación

```bash
npm install
```

## 2. Base de datos

### Opción A — PostgreSQL nativo en Windows (setup actual)

Crea la base y el usuario de la aplicación. Ejecuta esto en **PowerShell**, sustituyendo
`UNA_CLAVE_FUERTE` por la que elijas; `psql` te pedirá la contraseña del superusuario
`postgres`:

```bash
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres -h 127.0.0.1 -c "CREATE ROLE motaparfum LOGIN PASSWORD 'UNA_CLAVE_FUERTE';"
```

```bash
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres -h 127.0.0.1 -c "CREATE DATABASE motaparfum_admin OWNER motaparfum ENCODING 'UTF8';"
```

### Opción B — PostgreSQL en Docker

```bash
docker compose up -d postgres
```

### Opción C — PostgreSQL remoto en Dokploy (setup actual)

Crea en Dokploy un servicio PostgreSQL 17 **dedicado a este proyecto** (base propia, usuario
propio; nunca la base de n8n) y habilita su puerto externo. Después:

```bash
powershell -ExecutionPolicy Bypass -File .\scripts\setup-db-remote.ps1
```

El script pide host, puerto, usuario, base y contraseña, prueba la conexión y escribe
`DATABASE_URL` en `.env`.

Exponer el puerto de PostgreSQL a Internet tiene coste de seguridad: usa una contraseña larga,
limita el acceso por firewall a tu IP si puedes, y cierra el puerto externo cuando dejes de
necesitarlo desde tu máquina. En producción la aplicación corre en el mismo servidor y se
conecta por la red interna de Docker, sin puerto expuesto.

## 3. Variables de entorno

```bash
cp .env.example .env
```

Completa como mínimo:

```
DATABASE_URL=postgresql://motaparfum:UNA_CLAVE_FUERTE@127.0.0.1:5432/motaparfum_admin?schema=public
DIRECT_URL=postgresql://motaparfum:UNA_CLAVE_FUERTE@127.0.0.1:5432/motaparfum_admin?schema=public
TELEGRAM_ADMIN_IDS=<tu ID numérico de Telegram>
LOG_PRETTY=true
```

`TELEGRAM_BOT_TOKEN` y `JWT_SECRET` son opcionales en desarrollo y obligatorios en producción.
Tu ID numérico de Telegram lo da cualquier bot tipo `@userinfobot`.

`.env` está en `.gitignore`. Nunca se commitea.

## 4. Migraciones y seed

```bash
npx prisma migrate dev
```

```bash
npm run prisma:seed
```

El seed es idempotente: crea roles, permisos, categorías de producto y de gasto, la secuencia
de facturas, la configuración de la tienda y los administradores de `TELEGRAM_ADMIN_IDS`.
No crea productos ni clientes ficticios.

## 5. Ejecutar

```bash
npm run start:dev
```

Comprobaciones:

```bash
curl http://localhost:3000/health/ready
```

Swagger queda en <http://localhost:3000/docs>.

### Parámetros de conexión con base remota

Contra una base remota (VPS/Dokploy) el `DATABASE_URL` necesita:

```
?schema=public&connect_timeout=30&connection_limit=5&pool_timeout=30
```

Por defecto Prisma abre `núcleos × 2 + 1` conexiones (13 en esta máquina) con 10 s de
`pool_timeout`. Con la latencia de un servidor remoto eso falla al arrancar con `P2024:
Timed out fetching a new connection from the connection pool`. En producción, con la
aplicación y la base en el mismo servidor, los valores por defecto están bien.

### SQL fuera del schema de Prisma

La migración inicial añade, después del SQL generado por Prisma, restricciones que el schema
no puede expresar: un índice único parcial (una sola caja abierta a la vez) y varios `CHECK`
de invariantes financieras (`total = subtotal − descuento + impuesto`, `pagado + pendiente =
total`, `balance = original − pagado`, cantidades positivas).

Prisma no modela `CHECK` ni índices parciales, así que no los toca al generar nuevas
migraciones. Aun así, **revisa el SQL de cada migración nueva** antes de aplicarla y verifica
que no incluya un `DROP CONSTRAINT` o `DROP INDEX` sobre ellos.

## Pruebas

```bash
npm test
```

Las pruebas de integración necesitan una base real. Usa una base separada para no tocar tus
datos:

```bash
npm run test:e2e
```

Recomendado: `DATABASE_URL` apuntando a `motaparfum_admin_test` al ejecutar e2e.

## Calidad

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npm run format
```

TypeScript está en `strict` y ESLint usa reglas con información de tipos. Ambos deben pasar
antes de dar una fase por terminada.

## Convenciones

- Los servicios de dominio no conocen Telegram. Si necesitas formatear un mensaje con emojis,
  eso va en `src/telegram/`.
- Todo importe se construye con los helpers de `src/common/money.ts`.
- Las operaciones multi-tabla usan `PrismaService.transaction()`, que ya reintenta ante
  conflictos de serialización.
- Los errores esperados se lanzan como `DomainException` con un código de `DomainErrorCode`.
