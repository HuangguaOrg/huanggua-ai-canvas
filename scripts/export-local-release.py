"""Export the latest built Windows release to E:\\TransferStation\\research\\AI-Canvas-tauri-release
and prune superseded older release .exe bundles (preserving runtime-* backup directories).
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_RELEASE_ROOT = ROOT.parent / "AI-Canvas-tauri-release"
RELEASE_DIR_RE = re.compile(r"^\d+\.\d+\.\d+-windows-")


def sha256_file(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def export_release(release_root: Path) -> None:
    version = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))["version"]
    bundle_root = ROOT / "src-tauri/target/release/bundle"
    nsis_dir = bundle_root / "nsis"
    setup_name = f"黄瓜 AI 画布_{version}_x64-setup.exe"
    setup_path = nsis_dir / setup_name
    setup_sig = nsis_dir / f"{setup_name}.sig"
    if not setup_path.is_file():
        raise FileNotFoundError(f"Latest installer not found: {setup_path}")

    release_root.mkdir(parents=True, exist_ok=True)
    target_dir = release_root / f"{version}-windows-x64"
    target_dir.mkdir(parents=True, exist_ok=True)

    # 1. Copy latest full setup.exe (+ .sig) to versioned folder and top-level convenience copy
    copied_files: list[Path] = []
    dest_setup = target_dir / setup_name
    shutil.copy2(setup_path, dest_setup)
    copied_files.append(dest_setup)
    if setup_sig.is_file():
        dest_sig = target_dir / setup_sig.name
        shutil.copy2(setup_sig, dest_sig)
        copied_files.append(dest_sig)

    top_setup = release_root / setup_name
    shutil.copy2(setup_path, top_setup)

    # 2. Copy incremental update channel artifacts if present
    gitee_update_dir = bundle_root / f"gitee-update-{version}"
    if gitee_update_dir.is_dir():
        out_channel = target_dir / "update-channel"
        if out_channel.exists():
            shutil.rmtree(out_channel)
        shutil.copytree(gitee_update_dir, out_channel)
        for item in sorted(out_channel.iterdir()):
            if item.is_file():
                copied_files.append(item)

    # 3. Write SHA256SUMS.txt
    sums_lines = [
        f"{sha256_file(path)}  {path.relative_to(target_dir).as_posix()}"
        for path in copied_files
    ]
    (target_dir / "SHA256SUMS.txt").write_text("\n".join(sums_lines) + "\n", encoding="utf-8")

    # 4. Prune older .exe / release folders in release_root (strictly keep runtime-* backups)
    removed: list[str] = []
    for entry in list(release_root.iterdir()):
        if entry.name.startswith("runtime-"):
            continue
        if entry.is_dir() and RELEASE_DIR_RE.match(entry.name) and entry.name != target_dir.name:
            shutil.rmtree(entry)
            removed.append(str(entry))
        elif entry.is_file() and entry.suffix.lower() in {".exe", ".sig"} and entry.name not in {setup_name, f"{setup_name}.sig"}:
            entry.unlink()
            removed.append(str(entry))

    # 5. Prune older .exe / update folders inside src-tauri/target/release/bundle
    if nsis_dir.is_dir():
        for entry in list(nsis_dir.iterdir()):
            if entry.is_file() and version not in entry.name and entry.suffix.lower() in {".exe", ".sig"}:
                entry.unlink()
                removed.append(str(entry))
    if bundle_root.is_dir():
        for entry in list(bundle_root.iterdir()):
            if entry.is_dir() and entry.name.startswith("gitee-update-") and entry.name != f"gitee-update-{version}":
                shutil.rmtree(entry)
                removed.append(str(entry))

    print(f"Exported latest v{version} release to: {target_dir}")
    print(f"Top-level installer: {top_setup}")
    print(f"Cleaned {len(removed)} superseded release items.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_RELEASE_ROOT)
    args = parser.parse_args()
    export_release(args.out_root.resolve())


if __name__ == "__main__":
    main()
