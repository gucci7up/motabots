# Configura MotaParfum Admin contra un PostgreSQL remoto (Dokploy / VPS).
#
# Pide los datos de conexión de forma interactiva, prueba la conexión y escribe
# DATABASE_URL y DIRECT_URL en .env. La contraseña no queda en el historial de la consola
# ni se muestra en pantalla.
#
# Uso:  .\scripts\setup-db-remote.ps1

param(
  [string]$PsqlPath = 'C:\Program Files\PostgreSQL\17\bin\psql.exe'
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot '.env'
$envExample = Join-Path $projectRoot '.env.example'

$dbHost = Read-Host 'Host del servidor (IP o dominio del VPS)'
if ([string]::IsNullOrWhiteSpace($dbHost)) { throw 'El host es obligatorio.' }

$portInput = Read-Host 'Puerto externo asignado por Dokploy [5432]'
$port = if ([string]::IsNullOrWhiteSpace($portInput)) { 5432 } else { [int]$portInput }

$userInput = Read-Host 'Usuario de la base [motaparfum]'
$dbUser = if ([string]::IsNullOrWhiteSpace($userInput)) { 'motaparfum' } else { $userInput }

$dbInput = Read-Host 'Nombre de la base [motaparfum_admin]'
$database = if ([string]::IsNullOrWhiteSpace($dbInput)) { 'motaparfum_admin' } else { $dbInput }

Write-Host 'Contrasena de la base (no se mostrara):'
$secure = Read-Host -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
if ([string]::IsNullOrWhiteSpace($plain)) { throw 'La contrasena es obligatoria.' }

# La contraseña va codificada en la URL: caracteres como @ : / ? # la romperian.
$encoded = [System.Uri]::EscapeDataString($plain)
$url = "postgresql://${dbUser}:${encoded}@${dbHost}:${port}/${database}?schema=public"

Write-Host ''
Write-Host "Probando conexion a ${dbHost}:${port}/${database} como ${dbUser}..."

if (Test-Path $PsqlPath) {
  $env:PGPASSWORD = $plain
  try {
    $output = & $PsqlPath -w -U $dbUser -h $dbHost -p $port -d $database -v ON_ERROR_STOP=1 `
      -c 'SELECT version();'
    if ($LASTEXITCODE -ne 0) { throw "No se pudo conectar: $output" }
    Write-Host 'Conexion correcta.'
  }
  finally {
    Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
  }
}
else {
  Write-Warning "psql no esta en '$PsqlPath'; se omite la prueba de conexion."
  Write-Warning 'Si los datos son incorrectos, fallara al aplicar las migraciones.'
}

if (-not (Test-Path $envFile)) {
  Copy-Item $envExample $envFile
  Write-Host '.env creado a partir de .env.example'
}

$content = Get-Content $envFile
$content = $content -replace '^DATABASE_URL=.*$', "DATABASE_URL=$url"
$content = $content -replace '^DIRECT_URL=.*$', "DIRECT_URL=$url"
$content = $content -replace '^LOG_PRETTY=.*$', 'LOG_PRETTY=true'
Set-Content -Path $envFile -Value $content -Encoding utf8

Write-Host ''
Write-Host 'DATABASE_URL y DIRECT_URL escritos en .env (ignorado por git).'
Write-Host 'Siguiente paso:'
Write-Host '  npx prisma migrate deploy'
Write-Host '  npm run prisma:seed'
