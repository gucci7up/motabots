# Restablece la contraseña del superusuario `postgres` en el PostgreSQL local.
#
# QUÉ HACE, en orden:
#   1. Copia de seguridad de pg_hba.conf
#   2. Cambia la autenticación local a `trust` TEMPORALMENTE
#   3. Reinicia el servicio
#   4. ALTER USER postgres con la contraseña que escribas
#   5. RESTAURA pg_hba.conf desde la copia y reinicia de nuevo
#
# El paso 5 está en un bloque `finally`: se ejecuta aunque el script falle o lo interrumpas.
# Dejar `trust` activo permitiría a cualquier proceso local entrar como superusuario sin
# contraseña, así que la reversión no es opcional.
#
# REQUIERE PowerShell como Administrador.
#
# Uso:  .\scripts\reset-postgres-password.ps1

param(
  [string]$DataDir = 'C:\Program Files\PostgreSQL\17\data',
  [string]$PsqlPath = 'C:\Program Files\PostgreSQL\17\bin\psql.exe',
  [string]$ServiceName = 'postgresql-x64-17'
)

$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  throw 'Este script necesita PowerShell ejecutado como Administrador.'
}

$hba = Join-Path $DataDir 'pg_hba.conf'
if (-not (Test-Path $hba)) { throw "No encontre pg_hba.conf en '$hba'." }
if (-not (Test-Path $PsqlPath)) { throw "No encontre psql en '$PsqlPath'." }

$backup = Join-Path $DataDir ('pg_hba.conf.motaparfum-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))

Write-Host 'Contrasena NUEVA para el superusuario postgres:'
$secure = Read-Host -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))

if ([string]::IsNullOrWhiteSpace($plain)) { throw 'La contrasena no puede estar vacia.' }
if ($plain.Length -lt 8) { throw 'Usa al menos 8 caracteres.' }

$restored = $false

try {
  Copy-Item $hba $backup -Force
  Write-Host "Copia de seguridad: $backup"

  # Sólo se tocan las líneas de conexión local/loopback.
  $original = Get-Content $hba
  $patched = $original | ForEach-Object {
    if ($_ -match '^\s*(local|host)\s') { $_ -replace 'scram-sha-256|md5', 'trust' } else { $_ }
  }
  Set-Content -Path $hba -Value $patched -Encoding ascii
  Write-Host 'Autenticacion local en modo trust (temporal).'

  Restart-Service $ServiceName -Force
  Start-Sleep -Seconds 3
  Write-Host 'Servicio reiniciado.'

  $escaped = $plain.Replace("'", "''")
  $output = & $PsqlPath -w -U postgres -h 127.0.0.1 -d postgres -v ON_ERROR_STOP=1 `
    -c "ALTER USER postgres WITH PASSWORD '$escaped';"
  if ($LASTEXITCODE -ne 0) { throw "No se pudo cambiar la contrasena: $output" }

  Write-Host 'Contrasena de postgres actualizada.'
}
finally {
  if (Test-Path $backup) {
    Copy-Item $backup $hba -Force
    Restart-Service $ServiceName -Force
    Start-Sleep -Seconds 3
    $restored = $true
    Write-Host 'pg_hba.conf restaurado (scram-sha-256) y servicio reiniciado.'
  }
}

if ($restored) {
  # Comprobación: sin contraseña ya NO debe entrar. Si entrara, trust seguiria activo.
  & $PsqlPath -w -U postgres -h 127.0.0.1 -c 'SELECT 1;' 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Write-Warning 'ATENCION: todavia se puede entrar sin contrasena. Revisa pg_hba.conf manualmente.'
  }
  else {
    Write-Host 'Verificado: el acceso sin contrasena esta cerrado.'
  }
}

Write-Host ''
Write-Host 'Siguiente paso:'
Write-Host '  .\scripts\setup-db.ps1'
