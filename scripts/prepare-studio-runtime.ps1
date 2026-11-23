param([Parameter(Mandatory=$true)][string]$SourceBundle, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
# Development engine snapshot: only application code and public model metadata.
# Never copy .env, account state, databases, projects or the previous launcher.
$source = (Resolve-Path -LiteralPath $SourceBundle).Path
$destinationPath = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $destinationPath) { throw 'Destination must be a new engine snapshot directory.' }
$python = Join-Path $source 'runtime/python/cpython-3.14.6-windows-x86_64-none/python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw 'Bundled Python dependency is missing.' }
New-Item -ItemType Directory -Path $destinationPath | Out-Null
foreach ($entry in @('lib','server','alembic','packages','agent_runtime_profile','skills','scripts','public','LICENSES')) {
    & robocopy (Join-Path $source "app/$entry") (Join-Path $destinationPath $entry) /E /XD __pycache__ .venv node_modules .git dist /XF '*.pyc' '.env' /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw 'Engine source copy failed.' }
}
foreach ($entry in @('alembic.ini','pyproject.toml','skills-lock.json','LICENSE','NOTICE')) {
    Copy-Item -LiteralPath (Join-Path $source "app/$entry") -Destination $destinationPath
}
Copy-Item -LiteralPath (Join-Path $source 'huanggua-models.json') -Destination $destinationPath
$settings = @{ engine=$destinationPath; python=$python; gitBash=(Join-Path $source 'runtime/git/usr/bin/bash.exe') }
$settings | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $destinationPath 'development-runtime.json') -Encoding utf8
Write-Output 'Prepared isolated ArcReel engine source; no account data or legacy launcher copied.'
