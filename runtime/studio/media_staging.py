"""Spec validation and temporary URL staging on huanggua.my for Studio media references.

Local uploads stay strictly inside the user's local Studio project and asset library.
Only when executing downstream image-referenced or video-referenced generation, after
specification validation, local media files are staged to https://huanggua.my/v1/media/uploads
and converted into temporary HTTPS URLs for upstream providers.
"""
from __future__ import annotations

import asyncio
import contextvars
from dataclasses import replace
import io
import json
from pathlib import Path
import re
import subprocess
import tempfile
import time
from urllib.parse import urlsplit

import httpx
from PIL import Image, ImageOps

IMAGE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024
VIDEO_UPLOAD_MAX_BYTES = 64 * 1024 * 1024
SHOT_REFS_FIELD = "desktop_shot_references"
UNIT_REFS_FIELD = "desktop_unit_references"

# Video reference capacity from the reviewed Huanggua video catalog (max_videos > 0).
VIDEO_INPUT_LIMITS: dict[str, int] = {
    "catcode-Seedance-2.0-官转": 3,
    "catcode-Seedance-2.0-官转-Full": 3,
    "catcode-Seedance-2.5-官转": 10,
    "catcode-Seedance-2.5-官转-Full": 10,
    "catcode-9图系列-sd2.5": 3,
    "catcode-Z-sd2.5-480": 10,
    "catcode-Z-sd2.5-720": 10,
    "catcode-sd-2.0-903-gf": 3,
    "catcode-sd-2.0-933-Xs按次": 3,
    "catcode-sd-2.0-933-max": 3,
    "catcode-sd-2.5-301010-720p": 10,
    "catcode-sd-2.5-301010-X": 10,
    "catcode-sd-2.5-301010-按次": 10,
    "catcode-sd-2.5-480p满血全参按次": 10,
    "catcode-sd-2.5-gz": 10,
    "catcode-sd-2.5-满血全参按次": 10,
    "catcode-Minimax H3": 3,
    "catcode-Minimax H3-768p": 3,
}

GRSAI_PIXEL_SIZES: dict[str, tuple[str, str, str]] = {
    "1:1": ("1024x1024", "2048x2048", "2880x2880"),
    "16:9": ("1280x720", "2048x1152", "3840x2160"),
    "9:16": ("720x1280", "1152x2048", "2160x3840"),
    "4:3": ("1152x864", "2304x1728", "3264x2448"),
    "3:4": ("864x1152", "1728x2304", "2448x3264"),
    "3:2": ("1536x1024", "2048x1360", "3504x2336"),
    "2:3": ("1024x1536", "1360x2048", "2336x3504"),
    "5:4": ("1120x896", "2240x1792", "3200x2560"),
    "4:5": ("896x1120", "1792x2240", "2560x3200"),
    "21:9": ("1456x624", "2912x1248", "3840x1648"),
}

CURRENT_TASK: contextvars.ContextVar[dict | None] = contextvars.ContextVar("huanggua_studio_task", default=None)
_DIMENSIONS_RE = re.compile(r"Stream #\d+:\d+.*?Video:.*?,\s*(\d{2,5})x(\d{2,5})\b")
_PRESET_CACHE: dict[str, list[dict]] = {}


def _preset_models(root: Path) -> list[dict]:
    key = str(root)
    if key not in _PRESET_CACHE:
        _PRESET_CACHE[key] = json.loads((root / "huanggua-models.json").read_text(encoding="utf-8")).get("models", [])
    return _PRESET_CACHE[key]


def model_media_spec(root: Path, category: str, model_id: str) -> dict:
    models = _preset_models(root)
    entry = next((m for m in models if m.get("model_id") == model_id), None) or {}
    overrides = entry.get("capability_overrides") or {}
    resolution = entry.get("resolution") or ("1K" if category == "image" else "720p")
    if category == "image":
        i2i = overrides.get("image_to_image", True)
        max_images = 5 if i2i else 0
        return {
            "model": model_id,
            "category": "image",
            "resolution": resolution,
            "resolutions": [resolution],
            "durations": [],
            "first_frame": False,
            "last_frame": False,
            "max_images": max_images,
            "max_videos": 0,
            "max_image_bytes": IMAGE_UPLOAD_MAX_BYTES,
            "max_video_bytes": 0,
        }
    return {
        "model": model_id,
        "category": "video",
        "resolution": resolution,
        "resolutions": overrides.get("resolutions") or [resolution],
        "durations": overrides.get("durations") or [],
        "first_frame": bool(overrides.get("first_frame", True)),
        "last_frame": bool(overrides.get("last_frame", False)),
        "max_images": int(overrides.get("max_reference_images", 9)),
        "max_videos": VIDEO_INPUT_LIMITS.get(model_id, 0),
        "max_image_bytes": IMAGE_UPLOAD_MAX_BYTES,
        "max_video_bytes": VIDEO_UPLOAD_MAX_BYTES if VIDEO_INPUT_LIMITS.get(model_id, 0) > 0 else 0,
    }


