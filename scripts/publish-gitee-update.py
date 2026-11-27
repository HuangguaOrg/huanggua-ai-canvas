"""Publish signed desktop update artifacts and ``latest.json`` to Gitee.

Reads ``GITEE_TOKEN`` from the environment (never passed on the command line or
logged). Supports initializing an empty Gitee repository, creating or reusing
the ``v<version>`` Release, streaming signed Windows and macOS update payloads
with automatic retries and remote SHA-256 verification, and committing
``latest.json`` to the repository's default branch (``master`` or ``main``).
"""
from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

DEFAULT_REPO = "xiang834740239/huanggua-aiagent"
API_BASE = "https://gitee.com/api/v5"
GITEE_HOST = "gitee.com"
GITEE_ASSET_LIMIT_BYTES = 100 * 1024 * 1024
GITEE_REPO_QUOTA_SAFE_BYTES = 950 * 1024 * 1024
UPLOAD_CHUNK_BYTES = 1024 * 1024
PROGRESS_STEP_BYTES = 8 * 1024 * 1024
LOCAL_TOKEN_FILE = Path(__file__).resolve().parents[3] / ".secrets/huanggua-desktop/gitee.token"
_DIRECT_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _redact(text: str, token: str) -> str:
    if token and token in text:
        return text.replace(token, "***")
    return text


def gitee_json(method: str, path: str, token: str, payload: dict | None = None, *, allow_404: bool = False):
    url = f"{API_BASE}{path}"
    headers = {
        "Accept": "application/json",
        "User-Agent": "HuangGuaAI-GiteePublisher/1.0",
        "Authorization": f"token {token}",
    }
    data = None
    if payload is not None:
        body = dict(payload)
        body.setdefault("access_token", token)
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with _DIRECT_OPENER.open(req, timeout=60) as resp:
            raw = resp.read()
            return json.loads(raw.decode("utf-8")) if raw else {}
    except urllib.error.HTTPError as exc:
        if allow_404 and exc.code == 404:
            return None
        detail = _redact(exc.read().decode("utf-8", errors="replace")[:300], token)
        raise RuntimeError(f"Gitee API {method} {path} failed (HTTP {exc.code}): {detail}") from None


def _delete_attachment_by_name(repo: str, release_id: int, filename: str, token: str) -> None:
    existing = gitee_json("GET", f"/repos/{repo}/releases/{release_id}/attach_files", token) or []
    for item in existing:
        if isinstance(item, dict) and item.get("name") == filename and isinstance(item.get("id"), int):
            gitee_json("DELETE", f"/repos/{repo}/releases/{release_id}/attach_files/{item['id']}", token)


