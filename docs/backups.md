# Backups y restauración

La base de datos contiene ventas, créditos y facturas: es el activo más valioso del sistema.
Un backup que nunca se ha restaurado no es un backup.

## Qué respaldar

1. La base PostgreSQL `motaparfum_admin`.
2. El volumen de almacenamiento (`/app/storage`): PDFs de factura y logo.
3. Las variables de entorno (fuera del repositorio, en un gestor de secretos).

## Backup manual

```bash
pg_dump -U motaparfum -h 127.0.0.1 -d motaparfum_admin -F c -f motaparfum_admin_$(date +%F_%H%M).dump
```

Con la base en Docker:

```bash
docker compose exec -T postgres pg_dump -U motaparfum -d motaparfum_admin -F c > backup.dump
```

El formato `-F c` (custom) permite restaurar tablas sueltas y comprime.

## Backup diario automático

Recomendación: diario a las 3:00 AM, reteniendo 7 diarios, 4 semanales y 6 mensuales.

Ejemplo de entrada de cron en el servidor:

```bash
0 3 * * * /usr/local/bin/motaparfum-backup.sh >> /var/log/motaparfum-backup.log 2>&1
```

Script de referencia:

```bash
#!/usr/bin/env bash
set -euo pipefail
DEST=/var/backups/motaparfum
STAMP=$(date +%F_%H%M)
mkdir -p "$DEST"
docker compose -f /etc/dokploy/motaparfum/docker-compose.yml exec -T postgres \
  pg_dump -U motaparfum -d motaparfum_admin -F c > "$DEST/db_$STAMP.dump"
tar czf "$DEST/storage_$STAMP.tar.gz" -C /var/lib/docker/volumes/motaparfum_storage_data/_data .
```

**Retención:** revísala manualmente antes de automatizar cualquier borrado. Este proyecto no
incluye eliminación automática de backups: un script de limpieza mal escrito borra el histórico
completo y no hay forma de recuperarlo.

Guarda una copia **fuera del servidor** (otro proveedor u otra región). Un backup que vive en
el mismo disco que la base no protege contra la pérdida del disco.

## Restauración

1. Detén la aplicación (no la base):

```bash
docker compose stop app
```

2. Restaura sobre una base **vacía**:

```bash
createdb -U postgres motaparfum_admin_restore
```

```bash
pg_restore -U postgres -d motaparfum_admin_restore --no-owner --clean --if-exists backup.dump
```

3. Verifica antes de promover la base restaurada:

```sql
SELECT count(*) FROM sales;
SELECT count(*) FROM payments;
SELECT sum(balance) FROM credit_accounts WHERE status IN ('PENDING','PARTIAL','OVERDUE');
```

4. Cambia `DATABASE_URL` a la base restaurada y arranca la aplicación.

Restaurar directamente encima de la base en producción es destructivo: hazlo siempre sobre una
base nueva y promueve después de verificar.

## Prueba de restauración

Restaura en un entorno de prueba al menos una vez al mes y compara los totales del punto 3 con
el reporte del día correspondiente. Es la única forma de saber que los backups sirven.

## Antes de cada migración

```bash
pg_dump -U motaparfum -d motaparfum_admin -F c -f pre_migracion_$(date +%F_%H%M).dump
```

Las migraciones de Prisma no tienen rollback automático: el backup previo *es* el plan de
rollback.
