"""Publish signed desktop update artifacts and ``latest.json`` to Gitee.

Reads ``GITEE_TOKEN`` from the environment (never passed on the command line or
logged). Supports initializing an empty Gitee repository, creating or reusing
the ``v<version>`` Release, uploading the signed ``.exe`` update package as a
Release attachment, and committing ``latest.json`` to the repository's default
branch (``master`` or ``main``).
"""
import argparse
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_REPO = "xiang834740239/huanggua-aiagent"
API_BASE = "https://gitee.com/api/v5"
GITEE_ASSET_LIMIT_BYTES = 100 * 1024 * 1024
LOCAL_TOKEN_FILE = Path(__file__).resolve().parents[3] / ".secrets/huanggua-desktop/gitee.token"
_DIRECT_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


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
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        raise RuntimeError(f"Gitee API {method} {path} failed (HTTP {exc.code}): {detail}") from None


def upload_release_attachment(repo: str, release_id: int, file_path: Path, token: str) -> dict:
    """Stream multipart upload to Gitee Release via HTTP/1.1 curl."""
    curl_bin = shutil.which("curl.exe") or shutil.which("curl")
    if not curl_bin:
        raise RuntimeError("curl is required for streaming release attachment uploads")
    url = f"{API_BASE}/repos/{repo}/releases/{release_id}/attach_files"
    with tempfile.TemporaryDirectory() as tmp:
        cfg_path = Path(tmp) / "curl.cfg"
        out_path = Path(tmp) / "resp.json"
        # Pass token via temporary curl config file so it never appears on process command line.
        escaped_file = str(file_path).replace("\\", "/")
        cfg_path.write_text(
            "\n".join([
                "http1.1",
                "progress-bar",
                "show-error",
                "retry = 2",
                "retry-delay = 3",
                "max-time = 2400",
                f'url = "{url}"',
                'header = "User-Agent: Mozilla/5.0"',
                'header = "Accept: application/json"',
                f'form-string = "access_token={token}"',
                f'form = "file=@{escaped_file}"',
                f'output = "{str(out_path).replace(chr(92), "/")}"',
                'write-out = "%{http_code}"',
            ]),
            encoding="utf-8",
        )
        res = subprocess.run([curl_bin, "--config", str(cfg_path)], text=True, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE)
        http_code = (res.stdout or "").strip()
        raw_body = out_path.read_text(encoding="utf-8", errors="replace") if out_path.is_file() else ""
        if res.returncode != 0 or not http_code.startswith("2"):
            raise RuntimeError(
                f"Gitee attachment upload failed (exit={res.returncode}, HTTP={http_code}): {raw_body[:300]}"
            )
        return json.loads(raw_body)


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


def publish(update_dir: Path, repo: str, token: str, *, manifest_only: bool = False, preferred_branch: str = "master") -> None:
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

    if not manifest_only and is_baseline and (not exes or exes[0].stat().st_size > GITEE_ASSET_LIMIT_BYTES):
        print(
            f"Baseline release {tag}: full installer is distributed externally (Plan 1); "
            "committing baseline latest.json to Gitee so subsequent incremental updates (0.11.8+) have baseline history."
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
        existing_files = gitee_json("GET", f"/repos/{repo}/releases/{release_id}/attach_files", token) or []
        for item in existing_files:
            if isinstance(item, dict) and item.get("name") == payload.name and isinstance(item.get("id"), int):
                gitee_json("DELETE", f"/repos/{repo}/releases/{release_id}/attach_files/{item['id']}", token)
        uploaded = upload_release_attachment(repo, release_id, payload, token)
        download_url = uploaded.get("browser_download_url")
        if isinstance(download_url, str) and download_url.startswith("https://"):
            feed.setdefault("platforms", {}).setdefault("windows-x86_64", {})["url"] = download_url
            manifest_path.write_text(json.dumps(feed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"Uploaded {payload.name} to Gitee Release {tag}")

    upsert_repo_file(
        repo,
        branch,
        "latest.json",
        manifest_path.read_bytes(),
        f"chore(release): update latest.json for {tag}",
        token,
    )
    print(f"Published latest.json to https://gitee.com/{repo}/raw/{branch}/latest.json")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", type=Path, required=True, help="Directory generated by build-incremental-update.py")
    parser.add_argument("--repo", default=DEFAULT_REPO, help="Gitee owner/repo slug")
    parser.add_argument("--branch", default="master", help="Preferred branch if initializing an empty repo")
    parser.add_argument("--manifest-only", action="store_true", help="Only commit latest.json (when binary is hosted externally)")
    args = parser.parse_args()
    token = os.environ.get("GITEE_TOKEN", "").strip()
    if not token and LOCAL_TOKEN_FILE.is_file():
        token = LOCAL_TOKEN_FILE.read_text(encoding="utf-8").strip()
    if not token:
        raise SystemExit(
            f"Missing GITEE_TOKEN environment variable (or local token file at {LOCAL_TOKEN_FILE})"
        )
    publish(args.dir.resolve(), args.repo, token, manifest_only=args.manifest_only, preferred_branch=args.branch)


if __name__ == "__main__":
    main()
