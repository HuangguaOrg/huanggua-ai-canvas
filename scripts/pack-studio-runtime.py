"""Pack the verified offline studio runtime into one deterministic installer resource.

The staged directory ``src-tauri/resources/huanggua-studio`` stays the audited
source of truth (its manifest is verified by ``release:preflight``). The NSIS
installer only carries ``huanggua-studio.zip`` plus a small sidecar, so Windows
writes two large files instead of tens of thousands of small ones. The desktop
app extracts and verifies the archive on first use.

Output is byte-for-byte reproducible for the same runtime, so unchanged runtimes
keep the same digest and can be reused by incremental updates. Entries are
stored uncompressed: the NSIS installer already LZMA-compresses its payload
(much smaller than per-file Deflate), and first-run extraction is a plain copy.
"""
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
RESOURCES = ROOT / 'src-tauri/resources'
STAGED = RESOURCES / 'huanggua-studio'
ARCHIVE = RESOURCES / 'huanggua-studio.zip'
SIDECAR = RESOURCES / 'huanggua-studio.json'
FIXED_TIME = (1980, 1, 1, 0, 0, 0)
FORMAT = 'zip-stored-v1'
MAX_FILES = 150_000


def digest(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def load_manifest():
    manifest_path = STAGED / 'manifest.json'
    if not manifest_path.is_file():
        raise ValueError('Stage the studio runtime first (manifest.json missing)')
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    files = manifest.get('files')
    if manifest.get('schemaVersion') != 1 or manifest.get('platform') not in {'windows-x86_64', 'darwin-aarch64', 'darwin-x86_64'} or not isinstance(files, dict):
        raise ValueError('Invalid studio runtime manifest')
    if not files or len(files) > MAX_FILES:
        raise ValueError('Studio runtime manifest file count is out of range')
    return manifest_path, files


def current_sidecar(manifest_sha: str):
    if not (ARCHIVE.is_file() and SIDECAR.is_file()):
        return None
    try:
        sidecar = json.loads(SIDECAR.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    if sidecar.get('format') != FORMAT or sidecar.get('manifestSha256') != manifest_sha or sidecar.get('size') != ARCHIVE.stat().st_size:
        return None
    return sidecar if digest(ARCHIVE) == sidecar.get('sha256') else None


def main():
    manifest_path, files = load_manifest()
    manifest_sha = digest(manifest_path)
    existing = current_sidecar(manifest_sha)
    if existing:
        print(f"Studio runtime archive is current: {existing['files']} files, {existing['size']:,} bytes.")
        return
    temporary = ARCHIVE.with_name(ARCHIVE.name + '.tmp')
    temporary.unlink(missing_ok=True)
    expanded = 0
    names = sorted(files)
    with zipfile.ZipFile(temporary, 'x', compression=zipfile.ZIP_STORED) as archive:
        for name in ['manifest.json', *names]:
            source = STAGED / name
            if source.is_symlink() or not source.is_file():
                raise ValueError(f'Runtime file missing or not a regular file: {name}')
            data = source.read_bytes()
            if name != 'manifest.json' and hashlib.sha256(data).hexdigest() != files[name]:
                raise ValueError(f'Runtime file does not match manifest: {name}')
            info = zipfile.ZipInfo(name, date_time=FIXED_TIME)
            info.compress_type = zipfile.ZIP_STORED
            info.create_system = 0
            info.external_attr = 0
            archive.writestr(info, data, compress_type=zipfile.ZIP_STORED)
            expanded += len(data)
    temporary.replace(ARCHIVE)
    sidecar = {
        'schemaVersion': 1,
        'archive': ARCHIVE.name,
        'format': FORMAT,
        'sha256': digest(ARCHIVE),
        'size': ARCHIVE.stat().st_size,
        'manifestSha256': manifest_sha,
        'files': len(names),
        'expandedBytes': expanded,
    }
    SIDECAR.write_text(json.dumps(sidecar, indent=2) + '\n', encoding='utf-8')
    print(f"Packed studio runtime: {len(names)} files, {expanded:,} bytes -> {sidecar['size']:,} bytes.")


if __name__ == '__main__':
    main()
