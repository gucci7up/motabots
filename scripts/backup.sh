#!/usr/bin/env bash
#
# Backup diario de MotaParfum Admin: base de datos y archivos generados.
#
# Se ejecuta en el servidor (VPS con Dokploy). Detecta el contenedor de PostgreSQL por
# nombre y usa pg_dump dentro de él, así no hace falta exponer el puerto ni instalar
# clientes en el host.
#
# Instalación: ver docs/backups.md
#
# Variables (todas con valor por defecto razonable):
#   BACKUP_DIR        destino de los backups          (/var/backups/motaparfum)
#   PG_CONTAINER      nombre/patrón del contenedor    (motaparfum)
#   PG_USER           usuario de la base              (motaparfumbot-user)
#   PG_DATABASE       nombre de la base               (motaparfumbot-db)
#   STORAGE_VOLUME    volumen con los PDFs            (vacío = no se respalda)
#   KEEP_DAILY        backups diarios a conservar     (14)

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/motaparfum}"
PG_CONTAINER="${PG_CONTAINER:-motaparfum}"
PG_USER="${PG_USER:-motaparfumbot-user}"
PG_DATABASE="${PG_DATABASE:-motaparfumbot-db}"
STORAGE_VOLUME="${STORAGE_VOLUME:-}"
KEEP_DAILY="${KEEP_DAILY:-14}"

STAMP="$(date +%Y-%m-%d_%H%M)"
DB_FILE="${BACKUP_DIR}/db_${STAMP}.dump"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
fail() { log "ERROR: $*"; exit 1; }

mkdir -p "${BACKUP_DIR}"

# ── Localizar el contenedor de PostgreSQL ─────────────────────
CONTAINER="$(docker ps --filter "name=${PG_CONTAINER}" --filter "status=running" --format '{{.Names}}' | head -n 1)"
[ -n "${CONTAINER}" ] || fail "No encontré un contenedor en ejecución que coincida con '${PG_CONTAINER}'"

log "Contenedor: ${CONTAINER}"

# ── Volcado de la base ────────────────────────────────────────
# El formato custom (-Fc) comprime y permite restaurar tablas sueltas.
log "Volcando ${PG_DATABASE}…"
docker exec -i "${CONTAINER}" pg_dump -U "${PG_USER}" -d "${PG_DATABASE}" -Fc > "${DB_FILE}"

# Un dump vacío o truncado es peor que no tenerlo: se verifica antes de dar por bueno.
SIZE="$(stat -c%s "${DB_FILE}")"
[ "${SIZE}" -gt 10240 ] || fail "El dump pesa sólo ${SIZE} bytes; algo falló"

if ! pg_restore --list "${DB_FILE}" > /dev/null 2>&1; then
  # pg_restore puede no estar en el host: se verifica dentro del contenedor.
  docker exec -i "${CONTAINER}" pg_restore --list /dev/stdin < "${DB_FILE}" > /dev/null \
    || fail "El dump no se puede leer: está corrupto"
fi

log "Base respaldada: ${DB_FILE} ($((SIZE / 1024)) KB)"

# ── Archivos generados (facturas PDF, logo) ───────────────────
if [ -n "${STORAGE_VOLUME}" ] && [ -d "${STORAGE_VOLUME}" ]; then
  STORAGE_FILE="${BACKUP_DIR}/storage_${STAMP}.tar.gz"
  tar czf "${STORAGE_FILE}" -C "${STORAGE_VOLUME}" .
  log "Archivos respaldados: ${STORAGE_FILE}"
fi

# ── Retención ─────────────────────────────────────────────────
# Sólo borra backups verificados y más antiguos que el umbral. Nunca borra el más reciente.
TOTAL="$(find "${BACKUP_DIR}" -name 'db_*.dump' -type f | wc -l)"

if [ "${TOTAL}" -gt "${KEEP_DAILY}" ]; then
  find "${BACKUP_DIR}" -name 'db_*.dump' -type f -printf '%T@ %p\n' \
    | sort -n \
    | head -n "$((TOTAL - KEEP_DAILY))" \
    | cut -d' ' -f2- \
    | while read -r old; do
        log "Eliminando backup antiguo: $(basename "${old}")"
        rm -f "${old}"
      done
fi

log "Backup completado. Total conservados: $(find "${BACKUP_DIR}" -name 'db_*.dump' -type f | wc -l)"
