"""Prepare offline Director Desk + macOS Studio Python 3.12 runtime for Tauri packaging.

Designed for GitHub Actions macOS runners (and local macOS builds):
1. Downloads and SHA-256 verifies `src-tauri/resources/director-desk.tar.gz`.
2. Downloads and SHA-256 verifies the audited Studio engine seed tarball from
   `runtime/studio/engine-distribution.json`.
3. Installs standalone CPython 3.12 via `uv`, installs locked dependencies into
   it, stages `src-tauri/resources/huanggua-studio` without symlinks, and runs
   an isolated import/binary smoke test without writing `.pyc` files.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DIRECTOR_LOCK = ROOT / "scripts/director-desk-release.json"
ENGINE_LOCK = ROOT / "runtime/studio/engine-distribution.json"
DIRECTOR_TARGET = ROOT / "src-tauri/resources/director-desk.tar.gz"
DEFAULT_OUTPUT = ROOT / "src-tauri/resources/huanggua-studio"

UV_PYTHON_SPECS = {
    "darwin-aarch64": ("cpython-3.12-macos-aarch64-none", "aarch64-apple-darwin"),
    "darwin-x86_64": ("cpython-3.12-macos-x86_64-none", "x86_64-apple-darwin"),
}


class _CrossOriginSafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is None:
            return None
        if urllib.parse.urlparse(req.full_url).netloc != urllib.parse.urlparse(newurl).netloc:
            redirected.headers.pop("Authorization", None)
            redirected.unredirected_hdrs.pop("Authorization", None)
            redirected.headers["Accept"] = "*/*"
        return redirected


def default_macos_platform() -> str:
    return "darwin-aarch64" if platform.machine() == "arm64" else "darwin-x86_64"


def sha256_file(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download_verified_url(url: str, destination: Path, expected_sha256: str, headers: dict[str, str] | None = None) -> None:
    if destination.is_file() and sha256_file(destination) == expected_sha256:
        print(f"Verified existing {destination.name} ({expected_sha256[:12]}...)")
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    part = destination.with_suffix(destination.suffix + ".part")
    opener = urllib.request.build_opener(_CrossOriginSafeRedirectHandler)
    req_headers = {"User-Agent": "huanggua-macos-builder"}
    if headers:
        req_headers.update(headers)
    req = urllib.request.Request(url, headers=req_headers)
    with opener.open(req, timeout=300) as resp, part.open("wb") as out:
        shutil.copyfileobj(resp, out, length=1024 * 1024)
    actual = sha256_file(part)
    if actual != expected_sha256:
        part.unlink(missing_ok=True)
        raise ValueError(f"SHA-256 mismatch for {destination.name}: expected {expected_sha256}, got {actual}")
    part.replace(destination)
    print(f"Downloaded & verified {destination.name} ({destination.stat().st_size} bytes)")


def prepare_director_desk() -> None:
    lock = json.loads(DIRECTOR_LOCK.read_text(encoding="utf-8"))
    url = lock["url"]
    if not url.startswith("https://github.com/"):
        raise ValueError(f"Untrusted director-desk URL: {url}")
    download_verified_url(url, DIRECTOR_TARGET, lock["sha256"])


def download_engine_seed(temp_dir: Path) -> tuple[Path, dict]:
    lock = json.loads(ENGINE_LOCK.read_text(encoding="utf-8"))
    repo = lock["repository"]
    tag = lock["tag"]
    asset_name = lock["asset"]
    expected_sha = lock["sha256"]
    archive_path = temp_dir / asset_name

    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""
    gh_bin = shutil.which("gh")
    if gh_bin and token:
        env = dict(os.environ, GH_TOKEN=token)
        subprocess.run(
            [gh_bin, "release", "download", tag, "--repo", repo, "--pattern", asset_name, "--dir", str(temp_dir), "--clobber"],
            env=env,
            check=True,
        )
        actual = sha256_file(archive_path)
        if actual != expected_sha:
            raise ValueError(f"Engine seed SHA-256 mismatch: expected {expected_sha}, got {actual}")
    else:
        if not token:
            raise RuntimeError("GH_TOKEN or GITHUB_TOKEN is required to fetch private Studio engine seed")
        meta_req = urllib.request.Request(
            f"https://api.github.com/repos/{repo}/releases/tags/{tag}",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "huanggua-macos-builder",
            },
        )
        with urllib.request.urlopen(meta_req, timeout=60) as resp:
            release = json.loads(resp.read().decode("utf-8"))
        asset_url = next((a["url"] for a in release.get("assets", []) if a.get("name") == asset_name), None)
        if not asset_url:
            raise RuntimeError(f"Asset {asset_name} not found in {repo}@{tag}")
        download_verified_url(
            asset_url,
            archive_path,
            expected_sha,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/octet-stream",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )

    seed_dir = temp_dir / "seed"
    seed_dir.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive_path, "r:gz") as tf:
        for member in tf.getmembers():
            name = member.name
            if not name or name.startswith("/") or "\\" in name or any(p in {".", ".."} for p in name.split("/")):
                raise ValueError(f"Unsafe tar member in engine seed: {name}")
            if member.issym() or member.islnk() or not (member.isfile() or member.isdir()):
                raise ValueError(f"Disallowed tar member type in engine seed: {name}")
        tf.extractall(seed_dir, filter="data")
    return seed_dir, lock


def write_arcreel_dist_info(site_packages: Path, version: str) -> None:
    dist_info = site_packages / f"arcreel-{version}.dist-info"
    dist_info.mkdir(parents=True, exist_ok=True)
    metadata = f"Metadata-Version: 2.3\nName: arcreel\nVersion: {version}\nSummary: AI video generation workspace\n"
    (dist_info / "METADATA").write_text(metadata, encoding="utf-8")
    (dist_info / "INSTALLER").write_text("uv\n", encoding="utf-8")
    (dist_info / "WHEEL").write_text("Wheel-Version: 1.0\nGenerator: huanggua\nRoot-Is-Purelib: true\nTag: py3-none-any\n", encoding="utf-8")
    (dist_info / "RECORD").write_text(
        f"arcreel-{version}.dist-info/METADATA,,\n"
        f"arcreel-{version}.dist-info/INSTALLER,,\n"
        f"arcreel-{version}.dist-info/WHEEL,,\n"
        f"arcreel-{version}.dist-info/RECORD,,\n",
        encoding="utf-8",
    )


def prepare_portable_python(temp_dir: Path, seed_dir: Path, target_platform: str, arcreel_version: str) -> Path:
    uv_bin = shutil.which("uv")
    if not uv_bin:
        raise RuntimeError("`uv` is required on PATH (use astral-sh/setup-uv in CI)")
    spec, uv_platform = UV_PYTHON_SPECS[target_platform]
    uv_py_dir = temp_dir / "uv-python"
    uv_py_dir.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, UV_PYTHON_INSTALL_DIR=str(uv_py_dir), PYTHONDONTWRITEBYTECODE="1")

    subprocess.run([uv_bin, "python", "install", spec], env=env, check=True)
    found = subprocess.check_output(
        [uv_bin, "python", "find", "--managed-python", "--no-project", spec],
        env=env,
        text=True,
    ).strip()
    py_bin = Path(found).resolve()
    py_prefix = py_bin.parent.parent
    if not (py_prefix / "bin").is_dir() or not (py_prefix / "lib").is_dir():
        raise RuntimeError(f"Unexpected portable Python prefix layout: {py_prefix}")

    engine_dir = seed_dir / "engine"
    pyproject = tomllib.loads((engine_dir / "pyproject.toml").read_text(encoding="utf-8"))
    deps = [
        dep for dep in pyproject["project"]["dependencies"]
        if not dep.startswith(("arcreel-market-core", "arcreel-catalog-core"))
    ]
    constraints = seed_dir / "constraints.txt"
    install_cmd = [
        uv_bin,
        "pip",
        "install",
        "--python",
        str(py_bin),
        "--python-platform",
        uv_platform,
        "--system",
        "--break-system-packages",
        "-c",
        str(constraints),
        str(engine_dir / "packages/arcreel-catalog-core"),
        str(engine_dir / "packages/arcreel-market-core"),
        *deps,
    ]
    subprocess.run(install_cmd, env=env, check=True)

    # Locate site-packages and record arcreel dist-info without duplicating engine/lib & engine/server.
    py_lib_dirs = [p for p in (py_prefix / "lib").iterdir() if p.is_dir() and p.name.startswith("python3.")]
    if len(py_lib_dirs) != 1:
        raise RuntimeError(f"Expected one python3.x stdlib directory in {py_prefix / 'lib'}, got {py_lib_dirs}")
    stdlib_dir = py_lib_dirs[0]
    site_packages = stdlib_dir / "site-packages"
    write_arcreel_dist_info(site_packages, arcreel_version)

    # Remove static libpython archive and unused GUI/test stdlib trees before staging.
    for extra in (
        py_prefix / "share",
        stdlib_dir / "test",
        stdlib_dir / "idlelib",
        stdlib_dir / "tkinter",
        stdlib_dir / "turtledemo",
    ):
        if extra.exists() or extra.is_symlink():
            if extra.is_dir() and not extra.is_symlink():
                shutil.rmtree(extra)
            else:
                extra.unlink()
    for cfg_dir in stdlib_dir.glob("config-3.*"):
        if cfg_dir.is_dir():
            shutil.rmtree(cfg_dir)

    # Materialize bin/python3 as a standalone executable and drop redundant bin symlinks/wrappers
    real_py = (py_prefix / "bin/python3").resolve()
    target_py3 = py_prefix / "bin/python3"
    if target_py3.is_symlink():
        target_py3.unlink()
        shutil.copy2(real_py, target_py3)
    target_py3.chmod(0o755)
    for item in list((py_prefix / "bin").iterdir()):
        if item.name != "python3" and (item.name.startswith(("python", "idle", "pydoc", "2to3")) or item.is_symlink()):
            if item.is_symlink() or item.name in {"python", "python3.12", "python3-config", "python3.12-config"}:
                if item.name != "python3":
                    item.unlink(missing_ok=True)

    # Avoid duplicating multi-MB libpython3.dylib if it is just an unversioned symlink to libpython3.12.dylib
    unversioned_dylib = py_prefix / "lib/libpython3.dylib"
    if unversioned_dylib.is_symlink():
        unversioned_dylib.unlink()

    return py_prefix


def smoke_test_staged_runtime(staged: Path, target_platform: str) -> None:
    if sys.platform != "darwin":
        return
    native = default_macos_platform()
    if native != target_platform:
        print(f"Skipping execution smoke test for cross-arch {target_platform} on {native} host")
        return
    py3 = staged / "python/bin/python3"
    py3.chmod(0o755)
    for path in staged.rglob("*"):
        rel = path.relative_to(staged).as_posix()
        if path.is_file() and (
            rel.startswith("python/bin/")
            or "/_bundled/claude" in rel
            or "/binaries/ffmpeg" in rel
            or rel.endswith((".dylib", ".so"))
        ):
            path.chmod(0o755)

    code = (
        "import importlib.metadata as m, os, pathlib, subprocess;"
        "import server.app, claude_agent_sdk, PIL, pydantic_core, pdf_oxide, imageio_ffmpeg;"
        "assert m.version('arcreel') == '0.34.0', m.version('arcreel');"
        "ff = pathlib.Path(imageio_ffmpeg.get_ffmpeg_exe());"
        "assert ff.is_file() and os.access(ff, os.X_OK), ff;"
        "sdk_dir = pathlib.Path(claude_agent_sdk.__file__).resolve().parent / '_bundled';"
        "claude = sdk_dir / 'claude';"
        "assert claude.is_file() and os.access(claude, os.X_OK), claude;"
        "print('Smoke test OK:', m.version('arcreel'), ff.name, claude.name)"
    )
    env = {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONNOUSERSITE": "1",
        "PYTHONPATH": str(staged / "engine"),
        "LANG": "en_US.UTF-8",
    }
    subprocess.run([str(py3), "-B", "-s", "-c", code], cwd=str(staged / "engine"), env=env, check=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", default=default_macos_platform(), choices=sorted(UV_PYTHON_SPECS))
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--clean", action="store_true", help="Remove existing output directory first")
    args = parser.parse_args()

    output = args.output.resolve()
    if output.exists():
        if not args.clean:
            raise ValueError(f"Output directory already exists: {output} (pass --clean to replace)")
        shutil.rmtree(output)

    prepare_director_desk()

    with tempfile.TemporaryDirectory(prefix="huanggua-macos-rt-") as tmp:
        temp_dir = Path(tmp)
        seed_dir, lock = download_engine_seed(temp_dir)
        py_prefix = prepare_portable_python(temp_dir, seed_dir, args.platform, lock.get("arcreelVersion", "0.34.0"))
        subprocess.run(
            [
                sys.executable,
                "-B",
                str(ROOT / "scripts/package-studio-runtime.py"),
                "--engine",
                str(seed_dir / "engine"),
                "--python",
                str(py_prefix),
                "--output",
                str(output),
                "--platform",
                args.platform,
                "--dereference-links",
            ],
            env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"),
            check=True,
        )

    smoke_test_staged_runtime(output, args.platform)


if __name__ == "__main__":
    main()
