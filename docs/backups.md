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

El repositorio incluye [`scripts/backup.sh`](../scripts/backup.sh), listo para instalar en el
servidor. Localiza el contenedor de PostgreSQL, hace el volcado **dentro** del contenedor (no
necesita exponer el puerto ni instalar clientes en el host), **verifica que el dump se pueda
leer** antes de darlo por bueno, y sólo entonces rota los antiguos.

### Instalación en el VPS

Conéctate por SSH y ejecuta, en orden:

```bash
sudo curl -fsSL https://raw.githubusercontent.com/gucci7up/motabots/main/scripts/backup.sh -o /usr/local/bin/motaparfum-backup.sh
```

```bash
sudo chmod +x /usr/local/bin/motaparfum-backup.sh
```

Comprueba que encuentra el contenedor y que el volcado funciona **antes** de programarlo:

```bash
sudo /usr/local/bin/motaparfum-backup.sh
```

Debe terminar con `Backup completado`. Si dice que no encuentra el contenedor, ajusta el
patrón:

```bash
docker ps --format '{{.Names}}' | grep -i postgres
```

y vuelve a ejecutarlo con el nombre correcto:

```bash
sudo PG_CONTAINER=<nombre-que-salio> /usr/local/bin/motaparfum-backup.sh
```

### Programarlo

```bash
echo '0 3 * * * root PG_CONTAINER=motaparfum /usr/local/bin/motaparfum-backup.sh >> /var/log/motaparfum-backup.log 2>&1' | sudo tee /etc/cron.d/motaparfum-backup
```

Corre todos los días a las 3:00 AM y deja el registro en `/var/log/motaparfum-backup.log`.

### Retención

El script conserva los últimos **14** backups diarios (`KEEP_DAILY`). Sólo borra dumps más
antiguos que ese umbral y **nunca el más reciente**. Aun así, revisa el log la primera semana:
un script de limpieza mal configurado borra el histórico completo y no hay forma de
recuperarlo.

### Copia fuera del servidor

Un backup que vive en el mismo disco que la base no protege contra la pérdida del disco. Ese
es el escenario que más duele y el que este script **no** cubre por sí solo. Copia
`/var/backups/motaparfum` a otro sitio: `rclone` a un bucket, `scp` a otra máquina, o la
función de backups de Dokploy hacia S3.

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
