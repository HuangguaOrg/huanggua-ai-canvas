"""Create the pinned dependency archive for Huanggua's own release channel.

Run after package-studio-runtime.py and release:preflight. Does not publish.
"""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--tag', required=True)
    args = parser.parse_args()
    import re
    if not re.fullmatch(r'runtime-[A-Za-z0-9._-]+', args.tag):
        raise ValueError('Expected an immutable runtime-* dependency tag')
    resources = ROOT / 'src-tauri/resources'
    manifest_path = resources / 'huanggua-studio/manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    paths = [resources / 'huanggua-studio' / name for name in manifest['files']]
    paths += [manifest_path, resources / 'director-desk.tar.gz']
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
        for path in paths:
            archive.write(path, path.relative_to(resources).as_posix())
    with args.output.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    lock = {'schemaVersion': 1, 'platform': 'windows-x86_64',
            'url': f'https://github.com/HuangguaOrg/AI-Canvas-tauri/releases/download/{args.tag}/{args.output.name}',
            'sha256': digest}
    (ROOT / 'runtime/studio/distribution.json').write_text(json.dumps(lock, indent=2) + '\n', encoding='utf-8')
    print('Dependency archive and pinned distribution manifest prepared; upload has not been performed.')


if __name__ == '__main__':
    main()
