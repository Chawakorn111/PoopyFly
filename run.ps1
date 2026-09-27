# Fly Brain Typewriter - one-shot dev bootstrap.
#   .\run.ps1            # build graphs if needed + start the app
#   .\run.ps1 -Build     # force rebuild all runtime graphs
#   .\run.ps1 -Bench     # rebuild the full benchmark ladder (debug..full)
param(
  [switch]$Build,
  [switch]$Bench,
  [string]$Py = "C:\Users\User\AppData\Local\Programs\Python\Python311\python.exe"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$data = Join-Path $root "webapp\public\data\debug\manifest.json"

if ($Bench -or $Build -or -not (Test-Path $data)) {
  $modes = if ($Bench) { "bench" } else { "debug,core" }
  Write-Host ">> python pipeline/preprocess.py --modes $modes" -ForegroundColor Cyan
  & $Py (Join-Path $root "pipeline\preprocess.py") --modes $modes
}

Write-Host ">> validate_runtime (core)" -ForegroundColor Cyan
& $Py (Join-Path $root "pipeline\validate_runtime.py") --mode core --quick

Push-Location (Join-Path $root "webapp")
try {
  if (-not (Test-Path "node_modules")) { npm install }
  Write-Host ">> npm run dev (http://localhost:5173)" -ForegroundColor Green
  npm run dev
} finally { Pop-Location }
