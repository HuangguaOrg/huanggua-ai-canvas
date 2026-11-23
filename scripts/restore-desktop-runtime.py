"""Restore only pinned dependencies from Huanggua's own GitHub release assets."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def restore():
    lock = json.loads((ROOT / 'runtime/studio/distribution.json').read_text(encoding='utf-8'))
    if lock.get('schemaVersion') != 1 or lock.get('platform') != 'windows-x86_64' or os.name != 'nt':
        raise ValueError('This audited dependency distribution supports Windows x64 only')
    if not re.fullmatch(r'https://github\.com/HuangguaOrg/(?:AI-Canvas-tauri|huanggua-ai-canvas)/releases/download/runtime-[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\.zip', lock['url']) or not re.fullmatch(r'[a-f0-9]{64}', lock['sha256']):
        raise ValueError('Untrusted dependency source or digest')
    resources = ROOT / 'src-tauri/resources'
    if (resources / 'huanggua-studio').exists() or (resources / 'director-desk.tar.gz').exists():
        raise ValueError('Dependencies already exist; verify them rather than overwriting')
    with tempfile.TemporaryDirectory(prefix='huanggua-runtime-') as temporary:
        archive_path = Path(temporary) / 'runtime.zip'
        with urllib.request.urlopen(lock['url'], timeout=60) as response, archive_path.open('xb') as target:
            total = 0
            while block := response.read(1024 * 1024):
                total += len(block)
                if total > 2 * 1024**3:
                    raise ValueError('Dependency archive too large')
                target.write(block)
        with archive_path.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != lock['sha256']:
                raise ValueError('Dependency archive digest mismatch')
        staging = Path(temporary) / 'unpacked'
        with zipfile.ZipFile(archive_path) as archive:
            entries = archive.infolist()
            if len(entries) > 150000 or sum(item.file_size for item in entries) > 4 * 1024**3:
                raise ValueError('Dependency archive exceeds extraction limits')
            names = set()
            for item in entries:
                name = item.filename
                if (name.casefold() in names or name.startswith('/') or '\\' in name or ':' in name
                    or any(part in ('.', '..') or part.endswith(('.', ' ')) for part in name.rstrip('/').split('/'))
                    or not (name.startswith('huanggua-studio/') or name == 'director-desk.tar.gz')
                    or stat.S_ISLNK(item.external_attr >> 16)):
                    raise ValueError('Unsafe dependency archive entry')
                names.add(name.casefold())
            archive.extractall(staging)
        resources.mkdir(parents=True, exist_ok=True)
        for name in ('huanggua-studio', 'director-desk.tar.gz'):
            shutil.move(str(staging / name), str(resources / name))
    print('Pinned Huanggua offline dependencies restored. Run release:preflight before building.')


if __name__ == '__main__':
    restore()
