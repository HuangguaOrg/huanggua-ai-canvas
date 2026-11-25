"""Build signed, ordered Gitee chunks of a complete macOS Tauri updater archive.

The signed descriptor authenticates version, target, order, sizes and hashes.
Nothing is uploaded and no application is installed by this script.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
CHANNEL = "https://gitee.com/xiang834740239/huanggua-aiagent/releases/download"
PART_BYTES = 90 * 1024 * 1024


def sign(path):
    env = dict(os.environ)
    env.setdefault("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "")
    subprocess.run(["node", str(ROOT / "node_modules/@tauri-apps/cli/tauri.js"), "signer", "sign", str(path)],
                   env=env, check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
    return path.with_name(path.name + ".sig").read_text(encoding="utf-8").strip()


def build(archive, out, version, target, signer=sign, part_bytes=PART_BYTES):
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version) or len(version) > 48:
        raise ValueError("Expected a stable release version")
    arch = {"darwin-aarch64": "arm64", "darwin-x86_64": "x64"}.get(target)
    if not arch or not 0 < part_bytes <= PART_BYTES:
        raise ValueError("Unsupported platform or part size")
    size = archive.stat().st_size
    if not 0 < size <= 1024 * 1024 * 1024 or (size + part_bytes - 1) // part_bytes > 16:
        raise ValueError("Archive exceeds the client resource limits")
    # Verify the actual archive version before publishing a signed descriptor for it.
    with tarfile.open(archive, "r:gz") as tar:
        entries = tar.getmembers()
        plist_entries = [entry for entry in entries if entry.name.endswith(".app/Contents/Info.plist")]
        if len(plist_entries) != 1:
            raise ValueError("Expected one complete application bundle")
        with tar.extractfile(plist_entries[0]) as stream:
            plist = plistlib.load(stream)
        if plist.get("CFBundleShortVersionString") != version or plist.get("CFBundleIdentifier") != "com.huanggua.canvas":
            raise ValueError("Application identity or version differs from the release")
        bundle = plist_entries[0].name.removesuffix("/Contents/Info.plist")
        names = {entry.name for entry in entries}
        if not {bundle + "/Contents/MacOS/HuangGuaAI", bundle + "/Contents/_CodeSignature/CodeResources"} <= names:
            raise ValueError("Application executable or code signature is missing")
    out.mkdir(parents=True, exist_ok=False)
    name = f"HuangGuaAI-{version}-macos-{arch}.app.tar.gz"
    base = f"{CHANNEL}/v{version}/"
    total_hash = hashlib.sha256()
    parts = []
    with archive.open("rb") as stream:
        while data := stream.read(part_bytes):
            part = out / f"{name}.part{len(parts) + 1:03}"
            part.write_bytes(data)
            total_hash.update(data)
            parts.append({"url": base + part.name, "signature": signer(part),
                          "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    descriptor = {"schemaVersion": 1, "version": version, "target": target,
                  "totalBytes": size, "sha256": total_hash.hexdigest(), "parts": parts}
    manifest = out / (name + ".update.json")
    manifest.write_text(json.dumps(descriptor, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    signature = signer(manifest)
    feed = {"version": version, "pub_date": datetime.now(timezone.utc).isoformat(),
            "platforms": {target: {"url": base + manifest.name, "signature": signature}}}
    (out / "latest-macos.json").write_text(json.dumps(feed, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"Built {len(parts)} signed parts ({size:,} bytes) and a signed descriptor for {target}")
    return descriptor


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--target", choices=["darwin-aarch64", "darwin-x86_64"], required=True)
    args = parser.parse_args()
    version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    build(args.archive.resolve(), args.out.resolve(), version, args.target)


if __name__ == "__main__":
    main()
