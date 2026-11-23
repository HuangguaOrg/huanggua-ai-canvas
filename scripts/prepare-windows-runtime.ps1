$ErrorActionPreference = 'Stop'
# Node/Tauri may inherit PowerShell 7's module path when invoking Windows
# PowerShell 5. Use this process's built-in modules for signature verification.
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
$projectRoot = Split-Path $PSScriptRoot -Parent
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Visual Studio Installer is required to locate the licensed x64 CRT redistributables.' }
$candidates = @(& $vswhere -latest -products * -find 'VC\Redist\MSVC\**\x64\Microsoft.VC*.CRT\msvcp140.dll')
$selected = $candidates | Where-Object { $_ -match '\\MSVC\\([0-9.]+)\\x64\\Microsoft\.VC[0-9]+\.CRT\\msvcp140\.dll$' } |
    ForEach-Object { [PSCustomObject]@{ Path = $_; Version = [version]$Matches[1] } } |
    Sort-Object Version -Descending | Select-Object -First 1
if (-not $selected) { throw 'Install the x64 MSVC CRT redistributable component in Visual Studio Build Tools.' }
$source = Split-Path $selected.Path -Parent
$destination = Join-Path $projectRoot 'src-tauri/resources/windows-runtime'
$files = @('msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll')
# The app import table and the CRT dependency closure require these four files.
# Copy from the toolchain redistributable directory, never from System32.
foreach ($name in $files) {
    $file = Join-Path $source $name
    if (-not (Test-Path -LiteralPath $file)) { throw "Missing CRT dependency: $name" }
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') {
        throw "CRT signature validation failed: $name"
    }
}
New-Item -ItemType Directory -Path $destination -Force | Out-Null
foreach ($name in $files) { Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $destination $name) -Force }
Write-Output "Prepared four Microsoft-signed x64 CRT runtime files ($($selected.Version))."