def _stream_multipart_once(repo: str, release_id: int, file_path: Path, token: str) -> dict:
    endpoint = f"/api/v5/repos/{repo}/releases/{release_id}/attach_files"
    file_size = file_path.stat().st_size
    boundary = "----HuangGuaRelease" + uuid.uuid4().hex
    prefix = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="access_token"\r\n\r\n'
        f"{token}\r\n"
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{file_path.name}"\r\n'
        "Content-Type: application/octet-stream\r\n\r\n"
    ).encode("utf-8")
    suffix = f"\r\n--{boundary}--\r\n".encode("utf-8")
    total_length = len(prefix) + file_size + len(suffix)
    total_mib = max(1, (file_size + (1024 * 1024 - 1)) // (1024 * 1024))

    conn = http.client.HTTPSConnection(GITEE_HOST, timeout=240)
    try:
        conn.putrequest("POST", endpoint)
        conn.putheader("Content-Type", f"multipart/form-data; boundary={boundary}")
        conn.putheader("Content-Length", str(total_length))
        conn.putheader("Accept", "application/json")
        conn.putheader("User-Agent", "HuangGuaAI-Release/1.0")
        conn.endheaders()
        conn.send(prefix)
        sent = 0
        last_logged = 0
        with file_path.open("rb") as stream:
            while chunk := stream.read(UPLOAD_CHUNK_BYTES):
                conn.send(chunk)
                sent += len(chunk)
                if sent - last_logged >= PROGRESS_STEP_BYTES:
                    print(f"UPLOAD_MIB {file_path.name} {sent // (1024 * 1024)}/{total_mib}", flush=True)
                    last_logged = sent
        conn.send(suffix)
        response = conn.getresponse()
        raw = response.read().decode("utf-8", errors="replace")
        if response.status not in (200, 201):
            raise RuntimeError(
                f"Gitee attachment upload failed for {file_path.name} (HTTP {response.status}): {_redact(raw[:300], token)}"
            )
        return json.loads(raw)
    finally:
        conn.close()


def upload_release_attachment(repo: str, release_id: int, file_path: Path, token: str, *, max_attempts: int = 3) -> dict:
    """Stream multipart upload to Gitee Release over HTTPS with automatic clean retries."""
    last_error: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            if attempt > 1:
                print(f"RETRY_UPLOAD {file_path.name} attempt={attempt}/{max_attempts}", flush=True)
                _delete_attachment_by_name(repo, release_id, file_path.name, token)
            return _stream_multipart_once(repo, release_id, file_path, token)
        except Exception as exc:
            last_error = exc
            if attempt >= max_attempts:
                break
            delay = 3 * attempt
            print(
                f"WARN upload {file_path.name} attempt {attempt} failed ({type(exc).__name__}: {_redact(str(exc), token)}); retrying in {delay}s",
                flush=True,
            )
            time.sleep(delay)
    assert last_error is not None
    raise RuntimeError(_redact(str(last_error), token)) from None


def _sha256_stream(stream) -> str:
    if hasattr(hashlib, "file_digest"):
        return hashlib.file_digest(stream, "sha256").hexdigest()
    digest = hashlib.sha256()
    while chunk := stream.read(1024 * 1024):
        digest.update(chunk)
    return digest.hexdigest()


def verify_remote_attachment(url: str, local_path: Path, *, max_attempts: int = 3) -> None:
    with local_path.open("rb") as stream:
        local_hash = _sha256_stream(stream)
    last_error: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "HuangGuaAI-ReleaseVerification/1.0"})
            with _DIRECT_OPENER.open(request, timeout=120) as response:
                remote_hash = _sha256_stream(response)
            if remote_hash != local_hash:
                raise ValueError(f"Remote attachment checksum mismatch for {local_path.name}")
            return
        except ValueError:
            raise
        except Exception as exc:
            last_error = exc
            if attempt >= max_attempts:
                break
            time.sleep(2 * attempt)
    assert last_error is not None
    raise RuntimeError(f"Failed to verify remote attachment {local_path.name}: {last_error}") from None


def ensure_default_branch(repo: str, token: str, preferred_branch: str = "master") -> str:
    info = gitee_json("GET", f"/repos/{repo}", token)
    branch = info.get("default_branch")
    if branch:
        return str(branch)
    readme = "# 黄瓜 AI 画布在线更新仓库\n\n本仓库托管黄瓜 AI 画布桌面客户端的签名自动更新清单 `latest.json` 与发行版更新包。\n"
    gitee_json(
        "POST",
        f"/repos/{repo}/contents/README.md",
        token,
        {
            "content": base64.b64encode(readme.encode("utf-8")).decode("ascii"),
            "message": "chore: initialize update repository",
            "branch": preferred_branch,
        },
    )
    refreshed = gitee_json("GET", f"/repos/{repo}", token)
    return str(refreshed.get("default_branch") or preferred_branch)


