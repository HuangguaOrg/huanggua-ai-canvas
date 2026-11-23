"""Stage an offline desktop studio runtime from an audited local bundle, never user data.

Usage:
  Windows: python scripts/package-studio-runtime.py --engine ENGINE --python PYTHON_DIR --git GIT_DIR
  macOS:   python scripts/package-studio-runtime.py --engine ENGINE --python PYTHON_DIR --platform darwin-aarch64 --dereference-links
  Prune:   python scripts/package-studio-runtime.py --prune-existing
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]
SUPPORTED_PLATFORMS = {'windows-x86_64', 'darwin-aarch64', 'darwin-x86_64'}
ENGINE_DIRS = ('lib', 'server', 'alembic', 'packages', 'agent_runtime_profile', 'skills', 'scripts', 'public', 'LICENSES')
ENGINE_FILES = ('alembic.ini', 'pyproject.toml', 'skills-lock.json', 'LICENSE', 'NOTICE', 'huanggua-models.json')
SKIP = {'.git', '__pycache__', '.venv', 'node_modules', 'tests', '.pytest_cache', '.ruff_cache', 'terminfo', 'man'}
# volcengine-python-sdk installs ~137 service packages (~25k files). The engine
# only imports the Ark runtime; these are its complete import closure.
VOLCENGINE_KEEP = {'volcenginesdkcore', 'volcenginesdkark', 'volcenginesdkarkruntime'}
PRUNED_PYTHON_DIRS = {'tcl', 'include'}


def default_platform() -> str:
    if os.name == 'nt':
        return 'windows-x86_64'
    if sys.platform == 'darwin':
        import platform
        return 'darwin-aarch64' if platform.machine() == 'arm64' else 'darwin-x86_64'
    return 'windows-x86_64'


def pruned(relative: str) -> bool:
    """Runtime paths that are never imported by the studio engine or its tools."""
    parts = relative.split('/')
    if len(parts) == 2 and parts[0] == 'python':
        return parts[1] in PRUNED_PYTHON_DIRS
    if len(parts) == 3 and parts[:2] == ['python', 'lib'] and (parts[2].startswith('tcl') or parts[2].startswith('tk')):
        return True
    if len(parts) == 4 and parts[:3] == ['python', 'Lib', 'site-packages']:
        package = parts[3]
        return package.startswith('volcenginesdk') and package.split('.')[0] not in VOLCENGINE_KEEP
    if len(parts) == 5 and parts[:2] == ['python', 'lib'] and parts[2].startswith('python3') and parts[3] == 'site-packages':
        package = parts[4]
        return package.startswith('volcenginesdk') and package.split('.')[0] not in VOLCENGINE_KEEP
    return False


def _iter_site_packages_dirs(target: Path) -> list[Path]:
    dirs = []
    win_sp = target / 'python/Lib/site-packages'
    if win_sp.is_dir():
        dirs.append(win_sp)
    posix_lib = target / 'python/lib'
    if posix_lib.is_dir():
        for child in sorted(posix_lib.iterdir()):
            if child.is_dir() and child.name.startswith('python3'):
                sp = child / 'site-packages'
                if sp.is_dir():
                    dirs.append(sp)
    return dirs


def prune(target: Path) -> int:
    removed = 0
    candidates = [target / 'python' / name for name in sorted(PRUNED_PYTHON_DIRS)]
    posix_lib = target / 'python/lib'
    if posix_lib.is_dir():
        for child in sorted(posix_lib.iterdir()):
            if child.name.startswith(('tcl', 'tk')):
                candidates.append(child)
    for sp in _iter_site_packages_dirs(target):
        candidates += sorted(sp.iterdir())
    for entry in candidates:
        if entry.exists() and pruned(entry.relative_to(target).as_posix()):
            if entry.is_dir():
                removed += sum(1 for item in entry.rglob('*') if item.is_file())
                shutil.rmtree(entry)
            else:
                removed += 1
                entry.unlink()
    return removed


def valid_manifest_entry_name(name: str) -> bool:
    return (
        bool(name)
        and len(name) <= 400
        and not name.startswith('/')
        and not any(c in name for c in ('\\', ':'))
        and not any(ord(c) < 32 for c in name)
        and all(part and part not in {'.', '..'} and not part.endswith(('.', ' ')) for part in name.split('/'))
    )


def write_manifest(target: Path, platform_id: str | None = None) -> int:
    existing_manifest = target / 'manifest.json'
    if platform_id is None and existing_manifest.is_file():
        try:
            platform_id = json.loads(existing_manifest.read_text(encoding='utf-8')).get('platform')
        except Exception:
            platform_id = None
    resolved_platform = platform_id or default_platform()
    if resolved_platform not in SUPPORTED_PLATFORMS:
        raise ValueError(f'Unsupported runtime platform: {resolved_platform}')
    files = {}
    seen_lower: dict[str, Path] = {}
    for path in sorted(target.rglob('*')):
        if path.is_file() and path != existing_manifest:
            rel = path.relative_to(target).as_posix()
            if not valid_manifest_entry_name(rel):
                path.unlink()
                continue
            low = rel.lower()
            if low in seen_lower:
                # Case-insensitive filesystem safety (Windows NTFS & macOS APFS)
                path.unlink()
                continue
            seen_lower[low] = path
            with path.open('rb') as stream:
                files[rel] = hashlib.file_digest(stream, 'sha256').hexdigest()
    manifest = {'schemaVersion': 1, 'platform': resolved_platform, 'files': files}
    existing_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return len(files)


def copy_tree(source: Path, target: Path, *, dereference_links: bool = False):
    if source.is_symlink() or (hasattr(source, 'is_junction') and source.is_junction()):
        if not dereference_links:
            raise ValueError('Runtime sources must not contain links')
        resolved = source.resolve()
        if not resolved.exists() or resolved.is_dir():
            return
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(resolved, target)
        return
    if source.is_dir():
        target.mkdir(parents=True, exist_ok=True)
        for child in sorted(source.iterdir()):
            if child.name in SKIP or child.suffix in {'.pyc', '.pyo', '.log', '.db', '.sqlite', '.sqlite3', '.key'} or child.name.startswith('.env') or child.name.endswith(('.', ' ')):
                continue
            copy_tree(child, target / child.name, dereference_links=dereference_links)
    elif source.is_file():
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('engine', 'python', 'git'):
        parser.add_argument('--' + name, type=Path)
    parser.add_argument('--output', type=Path, default=ROOT / 'src-tauri/resources/huanggua-studio')
    parser.add_argument('--platform', default=default_platform(), choices=sorted(SUPPORTED_PLATFORMS))
    parser.add_argument('--dereference-links', action='store_true', help='Materialize file symlinks as regular files (macOS portable Python)')
    parser.add_argument('--prune-existing', action='store_true', help='Re-apply pruning to an already staged runtime')
    args = parser.parse_args()
    target = args.output.resolve()
    if args.prune_existing:
        if not (target / 'manifest.json').is_file():
            raise ValueError('No staged runtime to prune')
        removed = prune(target)
        count = write_manifest(target)
        print(f'Pruned {removed} unused runtime files; {count} files remain.')
        return
    is_windows = args.platform.startswith('windows-')
    if not (args.engine and args.python) or (is_windows and not args.git):
        parser.error('--engine, --python (and --git on Windows) are required')
    if target.exists():
        raise ValueError('Output must be a new directory; preserve existing packages explicitly')
    py_rel = 'python.exe' if is_windows else 'bin/python3'
    checks = [(args.engine, 'server/app.py'), (args.python, py_rel)]
    if is_windows and args.git:
        checks.append((args.git, 'usr/bin/bash.exe'))
    for folder, required in checks:
        if not (folder / required).is_file():
            raise ValueError(f'A required runtime dependency is missing: {folder / required}')
        if folder.resolve() == target or folder.resolve() in target.parents:
            raise ValueError('Output must be outside the source runtime')
    for entry in ENGINE_DIRS + ENGINE_FILES:
        if (args.engine / entry).exists():
            copy_tree(args.engine / entry, target / 'engine' / entry, dereference_links=args.dereference_links)
    copy_tree(args.python, target / 'python', dereference_links=args.dereference_links)
    if args.git:
        copy_tree(args.git, target / 'git', dereference_links=args.dereference_links)
    prune(target)
    count = write_manifest(target, args.platform)
    print(f'Prepared isolated Huanggua runtime ({args.platform}): {count} files. No account or project data included.')


if __name__ == '__main__':
    main()
