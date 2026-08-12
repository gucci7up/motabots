# Prepara la base de datos de desarrollo de MotaParfum Admin.
#
# Crea el rol y la base en el PostgreSQL local, y escribe el DATABASE_URL en .env.
# Las contraseñas se piden de forma interactiva y no quedan en el historial de la consola.
#
# Uso:  .\scripts\setup-db.ps1

param(
  [string]$PsqlPath = 'C:\Program Files\PostgreSQL\17\bin\psql.exe',
  [string]$DbHost = '127.0.0.1',
  [int]$Port = 5432,
  [string]$SuperUser = 'postgres',
  [string]$AppUser = 'motaparfum',
  [string]$Database = 'motaparfum_admin'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $PsqlPath)) {
  throw "No encontré psql en '$PsqlPath'. Pasa la ruta con -PsqlPath."
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot '.env'
$envExample = Join-Path $projectRoot '.env.example'

Write-Host 'Contrasena del superusuario de PostgreSQL (' -NoNewline
Write-Host $SuperUser -NoNewline
Write-Host '):'
$superSecure = Read-Host -AsSecureString
$superPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($superSecure))

Write-Host "Contrasena NUEVA para el usuario de la aplicacion ($AppUser):"
$appSecure = Read-Host -AsSecureString
$appPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($appSecure))

if ([string]::IsNullOrWhiteSpace($appPlain)) {
  throw 'La contrasena de la aplicacion no puede estar vacia.'
}

function Invoke-Psql {
  param([string]$Sql, [string]$Db = 'postgres')

  $env:PGPASSWORD = $superPlain
  try {
    $output = & $PsqlPath -w -U $SuperUser -h $DbHost -p $Port -d $Db -v ON_ERROR_STOP=1 -c $Sql
    if ($LASTEXITCODE -ne 0) { throw "psql fallo: $output" }
    return $output
  }
  finally {
    Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
  }
}

Write-Host ''
Write-Host 'Verificando conexion...'
Invoke-Psql -Sql 'SELECT 1;' | Out-Null
Write-Host 'Conexion correcta.'

# El rol se crea sólo si no existe; si existe, se actualiza la contraseña.
$escapedPassword = $appPlain.Replace("'", "''")
$roleSql = @"
DO `$`$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$AppUser') THEN
    CREATE ROLE "$AppUser" LOGIN PASSWORD '$escapedPassword';
  ELSE
    ALTER ROLE "$AppUser" WITH LOGIN PASSWORD '$escapedPassword';
  END IF;
END
`$`$;
"@
Invoke-Psql -Sql $roleSql | Out-Null
Write-Host "Rol '$AppUser' listo."

$exists = Invoke-Psql -Sql "SELECT 1 FROM pg_database WHERE datname = '$Database';"
if ($exists -join ' ' -match '\(0 (rows|filas)\)') {
  Invoke-Psql -Sql "CREATE DATABASE `"$Database`" OWNER `"$AppUser`" ENCODING 'UTF8';" | Out-Null
  Write-Host "Base '$Database' creada."
}
else {
  Write-Host "Base '$Database' ya existia; no se toco."
}

Invoke-Psql -Sql "GRANT ALL PRIVILEGES ON DATABASE `"$Database`" TO `"$AppUser`";" | Out-Null
Invoke-Psql -Sql "GRANT ALL ON SCHEMA public TO `"$AppUser`";" -Db $Database | Out-Null

# .env
$encodedPassword = [System.Uri]::EscapeDataString($appPlain)
$url = "postgresql://${AppUser}:${encodedPassword}@${DbHost}:${Port}/${Database}?schema=public"

if (-not (Test-Path $envFile)) {
  Copy-Item $envExample $envFile
  Write-Host '.env creado a partir de .env.example'
}

$content = Get-Content $envFile
$content = $content -replace '^DATABASE_URL=.*$', "DATABASE_URL=$url"
$content = $content -replace '^DIRECT_URL=.*$', "DIRECT_URL=$url"
$content = $content -replace '^LOG_PRETTY=.*$', 'LOG_PRETTY=true'
if (-not ($content -match '^LOG_PRETTY=')) { $content += 'LOG_PRETTY=true' }
Set-Content -Path $envFile -Value $content -Encoding utf8

Write-Host ''
Write-Host 'Listo. DATABASE_URL escrito en .env'
Write-Host 'Siguiente paso:'
Write-Host '  npx prisma migrate deploy'
Write-Host '  npm run prisma:seed'
