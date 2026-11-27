"""Video model facts published to the logged-in desktop device by Huanggua."""
from __future__ import annotations

from dataclasses import replace
from urllib.parse import quote, urljoin, urlsplit

import httpx

ORIGIN = "https://huanggua.my"
# Replaced together on every authenticated account refresh. Never contains a key.
catalog: dict[str, dict] = {}


def entry(row):
    model = row["id"]
    name = row.get("display_name")
    name = name.strip()[:300] if isinstance(name, str) and name.strip() else model
    item = {"id": model, "display_name": name, "spec_status": "unknown",
            "seconds_by_resolution": {}, "default_resolution": None}
    by_size = row.get("seconds_by_resolution")
    preferred = row.get("default_resolution")
    if (row.get("spec_status") != "available" or not isinstance(by_size, dict)
            or not isinstance(preferred, str) or preferred not in by_size or len(by_size) > 100):
        return item
    tiers = {}
    for size, seconds in by_size.items():
        if (not isinstance(size, str) or not 0 < len(size) <= 32 or not isinstance(seconds, list)
                or not 0 < len(seconds) <= 1000 or any(type(s) is not int or s <= 0 for s in seconds)):
            return item
        tiers[size] = sorted(set(seconds))
    return {**item, "spec_status": "available", "default_resolution": preferred, "seconds_by_resolution": tiers}


async def fetch(remote, service, selected=None):
    """Intersect account IDs with the authorized list. Plain OpenAI records use existing presets."""
    allowed = service["models"]
    headers = {"Authorization": "Bearer " + service["api_key"]}
    result = {}
    try:
        response = await remote.get(ORIGIN + "/v1/models", params={"kind": "video"}, headers=headers)
        response.raise_for_status()
        rows = response.json()["data"]
        if not isinstance(rows, list):
            raise ValueError("invalid catalog")
        index = {row["id"]: row for row in rows if isinstance(row, dict) and isinstance(row.get("id"), str)}
    except (httpx.HTTPError, KeyError, TypeError, ValueError):
        return {model: entry({"id": model}) for model in allowed}
    for model in allowed:
        row = index.get(model)
        if row is None:
            continue
        if row.get("kind") == "video" or "spec_status" in row:
            if selected == model:
                list_row = row
                try:
                    detail = await remote.get(ORIGIN + "/v1/models/" + quote(model, safe=""), headers=headers)
                    if detail.status_code == 404:
                        continue
                    detail.raise_for_status()
                    row = detail.json()
                    if not isinstance(row, dict) or row.get("id") != model or row.get("kind") != "video":
                        raise ValueError("invalid video detail")
                except (httpx.HTTPError, TypeError, ValueError):
                    row = {"id": model, "display_name": list_row.get("display_name")}
            result[model] = entry(row)
        else:
            result[model] = {"id": model, "spec_status": "legacy", "display_name": model}
    return result


def provider_rows(presets, allowed, entries):
    existing = {m["model_id"]: m for m in presets if m["endpoint"] == "huanggua-video"}
    result = []
    for model in allowed:
        spec = entries.get(model)
        if not spec:
            continue
        old = existing.get(model, {})
        if spec["spec_status"] == "legacy":
            if old:
                result.append(dict(old))
            continue
        if spec["spec_status"] != "available":
            continue
        tiers = spec["seconds_by_resolution"]
        capabilities = {"first_frame": True, "max_reference_images": 9, **old.get("capability_overrides", {}),
                        "durations": sorted({d for seconds in tiers.values() for d in seconds}),
                        "resolutions": list(tiers), "duration_constraints": {"by_resolution": tiers}}
        result.append({**old, "model_id": model, "display_name": spec["display_name"], "endpoint": "huanggua-video",
                       "resolution": spec["default_resolution"], "capability_overrides": capabilities})
    return result


def describe_legacy(specs, presets):
    for row in presets:
        model = row["model_id"]
        if row.get("endpoint") != "huanggua-video" or specs.get(model, {}).get("spec_status") != "legacy":
            continue
        opts = row.get("capability_overrides", {})
        size = row.get("resolution")
        if size:
            specs[model] = {**specs[model], "default_resolution": size,
                            "seconds_by_resolution": {r: opts.get("durations", []) for r in opts.get("resolutions", [size])}}


def resolution(spec, lock=None):
    if not spec or spec.get("spec_status") != "available":
        raise ValueError("studio_video_specs_unavailable")
    size = lock or spec["default_resolution"]
    if not isinstance(size, str) or size not in spec["seconds_by_resolution"]:
        raise ValueError("studio_video_resolution_conflict")
    return size


def require_seconds(spec, size, seconds):
    if type(seconds) is not int or seconds not in spec["seconds_by_resolution"].get(size, ()):
        raise ValueError("studio_video_duration_conflict")