def target_pixel_size(model_id: str, ratio: str, resolution: str) -> str | None:
    if model_id.startswith("grsai-gpt-image") and ratio in GRSAI_PIXEL_SIZES and resolution in ("1K", "2K", "4K"):
        return GRSAI_PIXEL_SIZES[ratio][("1K", "2K", "4K").index(resolution)]
    return None


def _probe_video_dimensions_sync(path: Path) -> tuple[int | None, int | None]:
    from lib.infra.ffmpeg import ffmpeg_executable, local_file_input
    try:
        proc = subprocess.run(
            [ffmpeg_executable(), "-hide_banner", *local_file_input(path)],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=15,
            check=False,
        )
        match = _DIMENSIONS_RE.search(proc.stderr.decode("utf-8", errors="replace"))
        if match:
            return int(match.group(1)), int(match.group(2))
    except Exception:
        pass
    return None, None


def _inspect_image_sync(path: Path, display_name: str, role: str) -> dict:
    from lib.backends.huanggua import public_reference
    size = path.stat().st_size
    with Image.open(path) as img:
        fmt = (img.format or "").upper()
        frame = ImageOps.exif_transpose(img)
        width, height = frame.size
    cached = bool(public_reference(path))
    adjustments = []
    if fmt not in {"PNG", "JPEG", "WEBP"}:
        adjustments.append(f"图片格式 {fmt or '未知'} 将转换为 PNG 副本后暂存")
    if size > IMAGE_UPLOAD_MAX_BYTES:
        adjustments.append("图片超过 20 MiB，将自动生成轻量 WebP/JPEG 副本上传（本地原图不变）")
    return {
        "role": role,
        "name": display_name,
        "kind": "image",
        "format": fmt or path.suffix.lstrip(".").upper(),
        "width": width,
        "height": height,
        "durationSeconds": None,
        "sizeBytes": size,
        "cached": cached,
        "adjustments": adjustments,
    }


async def inspect_local_media(path: Path, *, display_name: str, role: str, expected_kind: str) -> dict:
    if not path.is_file() or path.is_symlink():
        return {
            "role": role,
            "name": display_name,
            "kind": expected_kind,
            "missing": True,
            "sizeBytes": 0,
            "adjustments": [],
        }
    if expected_kind == "image":
        return await asyncio.to_thread(_inspect_image_sync, path, display_name, role)
    from lib.backends.huanggua import public_reference
    from lib.infra.media_probe import probe_media
    size = await asyncio.to_thread(lambda: path.stat().st_size)
    probe = await probe_media(path)
    video_stream = probe.first_stream("video")
    if video_stream is None:
        raise ValueError("studio_invalid_video")
    width, height = await asyncio.to_thread(_probe_video_dimensions_sync, path)
    cached = bool(await asyncio.to_thread(public_reference, path))
    ext = path.suffix.lower()
    adjustments = []
    if ext in {".mov", ".m4v"} or (video_stream.codec and video_stream.codec not in {"h264", "vp8", "vp9", "av1"}):
        adjustments.append("视频将在暂存前封装为标准 MP4 副本（本地原视频保持不变）")
    return {
        "role": role,
        "name": display_name,
        "kind": "video",
        "format": ext.lstrip(".").upper() or "MP4",
        "codec": video_stream.codec,
        "width": width,
        "height": height,
        "durationSeconds": round(probe.duration_seconds or video_stream.duration_seconds or 0.0, 2),
        "sizeBytes": size,
        "cached": cached,
        "adjustments": adjustments,
    }


def convert_video_to_mp4_sync(source: Path, destination: Path) -> Path:
    """Convert .webm/.mov/.m4v to a faststart H.264/AAC .mp4 in a short temp directory."""
    from lib.infra.ffmpeg import ffmpeg_executable, local_file_input
    staging = Path(tempfile.mkdtemp(prefix="hg-vconv-"))
    short_out = staging / "normalized.mp4"
    try:
        exe = ffmpeg_executable()
        if source.suffix.lower() in {".mp4", ".mov", ".m4v"}:
            copy_run = subprocess.run(
                [exe, "-y", "-hide_banner", "-loglevel", "error", *local_file_input(source),
                 "-map", "0:v:0", "-map", "0:a?", "-c:v", "copy", "-c:a", "aac", "-movflags", "+faststart", str(short_out)],
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=120,
                check=False,
            )
            if copy_run.returncode == 0 and short_out.is_file() and short_out.stat().st_size > 0:
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(short_out.read_bytes())
                return destination
        transcode = subprocess.run(
            [exe, "-y", "-hide_banner", "-loglevel", "error", *local_file_input(source),
             "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
             "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", str(short_out)],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=300,
            check=False,
        )
        if transcode.returncode != 0 or not short_out.is_file() or short_out.stat().st_size == 0:
            raise ValueError("studio_invalid_video")
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(short_out.read_bytes())
        return destination
    finally:
        for child in staging.glob("*"):
            child.unlink(missing_ok=True)
        staging.rmdir()


