"""Build the signed Windows update payload and ``latest.json`` for Gitee release hosting.

Since 0.11.7 the studio runtime ships as one archive (``huanggua-studio.zip``),
so an update only has to compare a handful of installer resources. The fixed
baseline in ``runtime/studio/update-baseline.json`` records the resources of
the first archive-based release:

* the baseline release itself publishes its full installer as the update
  artifact (no installation with the archive layout predates it);
* later releases build a cumulative NSIS patch that omits every resource still
  identical to the baseline and never changed since (``carriedResources``),
  so skipped versions and reverts stay safe. Reused files are re-verified by
  SHA-256 on the user's machine before anything is replaced.

The public full installer is left intact. No upload or installation is performed.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import re
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
RESOURCES = ROOT / "src-tauri/resources"
BASELINE_FILE = ROOT / "runtime/studio/update-baseline.json"
GITEE_REPO = "xiang834740239/huanggua-aiagent"
FEED_ENDPOINTS = (
    f"https://gitee.com/{GITEE_REPO}/raw/master/latest.json",
    f"https://gitee.com/{GITEE_REPO}/raw/main/latest.json",
)
CHANNEL = f"https://gitee.com/{GITEE_REPO}/releases/download"
GITEE_ASSET_LIMIT_BYTES = 100 * 1024 * 1024
# Installer resources compared against the baseline; everything else is always shipped.
TRACKED = ("huanggua-studio.zip", "huanggua-studio.json", "director-desk.tar.gz")
RESOURCE = re.compile(r'^\s*File /a "/oname=([^"]+)" "([^"]+)"\s*$')
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")


def stable(value):
    if not isinstance(value, str) or not VERSION.fullmatch(value):
        raise ValueError("Expected a stable release version")
    return tuple(map(int, value.split(".")))


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def current_resources():
    missing = [name for name in TRACKED if not (RESOURCES / name).is_file()]
    if missing:
        raise ValueError(f"Missing installer resources: {missing}; run npm run release:pack first")
    return {name: digest(RESOURCES / name) for name in TRACKED}


def canonical_id(resources):
    return hashlib.sha256(json.dumps(resources, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def load_baseline():
    baseline = json.loads(BASELINE_FILE.read_text(encoding="utf-8"))
    resources = baseline.get("resources")
    if baseline.get("schemaVersion") != 2 or not isinstance(resources, dict) or set(resources) != set(TRACKED) \
            or not all(isinstance(v, str) and re.fullmatch(r"[0-9a-f]{64}", v) for v in resources.values()):
        raise ValueError("Invalid update baseline")
    stable(baseline.get("version"))
    return baseline["version"], resources, canonical_id(resources)


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise ValueError(f"Unexpected installer template around {old[:48]!r}")
    return source.replace(old, new)


def nsis_path(path):
    value = str(path.resolve())
    if '"' in value or '\n' in value:
        raise ValueError("Unsupported path")
    return value.replace('$', '$$')


def fetch_remote_feed(endpoints=FEED_ENDPOINTS):
    last_error = None
    for url in endpoints:
        req = urllib.request.Request(url, headers={"User-Agent": "HuangGuaAI-ReleaseBuilder/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=45) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            last_error = exc
            if exc.code == 404:
                continue
            raise
        except Exception as exc:
            last_error = exc
    raise RuntimeError(f"Could not read previous latest.json from Gitee endpoints {endpoints}: {last_error}")


def carried_from_previous(version, base_version, base_id, feed_path):
    if feed_path:
        feed = json.loads(feed_path.read_bytes())
    else:
        feed = fetch_remote_feed()
    if not stable(base_version) <= stable(feed.get("version")) < stable(version):
        raise ValueError("Expected a previous release built on the same baseline")
    history = feed.get("huangguaDelta", {})
    names = history.get("carriedResources")
    if history.get("baseSha256") != base_id or not isinstance(names, list) or not all(isinstance(n, str) for n in names):
        raise ValueError("Previous release history is missing or incompatible")
    return set(names)


def plan_resources(current, baseline, carried):
    if (baseline.keys() | carried) - current.keys():
        raise ValueError("Installer resources removed: a reviewed cleanup migration is required")
    # A resource that reverted to its baseline content may still differ on intermediate installations.
    reuse = {name: value for name, value in current.items() if name not in carried and baseline.get(name) == value}
    return reuse, sorted(current.keys() - reuse.keys())


def build_patch(source, stage, output, reuse):
    paths = set()
    lines = []
    for line in source.read_text(encoding="utf-8-sig").splitlines():
        match = RESOURCE.fullmatch(line)
        if match:
            name = match[1].replace("\\", "/").replace("$$", "$")
            if name in reuse:
                if name in paths or PureWindowsPath(name).drive or any(x in ("", ".", "..") for x in name.split("/")) or any(c in name for c in '\t\r\n:'):
                    raise ValueError("Invalid or duplicate resource destination")
                paths.add(name)
                continue
        lines.append(line)
    if paths != reuse.keys():
        raise ValueError("Generated NSIS file list differs from the tracked resources")
    inventory = stage / "reuse.tsv"
    inventory.write_text("".join(f"{reuse[name]}\t{name}\n" for name in sorted(reuse)), encoding="utf-8")
    script = "\n".join(lines)
    script = script.replace('SetCompressor /SOLID "zlib"', 'SetCompressor /SOLID "lzma"', 1)
    script = replace_once(script, 'OutFile "${OUTFILE}"', f'OutFile "{nsis_path(output)}"')
    # Prevent direct invocation from running the ordinary reinstall/uninstall pages.
    script = replace_once(script, '  !if "${DISPLAYLANGUAGESELECTOR}" == "true"', '''  ${If} $UpdateMode != 1
    Abort "Open HuangGuaAI and use Check for updates."
  ${EndIf}
  !if "${DISPLAYLANGUAGESELECTOR}" == "true"''')
    guard = f'''Section "Verify unchanged resources"
  ReadRegStr $0 HKCU "Software\\Huanggua AI\\$(^Name)" ""
  StrCmp $0 "" invalid_update_base
  GetFullPathName $0 $0
  GetFullPathName $1 $INSTDIR
  StrCmp $0 $1 0 invalid_update_base
  InitPluginsDir
  File "/oname=$PLUGINSDIR\\reuse.tsv" "{nsis_path(inventory)}"
  File "/oname=$PLUGINSDIR\\verify.ps1" "{nsis_path(ROOT / 'scripts/verify-update-base.ps1')}"
  DetailPrint "正在校验本机短剧和导演台资源，请稍候。"
  nsExec::ExecToStack '"$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\\verify.ps1" "$INSTDIR" "$PLUGINSDIR\\reuse.tsv"'
  Pop $0
  Pop $1
  StrCmp $0 0 valid_update_base
  invalid_update_base:
  MessageBox MB_ICONSTOP "本机运行资源缺失或已修改。请使用黄瓜 AI 完整安装包修复后重试。" /SD IDOK
  SetErrorLevel 2
  Abort
  valid_update_base:
SectionEnd

'''
    script = replace_once(script, 'Section EarlyChecks', guard + 'Section EarlyChecks')
    generated = stage / "patch.nsi"
    generated.write_text(script + "\n", encoding="utf-8")
    nsis = Path(os.environ["LOCALAPPDATA"]) / "tauri/NSIS/makensis.exe"
    subprocess.run([str(nsis), "-NOCD", "-INPUTCHARSET", "UTF8", "-V1", str(generated)], cwd=source.parent, check=True)


def sign(path):
    password = os.environ.get("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "")
    subprocess.run(
        ["node", str(ROOT / "node_modules/@tauri-apps/cli/tauri.js"), "signer", "sign", "-p", password, str(path)],
        check=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
    )
    return path.with_name(path.name + ".sig")


def write_baseline(version):
    resources = current_resources()
    BASELINE_FILE.write_text(json.dumps({"schemaVersion": 2, "version": version, "resources": resources}, indent=2) + "\n", encoding="utf-8")
    print(f"Update baseline written for {version}: {canonical_id(resources)}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installer-script", type=Path, help="installer.nsi generated by the standard x64 NSIS build")
    parser.add_argument("--full-installer", type=Path, help="Full NSIS setup (with .sig); used for the baseline release")
    parser.add_argument("--previous-feed", type=Path, help="latest.json of the previous public release (offline rehearsal)")
    parser.add_argument("--download-url-base", default=CHANNEL, help="Base URL for release assets (defaults to Gitee releases/download)")
    parser.add_argument("--baseline-manifest-only", action="store_true", help="For baseline release (Plan 1), emit only latest.json using existing full-installer .sig without duplicating the 300+ MB setup.exe")
    parser.add_argument("--out", type=Path, help="New output directory")
    parser.add_argument("--write-baseline", action="store_true", help="Record the current resources as the update baseline")
    args = parser.parse_args()
    version = json.loads((ROOT / "src-tauri/tauri.conf.json").read_bytes())["version"]
    if args.write_baseline:
        write_baseline(version)
        return
    if args.out is None:
        parser.error("--out is required")
    base_version, baseline, base_id = load_baseline()
    if stable(version) < stable(base_version):
        raise ValueError("This release predates the update baseline")
    current = current_resources()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    if (out / "latest.json").exists():
        raise ValueError("Choose a new output location")
    with tempfile.TemporaryDirectory(dir=out) as temp:
        stage = Path(temp)
        if version == base_version:
            if current != baseline:
                raise ValueError("Baseline release resources differ from update-baseline.json; rerun --write-baseline")
            sig_source = args.full_installer.with_name(args.full_installer.name + ".sig") if args.full_installer else None
            if not args.full_installer or not sig_source or not sig_source.is_file():
                raise ValueError("The baseline release publishes its full installer: pass --full-installer (with .sig)")
            name = f"HuangGuaAI-{version}-windows-x64-setup.exe"
            carried = []
            if args.baseline_manifest_only:
                payload = None
                signature = sig_source
            else:
                payload = stage / name
                shutil.copy2(args.full_installer, payload)
                signature = sign(payload)
        else:
            if not args.installer_script:
                raise ValueError("Pass --installer-script for an incremental release")
            source = args.installer_script.resolve()
            header = source.read_text(encoding="utf-8-sig").split("Var UpdateMode", 1)[0]
            for field, value in {"VERSION": version, "PRODUCTNAME": "黄瓜 AI 画布", "BUNDLEID": "com.huanggua.canvas", "ARCH": "x64", "INSTALLMODE": "currentUser"}.items():
                if not re.search(rf'^!define {field} "{re.escape(value)}"$', header, re.M):
                    raise ValueError("Expected matching standard x64 installer, field " + field)
            reuse, carried = plan_resources(current, baseline, carried_from_previous(version, base_version, base_id, args.previous_feed))
            name = f"HuangGuaAI-{version}-windows-x64-update.exe"
            payload = stage / name
            build_patch(source, stage, payload, reuse)
            signature = sign(payload)
            print(f"Reused {len(reuse)} resources: {sorted(reuse)}")
        download_base = args.download_url_base.rstrip("/")
        if not download_base.startswith("https://"):
            raise ValueError("--download-url-base must use https://")
        pub_date = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        feed = {
            "version": version,
            "pub_date": pub_date,
            "huangguaDelta": {"baseSha256": base_id, "baseVersion": base_version, "carriedResources": carried},
            "notes": (ROOT / ".release-notes.md").read_text(encoding="utf-8"),
            "platforms": {
                "windows-x86_64": {
                    "signature": signature.read_text().strip(),
                    "url": f"{download_base}/v{version}/{name}",
                }
            },
        }
        (stage / "latest.json").write_text(json.dumps(feed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        outputs = [stage / "latest.json"] if payload is None else [payload, signature, stage / "latest.json"]
        for file in outputs:
            if (out / file.name).exists():
                raise ValueError("Choose a new output location")
            file.rename(out / file.name)
        if payload is None:
            print(f"Baseline manifest latest.json written for {version} (full installer distributed externally via Plan 1)")
        else:
            size_bytes = (out / name).stat().st_size
            print(f"Update payload {name}: {size_bytes:,} bytes")
            if download_base.startswith("https://gitee.com/") and size_bytes > GITEE_ASSET_LIMIT_BYTES:
                print(
                    f"NOTE: {name} is {size_bytes / (1024 * 1024):.1f} MiB (> 100 MiB Gitee Release attachment limit). "
                    "For the baseline release (Plan 1), only latest.json needs to be committed to Gitee."
                )


if __name__ == "__main__":
    main()