def upsert_repo_file(repo: str, branch: str, repo_path: str, content_bytes: bytes, message: str, token: str) -> None:
    encoded_path = "/".join(urllib.parse.quote(seg, safe="") for seg in repo_path.split("/"))
    existing = gitee_json("GET", f"/repos/{repo}/contents/{encoded_path}?ref={urllib.parse.quote(branch, safe='')}", token, allow_404=True)
    b64 = base64.b64encode(content_bytes).decode("ascii")
    if isinstance(existing, dict) and existing.get("sha"):
        gitee_json(
            "PUT",
            f"/repos/{repo}/contents/{encoded_path}",
            token,
            {"content": b64, "sha": existing["sha"], "message": message, "branch": branch},
        )
    else:
        gitee_json(
            "POST",
            f"/repos/{repo}/contents/{encoded_path}",
            token,
            {"content": b64, "message": message, "branch": branch},
        )


def ensure_release(repo: str, tag: str, branch: str, title: str, notes: str, token: str) -> int:
    existing = gitee_json("GET", f"/repos/{repo}/releases/tags/{urllib.parse.quote(tag, safe='')}", token, allow_404=True)
    if isinstance(existing, dict) and isinstance(existing.get("id"), int):
        return existing["id"]
    created = gitee_json(
        "POST",
        f"/repos/{repo}/releases",
        token,
        {
            "tag_name": tag,
            "target_commitish": branch,
            "name": title,
            "body": notes or f"黄瓜 AI 画布 {tag}",
            "prerelease": False,
        },
    )
    release_id = created.get("id")
    if not isinstance(release_id, int):
        raise RuntimeError("Gitee did not return a valid release id")
    return release_id


def _fetch_current_live_tag(repo: str, branch: str) -> str | None:
    url = f"https://gitee.com/{repo}/raw/{branch}/latest.json"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "HuangGuaAI-GiteePublisher/1.0", "Cache-Control": "no-cache"})
        with _DIRECT_OPENER.open(req, timeout=20) as resp:
            feed = json.loads(resp.read().decode("utf-8"))
        ver = str(feed.get("version") or "").strip()
        return f"v{ver}" if ver else None
    except Exception:
        return None


def ensure_gitee_quota_headroom(
    repo: str,
    branch: str,
    target_tag: str,
    needed_files: list[Path],
    token: str,
    *,
    quota_limit_bytes: int = GITEE_REPO_QUOTA_SAFE_BYTES,
) -> None:
    """Keep Gitee total Release attachment usage below its 1 GB repository quota.

    Gitee enforces a 1 GB cumulative attachment quota across all Releases in a
    repository. Old superseded hot-update packages are never fetched by clients
    once ``latest.json`` advances, while full historical installers remain
    permanently hosted on GitHub Releases. Preserves both ``target_tag`` and the
    currently live ``latest.json`` tag during upload so active updaters never see
    missing files.
    """
    releases: list[dict] = []
    for page in range(1, 6):
        batch = gitee_json("GET", f"/repos/{repo}/releases?per_page=100&page={page}&direction=asc", token) or []
        if not isinstance(batch, list) or not batch:
            break
        releases.extend(r for r in batch if isinstance(r, dict) and isinstance(r.get("id"), int))
        if len(batch) < 100:
            break
    releases.sort(key=lambda r: int(r["id"]))

    by_release: list[tuple[int, str, list[dict]]] = []
    target_existing_names: set[str] = set()
    used_bytes = 0
    for rel in releases:
        rid = int(rel["id"])
        rtag = str(rel.get("tag_name") or "")
        files = gitee_json("GET", f"/repos/{repo}/releases/{rid}/attach_files", token) or []
        valid_files = [f for f in files if isinstance(f, dict) and isinstance(f.get("id"), int)]
        for f in valid_files:
            used_bytes += int(f.get("size") or 0)
            if rtag == target_tag and isinstance(f.get("name"), str):
                target_existing_names.add(f["name"])
        by_release.append((rid, rtag, valid_files))

    needed_bytes = sum(p.stat().st_size for p in needed_files if p.name not in target_existing_names)
    print(
        f"Gitee quota check: used={used_bytes / (1024 * 1024):.1f} MiB, "
        f"needed={needed_bytes / (1024 * 1024):.1f} MiB, "
        f"safe_limit={quota_limit_bytes / (1024 * 1024):.1f} MiB",
        flush=True,
    )
    if used_bytes + needed_bytes <= quota_limit_bytes:
        return

    live_tag = _fetch_current_live_tag(repo, branch)
    protected_sets = [{target_tag, live_tag} - {None}, {target_tag}]
    for protected in protected_sets:
        if used_bytes + needed_bytes <= quota_limit_bytes:
            break
        for rid, rtag, valid_files in by_release:
            if rtag in protected or not valid_files:
                continue
            for att in list(valid_files):
                if used_bytes + needed_bytes <= quota_limit_bytes:
                    break
                aid = int(att["id"])
                asize = int(att.get("size") or 0)
                aname = str(att.get("name") or aid)
                gitee_json("DELETE", f"/repos/{repo}/releases/{rid}/attach_files/{aid}", token)
                valid_files.remove(att)
                used_bytes = max(0, used_bytes - asize)
                print(
                    f"PRUNED_OLD_ATTACHMENT {rtag}/{aname} ({asize / (1024 * 1024):.1f} MiB) "
                    f"-> used={used_bytes / (1024 * 1024):.1f} MiB",
                    flush=True,
                )