def extract_video_keyframes_sync(source: Path, count: int = 2) -> list[bytes]:
    """Extract lightweight JPEG keyframes from a local video for Agent multimodal context."""
    from lib.infra.ffmpeg import ffmpeg_executable, local_file_input
    staging = Path(tempfile.mkdtemp(prefix="hg-vframe-"))
    frames: list[bytes] = []
    try:
        pattern = staging / "frame_%02d.jpg"
        subprocess.run(
            [ffmpeg_executable(), "-y", "-hide_banner", "-loglevel", "error", *local_file_input(source),
             "-vf", "fps=1/2,scale='min(1024,iw)':-2", "-frames:v", str(count), "-q:v", "4", str(pattern)],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=30,
            check=False,
        )
        for item in sorted(staging.glob("frame_*.jpg")):
            if item.stat().st_size > 0:
                frames.append(item.read_bytes())
        if not frames:
            single = staging / "single.jpg"
            subprocess.run(
                [ffmpeg_executable(), "-y", "-hide_banner", "-loglevel", "error", *local_file_input(source),
                 "-frames:v", "1", "-vf", "scale='min(1024,iw)':-2", "-q:v", "4", str(single)],
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=30,
                check=False,
            )
            if single.is_file() and single.stat().st_size > 0:
                frames.append(single.read_bytes())
        return frames
    finally:
        for child in staging.glob("*"):
            child.unlink(missing_ok=True)
        staging.rmdir()


def prepare_image_bytes_sync(path: Path) -> tuple[bytes, str]:
    raw = path.read_bytes()
    if not raw:
        raise ValueError("参考图片为空，请重新上传本地图片。")
    with Image.open(io.BytesIO(raw)) as img:
        fmt = (img.format or "").upper()
        if fmt in {"PNG", "JPEG", "WEBP"} and len(raw) <= IMAGE_UPLOAD_MAX_BYTES:
            return raw, Image.MIME[fmt]
        frame = ImageOps.exif_transpose(img).convert("RGB")
    for max_edge in (3072, 2048, 1536):
        copy_img = frame.copy()
        copy_img.thumbnail((max_edge, max_edge))
        for quality in (90, 80, 68):
            buf = io.BytesIO()
            copy_img.save(buf, format="WEBP", quality=quality)
            out = buf.getvalue()
            if len(out) <= IMAGE_UPLOAD_MAX_BYTES:
                return out, "image/webp"
    raise ValueError("参考图片超过 20 MiB 上限且无法压缩到可用体积，请更换图片后重试。")


def prepare_video_bytes_sync(path: Path, temp_dir: Path) -> tuple[bytes, str, str]:
    size = path.stat().st_size
    if size <= 0:
        raise ValueError("参考视频为空，请重新上传本地视频。")
    ext = path.suffix.lower()
    target = path
    if ext not in {".mp4", ".webm"}:
        target = convert_video_to_mp4_sync(path, temp_dir / f"{path.stem}.mp4")
    data = target.read_bytes()
    if len(data) > VIDEO_UPLOAD_MAX_BYTES:
        raise ValueError("参考视频超过 64 MiB 暂存上限，请裁剪或压缩后重试。")
    mime = "video/webm" if target.suffix.lower() == ".webm" else "video/mp4"
    suffix = ".webm" if mime == "video/webm" else ".mp4"
    return data, mime, suffix


