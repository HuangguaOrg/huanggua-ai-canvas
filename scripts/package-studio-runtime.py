"""Stage an offline Windows runtime from an audited local bundle, never user data.

Usage: python scripts/package-studio-runtime.py --engine ENGINE --python PYTHON_DIR --git GIT_DIR
       python scripts/package-studio-runtime.py --prune-existing   (re-apply pruning to the staged runtime)
The output is generated/ignored. No downloads, installers or legacy launcher run.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
ENGINE_DIRS = ('lib', 'server', 'alembic', 'packages', 'agent_runtime_profile', 'skills', 'scripts', 'public', 'LICENSES')
ENGINE_FILES = ('alembic.ini', 'pyproject.toml', 'skills-lock.json', 'LICENSE', 'NOTICE', 'huanggua-models.json')
SKIP = {'.git', '__pycache__', '.venv', 'node_modules', 'tests', '.pytest_cache', '.ruff_cache'}
# volcengine-python-sdk installs ~137 service packages (~25k files). The engine
# only imports the Ark runtime; these are its complete import closure.
VOLCENGINE_KEEP = {'volcenginesdkcore', 'volcenginesdkark', 'volcenginesdkarkruntime'}
# Tk GUI data and C headers: the headless studio service never opens Tk windows
# or compiles extensions (PIL.ImageTk / tqdm.tk are optional GUI helpers).
PRUNED_PYTHON_DIRS = {'tcl', 'include'}


def pruned(relative: str) -> bool:
    """Runtime paths that are never imported by the studio engine or its tools."""
    parts = relative.split('/')
    if len(parts) == 2 and parts[0] == 'python':
        return parts[1] in PRUNED_PYTHON_DIRS
    if len(parts) == 4 and parts[:3] == ['python', 'Lib', 'site-packages']:
        package = parts[3]
        return package.startswith('volcenginesdk') and package.split('.')[0] not in VOLCENGINE_KEEP
    return False


def prune(target: Path) -> int:
    removed = 0
    candidates = [target / 'python' / name for name in sorted(PRUNED_PYTHON_DIRS)]
    packages = target / 'python/Lib/site-packages'
    candidates += sorted(packages.iterdir()) if packages.is_dir() else []
    for entry in candidates:
        if entry.exists() and pruned(entry.relative_to(target).as_posix()):
            if entry.is_dir():
                removed += sum(1 for item in entry.rglob('*') if item.is_file())
                shutil.rmtree(entry)
            else:
                removed += 1
                entry.unlink()
    return removed


def write_manifest(target: Path) -> int:
    files = {}
    for path in sorted(target.rglob('*')):
        if path.is_file() and path != target / 'manifest.json':
            with path.open('rb') as stream:
                files[path.relative_to(target).as_posix()] = hashlib.file_digest(stream, 'sha256').hexdigest()
    manifest = {'schemaVersion': 1, 'platform': 'windows-x86_64', 'files': files}
    (target / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return len(files)


def copy_tree(source: Path, target: Path):
    if source.is_symlink() or source.is_junction():
        raise ValueError('Runtime sources must not contain links')
    if source.is_dir():
        target.mkdir(parents=True, exist_ok=True)
        for child in source.iterdir():
            if child.name in SKIP or child.suffix in {'.pyc', '.pyo', '.log', '.db', '.sqlite', '.sqlite3', '.key'} or child.name.startswith('.env'):
                continue
            copy_tree(child, target / child.name)
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('engine', 'python', 'git'):
        parser.add_argument('--' + name, type=Path)
    parser.add_argument('--output', type=Path, default=ROOT / 'src-tauri/resources/huanggua-studio')
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
    if not (args.engine and args.python and args.git):
        parser.error('--engine, --python and --git are required')
    if target.exists():
        raise ValueError('Output must be a new directory; preserve existing packages explicitly')
    for folder, required in ((args.engine, 'server/app.py'), (args.python, 'python.exe'), (args.git, 'usr/bin/bash.exe')):
        if not (folder / required).is_file():
            raise ValueError('A required runtime dependency is missing')
        if folder.resolve() == target or folder.resolve() in target.parents:
            raise ValueError('Output must be outside the source runtime')
    for entry in ENGINE_DIRS + ENGINE_FILES:
        copy_tree(args.engine / entry, target / 'engine' / entry)
    copy_tree(args.python, target / 'python')
    copy_tree(args.git, target / 'git')
    prune(target)
    count = write_manifest(target)
    print(f'Prepared isolated Huanggua runtime: {count} files. No account or project data included.')


if __name__ == '__main__':
    main()