def macos_update_files(folder: Path, version: str, repo: str):
    """Validate local signed-descriptor relationships before uploading any Mac file."""
    if repo != DEFAULT_REPO or len(version) > 48 or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("Mac updater requires the configured repository and a stable release version")
    feed = json.loads((folder / "latest-macos.json").read_text(encoding="utf-8"))
    if feed.get("version") != version or len(feed.get("platforms", {})) != 1:
        raise ValueError("Mac feed version or platform count does not match")
    target, platform = next(iter(feed["platforms"].items()))
    arch = {"darwin-aarch64": "arm64", "darwin-x86_64": "x64"}.get(target)
    if not arch:
        raise ValueError("Unsupported Mac updater platform")
    stem = f"HuangGuaAI-{version}-macos-{arch}.app.tar.gz"
    base = f"https://gitee.com/{repo}/releases/download/v{version}/"
    descriptor = folder / (stem + ".update.json")
    if platform.get("url") != base + descriptor.name or platform.get("signature") != descriptor.with_name(descriptor.name + ".sig").read_text().strip():
        raise ValueError("Mac descriptor URL or signature does not match")
    index = json.loads(descriptor.read_text(encoding="utf-8"))
    if index.get("schemaVersion") != 1 or index.get("version") != version or index.get("target") != target or not 1 <= len(index.get("parts", [])) <= 16:
        raise ValueError("Invalid Mac descriptor")
    files = []
    total = 0
    combined = hashlib.sha256()
    for ordinal, part in enumerate(index["parts"], 1):
        path = folder / f"{stem}.part{ordinal:03}"
        if part.get("url") != base + path.name or not 0 < part.get("bytes", 0) <= 90 * 1024 * 1024:
            raise ValueError("Invalid Mac part address or size")
        if part.get("signature") != path.with_name(path.name + ".sig").read_text().strip() or path.stat().st_size != part["bytes"]:
            raise ValueError("Mac part signature or size does not match")
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            while data := stream.read(1024 * 1024):
                digest.update(data)
                combined.update(data)
        if digest.hexdigest() != part.get("sha256"):
            raise ValueError("Mac part checksum mismatch")
        total += part["bytes"]
        files.append(path)
    if total != index.get("totalBytes") or total > 1024 * 1024 * 1024 or combined.hexdigest() != index.get("sha256"):
        raise ValueError("Mac archive checksum or size mismatch")
    files.extend([descriptor, descriptor.with_name(descriptor.name + ".sig")])
    return feed["platforms"], files