async def stage_media_to_huanggua(backend, client: httpx.AsyncClient, path: Path, *, kind: str, temp_dir: Path) -> str:
    """Validate and stage a local image or video to https://huanggua.my/v1/media/uploads."""
    from lib.backends.huanggua import cache_uploaded_reference, generated_reference, public_reference, same_origin
    from lib.infra.async_thread import run_sync_transaction

    cached = await asyncio.to_thread(public_reference, path)
    if cached:
        try:
            async with asyncio.timeout(2):
                response = await client.head(cached, timeout=httpx.Timeout(2, connect=2))
                status = response.status_code
                if status in {403, 404, 405}:
                    async with client.stream(
                        "GET", cached, headers={"Range": "bytes=0-31"}, timeout=httpx.Timeout(2, connect=2)
                    ) as available:
                        status = available.status_code
        except (httpx.RequestError, TimeoutError):
            return cached
        if status in {200, 206} or status == 429 or status >= 500:
            return cached
        if kind == "image" and await asyncio.to_thread(generated_reference, path):
            raise ValueError("生成图片的原始 URL 当前不可访问，请恢复链接后重试；本次未提交生成。")
        if status not in {401, 403, 404, 410}:
            raise ValueError(f"参考素材 URL 检查失败（HTTP {status}），本次未提交生成。")

    if kind == "image":
        data, mime = await asyncio.to_thread(prepare_image_bytes_sync, path)
        suffix = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}[mime]
    else:
        data, mime, suffix = await asyncio.to_thread(prepare_video_bytes_sync, path, temp_dir)

    upload_url = backend._base + "/v1/media/uploads"
    response = await client.post(
        upload_url,
        params={"model": backend.model},
        headers=backend.headers(upload_url),
        files={"file": ("reference" + suffix, data, mime)},
        follow_redirects=False,
    )
    if response.status_code == 401:
        raise ValueError("黄瓜 AI API Key 无效或已过期，请重新登录后重试；本次未提交生成。")
    if response.status_code == 403:
        raise ValueError(f"当前账号或模型（{backend.model}）暂未开放该类型的临时素材托管权限；请检查所选模型。")
    if not response.is_success:
        detail = ""
        try:
            detail = response.json().get("error", {}).get("message", "")
        except Exception:
            pass
        raise ValueError(f"黄瓜 AI 临时素材暂存失败（HTTP {response.status_code}{('：' + detail) if detail else ''}），本次未提交生成。")
    result = response.json()
    url = result.get("url", "")
    parsed = urlsplit(url)
    expires_at = result.get("expires_at")
    if (
        not same_origin(url, backend._base)
        or parsed.username
        or parsed.fragment
        or not isinstance(expires_at, (float, int))
        or expires_at <= time.time() + 300
    ):
        raise ValueError("黄瓜 AI 临时素材服务返回了无效地址或过期时间，本次未提交生成。")
    await run_sync_transaction(cache_uploaded_reference, path, url, float(expires_at))
    return url


def _resolve_extra_refs(project: dict, field: str, target_id: str, project_path: Path) -> tuple[list[Path], list[Path]]:
    from lib.infra.path_safety import safe_join
    entry = (project.get(field) or {}).get(target_id) or {}
    images: list[Path] = []
    videos: list[Path] = []
    for rel in entry.get("images") or ():
        if isinstance(rel, str) and rel:
            try:
                candidate = safe_join(project_path, rel)
                if candidate.is_file() and not candidate.is_symlink():
                    images.append(candidate)
            except Exception:
                continue
    for rel in entry.get("videos") or ():
        if isinstance(rel, str) and rel:
            try:
                candidate = safe_join(project_path, rel)
                if candidate.is_file() and not candidate.is_symlink():
                    videos.append(candidate)
            except Exception:
                continue
    return images, videos


