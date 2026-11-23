param([Parameter(Mandatory)][string]$Installation, [Parameter(Mandatory)][string]$Inventory)
$ErrorActionPreference = 'Stop'
# Both inputs originate in the signed installer. Ignore the machine's module path.
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
try {
    $root = [IO.Path]::GetFullPath($Installation).TrimEnd('\')
    if ($root -notmatch '^[A-Za-z]:\\') { throw 'Invalid installation root' }
    $dirs = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $sha = [Security.Cryptography.SHA256]::Create()
    foreach ($line in [IO.File]::ReadLines($Inventory)) {
        $parts = $line.Split([char]9)
        if ($parts.Length -ne 2 -or $parts[0] -notmatch '^[0-9a-f]{64}$') { throw 'Invalid inventory' }
        $file = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $parts[1]))
        if (-not $file.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid path' }
        $dir = [IO.Path]::GetDirectoryName($file)
        while ($dir -and $dirs.Add($dir)) {
            if ([IO.File]::GetAttributes('\\?\' + $dir) -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected directory link' }
            $dir = [IO.Path]::GetDirectoryName($dir)
        }
        $longPath = '\\?\' + $file
        if ([IO.File]::GetAttributes($longPath) -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected file link' }
        $stream = [IO.File]::OpenRead($longPath)
        try { $actual = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') } finally { $stream.Dispose() }
        if ($actual -ne $parts[0]) { throw 'Baseline mismatch' }
    }
    exit 0
} catch { exit 2 }