def upload_macos_updates(folder: Path, version: str, repo: str, release_id: int, token: str, *, branch: str = "master"):
    platforms, files = macos_update_files(folder, version, repo)
    existing = gitee_json("GET", f"/repos/{repo}/releases/{release_id}/attach_files", token) or []
    names = {item.get("name") for item in existing if isinstance(item, dict)}
    missing = [p for p in files if p.name not in names]
    if missing:
        ensure_gitee_quota_headroom(repo, branch, f"v{version}", missing, token)

    def upload(path: Path):
        expected = f"https://gitee.com/{repo}/releases/download/v{version}/{path.name}"
        if path.name not in names:
            result = upload_release_attachment(repo, release_id, path, token)
            if result.get("browser_download_url") != expected:
                raise ValueError("Uploaded Mac attachment URL differs from its signed descriptor")
        try:
            verify_remote_attachment(expected, path)
        except ValueError:
            raise ValueError("Mac attachment checksum differs; refusing to publish or overwrite it") from None
        print(f"Uploaded/verified {path.name}", flush=True)

    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(upload, files))
    return platforms


def verify_public_feed(repo: str, branch: str, expected_version: str, expected_platforms: set[str], *, max_attempts: int = 6) -> dict:
    url = f"https://gitee.com/{repo}/raw/{branch}/latest.json"
    last_error: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "HuangGuaAI-ReleaseVerification/1.0", "Cache-Control": "no-cache"})
            with _DIRECT_OPENER.open(req, timeout=30) as resp:
                feed = json.loads(resp.read().decode("utf-8"))
            if str(feed.get("version") or "").strip() != expected_version:
                raise RuntimeError(f"Public latest.json version is {feed.get('version')!r}, expected {expected_version!r}")
            platforms = feed.get("platforms") if isinstance(feed.get("platforms"), dict) else {}
            missing = expected_platforms - set(platforms.keys())
            if missing:
                raise RuntimeError(f"Public latest.json missing platforms: {sorted(missing)}")
            for platform_key in expected_platforms:
                entry = platforms.get(platform_key) or {}
                if not str(entry.get("url") or "").startswith(f"https://gitee.com/{repo}/releases/download/v{expected_version}/"):
                    raise RuntimeError(f"Public latest.json has unexpected URL for {platform_key}")
                if not str(entry.get("signature") or "").strip():
                    raise RuntimeError(f"Public latest.json has empty signature for {platform_key}")
            print(f"Verified public feed {url} -> version={expected_version}, platforms={sorted(platforms.keys())}", flush=True)
            return feed
        except Exception as exc:
            last_error = exc
            if attempt >= max_attempts:
                break
            time.sleep(3)
    assert last_error is not None
    raise RuntimeError(f"Public Gitee feed verification failed ({url}): {last_error}") from None