async def build_shot_precheck(
    *,
    root: Path,
    project_path: Path,
    project: dict,
    item: dict,
    shot_id: str,
    kind: str,
    target_ratio: str,
    selected_model: str,
) -> dict:
    """Inspect all local reference media for a shot generation and return spec confirmation facts."""
    from lib.infra.path_safety import safe_join
    spec = model_media_spec(root, kind, selected_model)
    extra_images, extra_videos = _resolve_extra_refs(project, SHOT_REFS_FIELD, shot_id, project_path)
    candidates: list[tuple[str, str, Path, str]] = []

    if kind == "image":
        if isinstance(project.get("style_image"), str) and project["style_image"]:
            try:
                candidates.append(("风格参考图", project["style_image"], safe_join(project_path, project["style_image"]), "image"))
            except Exception:
                pass
        for bucket, field_name, sheet_key, label in (
            ("characters", "characters_in_scene", "character_sheet", "角色资产图"),
            ("scenes", "scenes", "scene_sheet", "场景资产图"),
            ("props", "props", "prop_sheet", "道具资产图"),
            ("products", "products", "product_sheet", "商品资产图"),
        ):
            names = item.get(field_name) or []
            if isinstance(names, list):
                for asset_name in names:
                    key = asset_name.get("name") if isinstance(asset_name, dict) else asset_name
                    if not isinstance(key, str):
                        continue
                    base_name, _, deriv_name = key.partition("/")
                    asset = (project.get(bucket) or {}).get(base_name) or {}
                    rel = None
                    if deriv_name and bucket == "characters":
                        rel = f"characters/derivatives/{base_name}/{deriv_name}.png"
                    else:
                        rel = asset.get(sheet_key)
                    if isinstance(rel, str) and rel:
                        try:
                            p = safe_join(project_path, rel)
                            if p.is_file():
                                candidates.append((f"{label}（{key}）", rel, p, "image"))
                        except Exception:
                            pass
        for idx, p in enumerate(extra_images, 1):
            candidates.append((f"镜头本地参考图 #{idx}", p.relative_to(project_path).as_posix(), p, "image"))
    else:
        generated = item.get("generated_assets") or {}
        sb_rel = generated.get("storyboard_image")
        if isinstance(sb_rel, str) and sb_rel:
            try:
                candidates.append(("首帧 / 分镜图", sb_rel, safe_join(project_path, sb_rel), "image"))
            except Exception:
                pass
        end_rel = item.get("end_frame_image") or generated.get("end_frame_image")
        if isinstance(end_rel, str) and end_rel:
            try:
                candidates.append(("尾帧图", end_rel, safe_join(project_path, end_rel), "image"))
            except Exception:
                pass
        for idx, p in enumerate(extra_images, 1):
            candidates.append((f"镜头附加参考图 #{idx}", p.relative_to(project_path).as_posix(), p, "image"))
        for idx, p in enumerate(extra_videos, 1):
            candidates.append((f"镜头本地参考视频 #{idx}", p.relative_to(project_path).as_posix(), p, "video"))

    inspected = []
    blockers: list[str] = []
    warnings: list[str] = []
    for role, rel_name, path, media_kind in candidates:
        try:
            info = await inspect_local_media(path, display_name=rel_name, role=role, expected_kind=media_kind)
        except Exception:
            blockers.append(f"{role}（{rel_name}）文件损坏或无法解析，请重新上传本地文件。")
            continue
        if info.get("missing"):
            blockers.append(f"{role}（{rel_name}）本地文件缺失，请重新上传。")
            continue
        if media_kind == "video" and info["sizeBytes"] > VIDEO_UPLOAD_MAX_BYTES:
            blockers.append(f"{role}（{rel_name}）大小为 {info['sizeBytes'] / (1024 * 1024):.1f} MB，超过黄瓜 AI 64 MB 暂存上限。")
        if kind == "video" and role == "首帧 / 分镜图" and not extra_videos and not extra_images and info.get("width") and info.get("height"):
            rw, rh = map(int, target_ratio.split(":"))
            if info["width"] * rh != info["height"] * rw:
                info["adjustments"].append(f"原图尺寸 {info['width']}×{info['height']} 将在上传前自动补边适配 {target_ratio} 视频画幅（本地分镜原图不变）")
        for adj in info.get("adjustments", ()):
            warnings.append(f"{role}：{adj}")
        inspected.append(info)

    image_items = [x for x in inspected if x["kind"] == "image"]
    video_items = [x for x in inspected if x["kind"] == "video"]
    if kind == "image" and image_items and spec["max_images"] == 0:
        blockers.append(f"当前图片模型 {selected_model} 仅支持文生图，不支持参考图输入；请更换图片模型。")
    if kind == "image" and len(image_items) > spec["max_images"] > 0:
        warnings.append(f"参考图共 {len(image_items)} 张，将按优先级截取模型上限前 {spec['max_images']} 张。")
    if kind == "video":
        if video_items and spec["max_videos"] == 0:
            blockers.append(
                f"当前视频模型 {selected_model} 不支持参考视频输入；请在右侧 Agent 模型设置中切换为 catcode-Seedance-2.0-官转 或 catcode-Seedance-2.5-官转，或移除镜头参考视频。"
            )
        elif len(video_items) > spec["max_videos"]:
            blockers.append(f"当前视频模型 {selected_model} 最多支持 {spec['max_videos']} 段参考视频（当前已选 {len(video_items)} 段）。")
        if (video_items or extra_images) and len(image_items) > spec["max_images"]:
            blockers.append(f"当前视频模型 {selected_model} 最多支持 {spec['max_images']} 张参考图（当前共 {len(image_items)} 张）。")
        if any(x["role"] == "尾帧图" for x in image_items) and (video_items or extra_images):
            warnings.append("已同时设置附加参考素材与尾帧图：多参考模式下首帧将并入参考图列表，尾帧不单独作为帧槽位发送。")

    planned_duration = item.get("duration_seconds") if kind == "video" else None
    request_duration = planned_duration
    if kind == "video" and isinstance(planned_duration, int) and spec["durations"]:
        allowed_durs = sorted(int(d) for d in spec["durations"])
        if planned_duration not in allowed_durs:
            higher = [d for d in allowed_durs if d >= planned_duration]
            request_duration = higher[0] if higher else allowed_durs[-1]
            warnings.append(f"镜头计划时长 {planned_duration}s 不在模型档位内，实际将按 {request_duration}s 档位请求。")

    if inspected:
        warnings.append("确认后将把上述本地参考素材加密暂存至黄瓜 AI 服务器（有效期 48 小时），转为 HTTPS URL 交由上游模型处理；本地记录保持不变。")

    return {
        "allowed": len(blockers) == 0,
        "needsConfirmation": len(inspected) > 0 or len(warnings) > 0,
        "kind": kind,
        "model": selected_model,
        "targetRatio": target_ratio,
        "targetResolution": spec["resolution"],
        "targetPixelSize": target_pixel_size(selected_model, target_ratio, spec["resolution"]) if kind == "image" else None,
        "plannedDuration": planned_duration,
        "requestDuration": request_duration,
        "stagingHost": "https://huanggua.my",
        "ttlHours": 48,
        "references": inspected,
        "blockers": blockers,
        "warnings": warnings,
    }