async def freeze_task(project_name, task_type, script_file, resource_id, payload):
    """The accepted episode selection travels with a queued task across app restarts."""
    planning = task_type in ('text_drama_script_plan', 'text_narration_script_plan', 'text_reference_script_plan')
    if not planning and task_type not in ('video', 'reference_video'):
        return payload
    import asyncio
    from lib.project.project_manager import get_project_manager
    from shot_media import shot_ratio
    from lib.artifacts.video_visual_provenance import resolve_video_aspect_ratio
    pm = get_project_manager()
    project = await asyncio.to_thread(pm.load_project, project_name)
    episode_number = (payload or {}).get('episode')
    if not planning:
        script = (script_file or (payload or {}).get('script_file') or '').removeprefix('scripts/')
        episode_number = next((e.get('episode') for e in project.get('episodes', []) if script
                               and (e.get('script_file') or '').removeprefix('scripts/') == script), None)
    spec = project.get('desktop_episode_video', {}).get(str(episode_number))
    if not spec or not spec.get('managed'):
        return payload
    frozen = dict(spec)
    if not planning:
        frozen['ratio'] = (shot_ratio(project, resource_id, 'video') if task_type == 'video'
                           else resolve_video_aspect_ratio(project, 'reference_videos'))
    return {**(payload or {}), 'desktop_video': frozen}


def install_task_selection():
    from lib.project.project_manager import ProjectManager
    from media_staging import CURRENT_TASK
    original = ProjectManager.load_project

    def load_project(manager, name):
        project = original(manager, name)
        task = CURRENT_TASK.get() or {}
        frozen = (task.get('payload') or {}).get('desktop_video')
        if frozen and task.get('project_name') == name:
            ref = frozen['ref']
            project.update(video_backend=ref, video_provider_i2v=ref, video_provider_r2v=ref)
            project.setdefault('model_settings', {}).setdefault(ref, {})['resolution'] = frozen['resolution']
            if task.get('task_type') == 'reference_video':
                project['aspect_ratio'] = frozen['ratio']
            elif task.get('task_type') == 'video' and task.get('resource_id'):
                from shot_media import FIELD
                project.setdefault(FIELD, {}).setdefault(task['resource_id'], {})['video'] = frozen['ratio']
        return project

    ProjectManager.load_project = load_project


async def validate_wire(backend, request, frozen):
    model = backend.model
    if not frozen and catalog.get(model, {}).get('spec_status') in (None, 'legacy'):
        return
    async with backend.client() as client:
        url = backend._base + '/v1/models/' + quote(model, safe='')
        try:
            response = await client.get(url, headers=backend.headers(url), follow_redirects=False)
            response.raise_for_status()
            row = response.json()
        except (httpx.HTTPError, ValueError):
            raise ValueError('studio_video_specs_unavailable') from None
    if not isinstance(row, dict) or row.get('kind') != 'video' or row.get('id') != model:
        raise ValueError('studio_video_specs_unavailable')
    spec = entry(row)
    size = resolution(spec, request.resolution)
    if not request.resolution or (frozen and (frozen['ref'].partition('/')[2] != model or frozen['resolution'] != size)):
        raise ValueError('studio_video_resolution_conflict')
    if frozen and request.aspect_ratio != frozen['ratio']:
        raise ValueError('studio_video_ratio_conflict')
    require_seconds(spec, size, request.duration_seconds)


def video_collection(model, task_id):
    # The original receipt determines how to resume even after withdrawal or a new login.
    from lib.backends.huanggua_submission import read_submission
    receipt = read_submission(task_id)
    if receipt and receipt.get("path") in ("/v1/videos", "/v2/videos"):
        return receipt["path"]
    from media_staging import CURRENT_TASK
    frozen = ((CURRENT_TASK.get() or {}).get('payload') or {}).get('desktop_video')
    return "/v1/videos" if frozen or catalog.get(model, {}).get("spec_status") == "available" else "/v2/videos"


def download_location(job_url, status):
    original = job_url + "/content"
    if "/v1/videos/" not in urlsplit(job_url).path:
        return original
    location = status.get("download_url")
    if not location:
        return original
    url = urlsplit(urljoin(job_url, location))
    expected = urlsplit(original)
    if (url.scheme, url.netloc, url.path) != (expected.scheme, expected.netloc, expected.path) or url.fragment:
        raise ValueError("studio_invalid_video_download")
    return url.geturl()


def export_profile(profile, project):
    from shot_media import CUSTOM_RESOLUTION_FIELD, parse_custom_resolution
    dimensions = parse_custom_resolution(project.get(CUSTOM_RESOLUTION_FIELD))
    return replace(profile, width=dimensions[0], height=dimensions[1]) if dimensions else profile