def publish(
    update_dir: Path,
    repo: str,
    token: str,
    *,
    manifest_only: bool = False,
    preferred_branch: str = "master",
    macos_dir: Path | None = None,
    verify_feed: bool = False,
) -> None:
    manifest_path = update_dir / "latest.json"
    if not manifest_path.is_file():
        raise ValueError(f"Missing {manifest_path}")
    feed = json.loads(manifest_path.read_text(encoding="utf-8"))
    version = str(feed.get("version") or "").strip()
    if not version:
        raise ValueError("latest.json is missing version")
    tag = f"v{version}"
    branch = ensure_default_branch(repo, token, preferred_branch=preferred_branch)

    delta = feed.get("huangguaDelta") if isinstance(feed.get("huangguaDelta"), dict) else {}
    is_baseline = bool(delta.get("baseVersion")) and version == str(delta.get("baseVersion"))
    exes = sorted(update_dir.glob("*.exe"))
    release_id: int | None = None

    if not manifest_only and is_baseline and (not exes or exes[0].stat().st_size > GITEE_ASSET_LIMIT_BYTES):
        print(
            f"Baseline release {tag}: full installer is distributed externally (Plan 1); "
            "committing baseline latest.json to Gitee so subsequent incremental updates (0.11.8+) have baseline history.",
            flush=True,
        )
        manifest_only = True

    if not manifest_only:
        if len(exes) != 1:
            raise ValueError(f"Expected exactly 1 .exe payload in {update_dir}, found {len(exes)}")
        payload = exes[0]
        size_bytes = payload.stat().st_size
        if size_bytes > GITEE_ASSET_LIMIT_BYTES:
            raise ValueError(
                f"{payload.name} is {size_bytes / (1024 * 1024):.1f} MiB, exceeding Gitee's 100 MiB standard Release attachment limit. "
                "Host the full installer externally, rebuild latest.json with --download-url-base, and rerun with --manifest-only."
            )
        release_id = ensure_release(repo, tag, branch, f"黄瓜 AI 画布 {tag}", str(feed.get("notes") or ""), token)
        expected_win_url = f"https://gitee.com/{repo}/releases/download/{tag}/{payload.name}"
        existing_files = gitee_json("GET", f"/repos/{repo}/releases/{release_id}/attach_files", token) or []
        has_existing_win = any(isinstance(item, dict) and item.get("name") == payload.name for item in existing_files)
        if has_existing_win:
            try:
                verify_remote_attachment(expected_win_url, payload)
                download_url = expected_win_url
                print(f"Reused verified {payload.name} on Gitee Release {tag}", flush=True)
            except Exception:
                _delete_attachment_by_name(repo, release_id, payload.name, token)
                has_existing_win = False
        if not has_existing_win:
            ensure_gitee_quota_headroom(repo, branch, tag, [payload], token)
            uploaded = upload_release_attachment(repo, release_id, payload, token)
            download_url = uploaded.get("browser_download_url")
            if isinstance(download_url, str) and download_url.startswith("https://"):
                verify_remote_attachment(download_url, payload)
        if isinstance(download_url, str) and download_url.startswith("https://"):
            feed.setdefault("platforms", {}).setdefault("windows-x86_64", {})["url"] = download_url
            manifest_path.write_text(json.dumps(feed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"Uploaded/verified {payload.name} to Gitee Release {tag}", flush=True)

    if macos_dir is not None:
        if release_id is None:
            release_id = ensure_release(repo, tag, branch, f"黄瓜 AI 画布 {tag}", str(feed.get("notes") or ""), token)
        feed.setdefault("platforms", {}).update(upload_macos_updates(macos_dir, version, repo, release_id, token, branch=branch))
        manifest_path.write_text(json.dumps(feed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    upsert_repo_file(
        repo,
        branch,
        "latest.json",
        manifest_path.read_bytes(),
        f"chore(release): update latest.json for {tag}",
        token,
    )
    print(f"Published latest.json to https://gitee.com/{repo}/raw/{branch}/latest.json", flush=True)

    if verify_feed:
        expected_platforms = set((feed.get("platforms") or {}).keys())
        verify_public_feed(repo, branch, version, expected_platforms)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", type=Path, required=True, help="Directory generated by build-incremental-update.py")
    parser.add_argument("--repo", default=DEFAULT_REPO, help="Gitee owner/repo slug")
    parser.add_argument("--branch", default="master", help="Preferred branch if initializing an empty repo")
    parser.add_argument("--manifest-only", action="store_true", help="Only commit latest.json (when binary is hosted externally)")
    parser.add_argument("--macos-dir", type=Path, help="Signed Mac parts from build-macos-update.py; upload before publishing the shared feed")
    parser.add_argument("--verify-public-feed", action="store_true", help="Read back public raw latest.json after committing")
    args = parser.parse_args()
    token = os.environ.get("GITEE_TOKEN", "").strip()
    if not token and LOCAL_TOKEN_FILE.is_file():
        token = LOCAL_TOKEN_FILE.read_text(encoding="utf-8").strip()
    if not token:
        raise SystemExit(
            f"Missing GITEE_TOKEN environment variable (or local token file at {LOCAL_TOKEN_FILE})"
        )
    publish(
        args.dir.resolve(),
        args.repo,
        token,
        manifest_only=args.manifest_only,
        preferred_branch=args.branch,
        macos_dir=args.macos_dir.resolve() if args.macos_dir else None,
        verify_feed=args.verify_public_feed,
    )


if __name__ == "__main__":
    main()