async def augment_unit_precheck(root: Path, project_path: Path, project: dict, unit_id: str | None, selected_model: str, base_result: dict) -> dict:
    """Attach local unit reference image/video spec checks to reference-video precheck replies."""
    spec = model_media_spec(root, "video", selected_model)
    target_ids = [unit_id] if unit_id else list((project.get(UNIT_REFS_FIELD) or {}).keys())
    inspected = []
    blockers: list[str] = []
    warnings: list[str] = []
    for uid in target_ids:
        if not uid:
            continue
        extra_images, extra_videos = _resolve_extra_refs(project, UNIT_REFS_FIELD, uid, project_path)
        if extra_videos and spec["max_videos"] == 0:
            blockers.append(
                f"单元 {uid} 含有本地参考视频，但当前模型 {selected_model} 不支持参考视频输入；请切换为 catcode-Seedance-2.0-官转 或 catcode-Seedance-2.5-官转。"
            )
        elif len(extra_videos) > spec["max_videos"]:
            blockers.append(f"单元 {uid} 参考视频数量（{len(extra_videos)}）超过模型上限（{spec['max_videos']}）。")
        for idx, p in enumerate(extra_images, 1):
            info = await inspect_local_media(p, display_name=p.relative_to(project_path).as_posix(), role=f"{uid} · 本地参考图 #{idx}", expected_kind="image")
            inspected.append(info)
            for adj in info.get("adjustments", ()):
                warnings.append(f"{info['role']}：{adj}")
        for idx, p in enumerate(extra_videos, 1):
            try:
                info = await inspect_local_media(p, display_name=p.relative_to(project_path).as_posix(), role=f"{uid} · 本地参考视频 #{idx}", expected_kind="video")
            except Exception:
                blockers.append(f"单元 {uid} 的本地参考视频 {p.name} 无法解析，请重新上传。")
                continue
            if info["sizeBytes"] > VIDEO_UPLOAD_MAX_BYTES:
                blockers.append(f"{info['role']} 超过 64 MB 暂存上限。")
            inspected.append(info)
            for adj in info.get("adjustments", ()):
                warnings.append(f"{info['role']}：{adj}")
    warnings.append("确认后将把单元引用的本地资产图与参考视频暂存至黄瓜 AI 服务器（有效期 48 小时），转为 HTTPS URL 发送给上游模型；本地原文件不变。")
    merged = dict(base_result)
    merged["stagingSpec"] = {
        "model": selected_model,
        "targetResolution": spec["resolution"],
        "targetRatio": project.get("aspect_ratio", "9:16"),
        "stagingHost": "https://huanggua.my",
        "ttlHours": 48,
        "references": inspected,
        "blockers": blockers,
        "warnings": warnings,
    }
    if blockers:
        merged["rejected"] = True
        merged["decision"] = "blocked"
        merged["diagnostic"] = blockers
    return merged


