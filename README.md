# MotaParfum Admin

Sistema administrativo (mini ERP/POS) para MotaParfum. La interfaz principal es un bot de
Telegram; el núcleo es una API NestJS + PostgreSQL preparada para alimentar más adelante un
dashboard web.

> **Independiente de n8n.** Este proyecto no lee la base de datos de n8n, no llama a sus
> webhooks y no depende de sus workflows. Funciona con n8n completamente apagado.

## Stack

| Capa | Tecnología |
|------|-----------|
| Backend | NestJS 11, TypeScript (strict), Node 22 |
| Base de datos | PostgreSQL 17 + Prisma 6 |
| Bot | Telegram Bot API |
| Cache/sesiones | Redis (opcional) |
| Infraestructura | Docker, Docker Compose, Dokploy, Traefik |
| Documentación | Swagger/OpenAPI en `/docs` |
| Testing | Jest + Supertest |

## Estado

| Fase | Contenido | Estado |
|------|-----------|--------|
| 1–14 | Infraestructura, usuarios y permisos, catálogo, inventario, clientes, ventas, créditos, facturación PDF, caja, gastos, contabilidad, reportes, bot completo, auditoría y pruebas de concurrencia | ✅ |
| 15 | Producción: webhook, backups, runbook | ✅ |

El plan detallado está en [`docs/implementation-plan.md`](docs/implementation-plan.md).

## Arranque rápido (desarrollo)

```bash
npm install
cp .env.example .env      # completa DATABASE_URL y TELEGRAM_BOT_TOKEN
npx prisma migrate dev
npm run prisma:seed
npm run start:dev
```

- API: <http://localhost:3000/api/v1>
- Swagger: <http://localhost:3000/docs>
- Health: <http://localhost:3000/health> y `/health/ready`

Detalles en [`docs/development.md`](docs/development.md).

## Con Docker

```bash
docker compose up -d
```

Requiere un `.env` con al menos `POSTGRES_PASSWORD`, `TELEGRAM_BOT_TOKEN` y `JWT_SECRET`.

## Scripts

| Comando | Descripción |
|---------|-------------|
| `npm run start:dev` | Arranca en modo watch |
| `npm run build` | Compila a `dist/` |
| `npm run typecheck` | TypeScript sin emitir |
| `npm run lint` | ESLint |
| `npm test` | Pruebas unitarias |
| `npm run test:e2e` | Pruebas de integración (requiere PostgreSQL) |
| `npm run prisma:migrate` | Crea y aplica una migración |
| `npm run prisma:deploy` | Aplica migraciones (producción) |
| `npm run prisma:seed` | Siembra roles, permisos, categorías y configuración |
| `npm run import:inventory` | Importa catálogo e inventario inicial desde un CSV |
| `npm run reconcile:inventory` | Verifica que el stock cuadre con los movimientos |
| `npm run store:info` | Configura logo, teléfono, dirección y redes de la tienda |
| `npm run render:invoice` | Renderiza una factura a PDF para revisar el diseño |

## Documentación

- [`docs/architecture.md`](docs/architecture.md) — arquitectura y decisiones técnicas
- [`docs/database.md`](docs/database.md) — modelo de datos
- [`docs/implementation-plan.md`](docs/implementation-plan.md) — plan por fases y riesgos
- [`docs/development.md`](docs/development.md) — entorno local
- [`docs/deployment.md`](docs/deployment.md) — Dokploy, Traefik, webhook de Telegram
- [`docs/backups.md`](docs/backups.md) — respaldo y restauración
- [`docs/telegram.md`](docs/telegram.md) — diseño del bot
- [`docs/accounting.md`](docs/accounting.md) — contabilidad administrativa
- [`docs/runbook.md`](docs/runbook.md) — operación diaria y resolución de problemas

## Reglas del proyecto

1. Dinero en `Decimal`, nunca en punto flotante.
2. Toda operación que toque dinero o inventario va dentro de una transacción.
3. Sin borrado físico de ventas, pagos, facturas ni auditoría: se corrigen con operaciones inversas.
4. Las ventas guardan snapshots de precio y costo.
5. La lógica de negocio vive en los servicios, nunca en los handlers de Telegram.
6. Ningún secreto en el repositorio.