def install_huanggua_staging(root: Path) -> None:
    """Install URL staging for HuangguaImageBackend and video+image reference staging for HuangguaVideoBackend."""
    import base64
    from urllib.parse import urljoin
    from lib.backends.huanggua import (
        IMAGE_ARTIFACT_MAX_BYTES,
        ArtifactDownloadError,
        HuangguaImageBackend,
        HuangguaVideoBackend,
        await_confirmation,
        per_image_usage,
        read_submission,
        save_image,
        validate_image,
    )
    from lib.backends.image_backends.base import ImageGenerationResult, ReferenceImage
    from lib.infra.async_thread import run_noninterruptible_sync
    from lib.project.project_manager import get_project_manager
    from shot_media import RATIOS, prepare_video_frame

    if getattr(HuangguaImageBackend, "_huanggua_url_staging", False):
        return

    async def staged_image_generate(self: HuangguaImageBackend, request):
        spec = model_media_spec(root, "image", self.model)
        limit = await self.reference_image_limit()
        refs = list(request.reference_images or [])
        task_ctx = CURRENT_TASK.get()
        if task_ctx and task_ctx.get("task_type") == "storyboard" and task_ctx.get("project_name") and task_ctx.get("resource_id"):
            try:
                pm = get_project_manager()
                proj = await asyncio.to_thread(pm.load_project, task_ctx["project_name"])
                proj_path = await asyncio.to_thread(pm.get_project_path, task_ctx["project_name"])
                extra_imgs, _ = _resolve_extra_refs(proj, SHOT_REFS_FIELD, str(task_ctx["resource_id"]), proj_path)
                existing_paths = {str(Path(r.path).resolve()) for r in refs}
                for p in extra_imgs:
                    if str(p.resolve()) not in existing_paths:
                        refs.append(ReferenceImage(path=str(p)))
            except Exception:
                pass
        if limit and len(refs) > limit:
            refs = refs[:limit]
        resolution = request.image_size if request.image_size in ("1K", "2K", "4K") else spec["resolution"]
        if spec["resolution"] in ("2K", "4K") and request.image_size in (None, "1K") and spec["resolution"] != "1K":
            resolution = spec["resolution"]
        fields = {
            "model": self.model,
            "prompt": request.prompt,
            "n": 1,
            "resolution": resolution,
            "aspect_ratio": request.aspect_ratio,
            "quality": "auto",
            "response_format": "url",
        }
        journal = await asyncio.to_thread(read_submission, request.task_id)
        async with self.client() as client:
            if journal is not None:
                body = await self.submissions.resume(
                    client, request.task_id, journal["key"], request.on_provider_response
                )
            elif refs:
                with tempfile.TemporaryDirectory(prefix="hg-img-stage-") as tmp:
                    tmp_path = Path(tmp)
                    try:
                        urls = []
                        for ref in refs:
                            urls.append(
                                await stage_media_to_huanggua(
                                    self, client, Path(ref.path), kind="image", temp_dir=tmp_path
                                )
                            )
                        body = await self.json_request(
                            client,
                            "POST",
                            self._base + "/v1/images/generations",
                            json={**fields, "images": urls},
                            on_pending=request.on_provider_response,
                            submission_request=request,
                        )
                    except ValueError as staging_err:
                        # Seamless fallback to multipart /v1/images/edits only if server has not yet enabled image model URL staging and payload <= 8 MiB.
                        if "暂未开放" not in str(staging_err):
                            raise
                        files = []
                        total = 0
                        for ref in refs:
                            p = Path(ref.path)
                            data, mime = await asyncio.to_thread(prepare_image_bytes_sync, p)
                            total += len(data)
                            files.append(("image", (p.name, data, mime)))
                        if total > 8 * 1024 * 1024:
                            raise
                        body = await self.json_request(
                            client,
                            "POST",
                            self._base + "/v1/images/edits",
                            data={k: str(v) for k, v in fields.items()},
                            files=files,
                            on_pending=request.on_provider_response,
                            submission_request=request,
                        )
            else:
                body = await self.json_request(
                    client,
                    "POST",
                    self._base + "/v1/images/generations",
                    json=fields,
                    on_pending=request.on_provider_response,
                    submission_request=request,
                )

            if request.on_provider_response:
                await request.on_provider_response("submit", body)
            items = body.get("data")
            item = items[0] if isinstance(items, list) and items else None
            if not isinstance(item, dict) or not any(
                isinstance(item.get(key), str) and item[key] for key in ("url", "b64_json")
            ):
                await await_confirmation(request.on_provider_response, reason="图片响应缺少可用产物")
                raise AssertionError("pending submission cannot return")

            async def receive_item(result_item):
                raw_url = result_item.get("url")
                result_url = urljoin(self._base + "/", raw_url) if isinstance(raw_url, str) and raw_url else None
                if request.on_provider_response:
                    await request.on_provider_response("result", {**body, "status": "downloading"})
                if result_item.get("b64_json"):
                    try:
                        data = await asyncio.to_thread(base64.b64decode, result_item["b64_json"], validate=True)
                        if len(data) > IMAGE_ARTIFACT_MAX_BYTES:
                            raise ValueError("Image response exceeds size limit")
                        await asyncio.to_thread(validate_image, data)
                    except (ValueError, OSError, SyntaxError):
                        raise ArtifactDownloadError(detail="图片内容无效，请取回原结果，勿重复生成。") from None
                    return data, result_url
                if result_url:
                    return await self.download_artifact(result_url, task_id=request.task_id), result_url
                raise ArtifactDownloadError(detail="原任务响应缺少图片，请取回原结果，勿重复生成。")

            try:
                data, url = await receive_item(item)
            except ArtifactDownloadError:
                if not request.task_id or not await asyncio.to_thread(read_submission, request.task_id):
                    raise
                body = await self.submissions.refresh(client, request.task_id, request.on_provider_response)
                items = body.get("data")
                refreshed = items[0] if isinstance(items, list) and items else None
                if not isinstance(refreshed, dict):
                    raise ArtifactDownloadError(detail="原任务图片暂不可用，请稍后取回原结果。") from None
                data, url = await receive_item(refreshed)
        await run_noninterruptible_sync(save_image, data, request.output_path, url)
        return ImageGenerationResult(
            image_path=request.output_path,
            provider=self.name,
            model=self.model,
            image_uri=url,
            usage=per_image_usage(
                output_images=1,
                input_images=len(refs),
                dimensions={"resolution": fields["resolution"], "quality": "auto"},
            ),
        )

    async def staged_video_payload(self: HuangguaVideoBackend, request):
        if request.reference_audio_files:
            raise ValueError("Reference audio uploads are not implemented by this Huanggua channel")
        spec = model_media_spec(root, "video", self.model)
        extra_images: list[Path] = []
        extra_videos: list[Path] = []
        task_ctx = CURRENT_TASK.get()
        project_name = request.project_name or (task_ctx.get("project_name") if task_ctx else None)
        resource_id = str(task_ctx["resource_id"]) if task_ctx and task_ctx.get("resource_id") else None
        if project_name and resource_id:
            try:
                pm = get_project_manager()
                proj = await asyncio.to_thread(pm.load_project, project_name)
                proj_path = await asyncio.to_thread(pm.get_project_path, project_name)
                field = UNIT_REFS_FIELD if proj.get("generation_mode") == "reference_video" else SHOT_REFS_FIELD
                extra_images, extra_videos = _resolve_extra_refs(proj, field, resource_id, proj_path)
            except Exception:
                pass

        body: dict = {
            "model": self.model,
            "prompt": request.prompt,
            "seconds": request.duration_seconds,
            "aspect_ratio": request.aspect_ratio,
        }
        if request.resolution:
            body["resolution"] = request.resolution

        refs = [Path(p) for p in (request.reference_images or [])]
        if extra_images:
            seen = {str(p.resolve()) for p in refs}
            for p in extra_images:
                if str(p.resolve()) not in seen:
                    refs.append(p)
                    seen.add(str(p.resolve()))

        multi_ref_mode = bool(refs or extra_videos)
        if multi_ref_mode and request.start_image:
            start_p = Path(request.start_image)
            if str(start_p.resolve()) not in {str(p.resolve()) for p in refs}:
                refs.insert(0, start_p)

        if not multi_ref_mode and request.end_image and not request.start_image:
            raise ValueError("An end frame requires a first frame")
        if multi_ref_mode and len(refs) > max(spec["max_images"], 1):
            raise ValueError(f"当前视频模型最多支持 {spec['max_images']} 张参考图")
        if extra_videos and spec["max_videos"] <= 0:
            raise ValueError(f"当前视频模型（{self.model}）不支持参考视频输入，请切换为 Seedance 2.0 / 2.5 系列模型")
        if len(extra_videos) > spec["max_videos"] > 0:
            raise ValueError(f"当前视频模型最多支持 {spec['max_videos']} 段参考视频")

        with tempfile.TemporaryDirectory(prefix="hg-vid-stage-") as directory:
            tmp_dir = Path(directory)
            effective_req = request
            if not multi_ref_mode and request.aspect_ratio in RATIOS and request.start_image:
                padded = {}
                for fname in ("start_image", "end_image"):
                    src = getattr(request, fname)
                    if src:
                        padded[fname] = await asyncio.to_thread(
                            prepare_video_frame, src, tmp_dir / f"{fname}.png", request.aspect_ratio
                        )
                effective_req = replace(request, **padded)

            image_paths = (
                refs
                if multi_ref_mode
                else ([Path(effective_req.start_image)] if effective_req.start_image else [])
                + ([Path(effective_req.end_image)] if effective_req.end_image else [])
            )

            if image_paths or extra_videos:
                async with self.client() as client:
                    sem = asyncio.Semaphore(3)

                    async def stage_one(path: Path, media_kind: str) -> str:
                        async with sem:
                            return await stage_media_to_huanggua(
                                self, client, path, kind=media_kind, temp_dir=tmp_dir
                            )

                    img_urls = await asyncio.gather(*(stage_one(p, "image") for p in image_paths))
                    vid_urls = await asyncio.gather(*(stage_one(p, "video") for p in extra_videos))

                if multi_ref_mode:
                    if img_urls:
                        body["images"] = list(img_urls)
                    if vid_urls:
                        body["videos"] = list(vid_urls)
                        body["video_mode"] = "generate"
                elif self.model.startswith("grsai-minimax-h3-") and not effective_req.end_image:
                    # Minimax H3 requires both frames in frame mode; single frame uses images[].
                    body["images"] = [img_urls[0]]
                else:
                    body["first_frame"] = img_urls[0]
                    body["video_mode"] = "frames"
                    if effective_req.end_image:
                        body["end_frame"] = img_urls[1]
        return body

    HuangguaImageBackend.generate = staged_image_generate
    HuangguaImageBackend._huanggua_url_staging = True
    HuangguaVideoBackend.payload = staged_video_payload
    HuangguaVideoBackend._huanggua_url_staging = True


def wrap_task_executor(executor):
    """Bind task metadata to CURRENT_TASK so backend hooks resolve local shot/unit references."""
    async def wrapped(task: dict, **kwargs):
        token = CURRENT_TASK.set(task)
        try:
            return await executor(task, **kwargs)
        finally:
            CURRENT_TASK.reset(token)

    return wrapped
