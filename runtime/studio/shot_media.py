"""Desktop shot ratios, custom resolutions, and manual generation using the engine's formal queue.

Three guarded source overlays extend ratio resolution at generation and currency
boundaries. Upstream files remain intact; incompatible engine updates fail closed.
"""
import importlib.abc
import importlib.util
import math
from pathlib import Path
import re
import sys

RATIOS = ('9:16', '16:9', '4:3', '3:4', '1:1')
FIELD = 'desktop_shot_ratios'
CUSTOM_RESOLUTION_FIELD = 'desktop_custom_resolution'

GRSAI_IMAGE_RATIOS = ('1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '21:9')
CATCODE_IMAGE_RATIOS = ('16:9', '9:16', '4:3', '3:4', '1:1')

_RATIO_RE = re.compile(r'^(\d{1,5}):(\d{1,5})$')
_CUSTOM_RES_RE = re.compile(r'^(\d{2,5})x(\d{2,5})$', re.IGNORECASE)


def parse_ratio_pair(value: object) -> tuple[int, int] | None:
    if not isinstance(value, str):
        return None
    match = _RATIO_RE.fullmatch(value.strip())
    if not match:
        return None
    w, h = int(match.group(1)), int(match.group(2))
    if not (1 <= w <= 8192 and 1 <= h <= 8192):
        return None
    ratio = w / h
    if ratio < 0.125 or ratio > 8.0:
        return None
    return w, h


def is_valid_studio_ratio(value: object) -> bool:
    return parse_ratio_pair(value) is not None


def normalize_custom_resolution(value: object) -> str | None:
    if value is None or value == '':
        return None
    if not isinstance(value, str):
        raise ValueError('studio_invalid_ratio')
    match = _CUSTOM_RES_RE.fullmatch(value.strip())
    if not match:
        raise ValueError('studio_invalid_ratio')
    w, h = int(match.group(1)), int(match.group(2))
    if not (64 <= w <= 7680 and 64 <= h <= 7680):
        raise ValueError('studio_invalid_ratio')
    ratio = w / h
    if ratio < 0.125 or ratio > 8.0:
        raise ValueError('studio_invalid_ratio')
    even_w = min(7680, max(64, ((w + 1) // 2) * 2))
    even_h = min(7680, max(64, ((h + 1) // 2) * 2))
    return f'{even_w}x{even_h}'


def parse_custom_resolution(value: object) -> tuple[int, int] | None:
    if not isinstance(value, str):
        return None
    match = _CUSTOM_RES_RE.fullmatch(value.strip())
    if not match:
        return None
    w, h = int(match.group(1)), int(match.group(2))
    if not (64 <= w <= 7680 and 64 <= h <= 7680):
        return None
    return w, h


def closest_supported_ratio(requested: str, allowed: tuple[str, ...]) -> str:
    if requested in allowed:
        return requested
    parsed = parse_ratio_pair(requested)
    if not parsed:
        return '9:16' if '9:16' in allowed else allowed[0]
    target = parsed[0] / parsed[1]

    def _dist(candidate: str) -> float:
        cp = parse_ratio_pair(candidate)
        if not cp:
            return 999.0
        return abs(math.log(target / (cp[0] / cp[1])))

    return min(allowed, key=_dist)


def allowed_image_ratios_for_model(model_id: str) -> tuple[str, ...]:
    if model_id.startswith('grsai-'):
        return GRSAI_IMAGE_RATIOS
    if model_id.startswith('catcode-image-'):
        return CATCODE_IMAGE_RATIOS
    return GRSAI_IMAGE_RATIOS


def allowed_video_ratios_for_model(model_id: str) -> tuple[str, ...]:
    if not model_id:
        return ('16:9', '9:16', '21:9', '4:3', '1:1', '3:4')
    if model_id.startswith('grsai-minimax-h3'):
        return ('16:9', '9:16')
    if model_id == 'catcode-9图系列-sd2.0-903':
        return ('16:9', '9:16', '4:3', '1:1', '3:4')
    if model_id.startswith(('catcode-Seedance-', 'grsai-agnes-', 'grsai-wan-')) or model_id == 'catcode-sd2.0-mini':
        return ('16:9', '9:16', '21:9', '4:3', '1:1', '3:4')
    if model_id.startswith('catcode-'):
        return ('16:9', '9:16', '21:9', '4:3', '3:4')
    return ('16:9', '9:16', '21:9', '4:3', '1:1', '3:4')


def shot_ratio(project, resource_id, kind):
    from lib.artifacts.video_visual_provenance import resolve_video_aspect_ratio
    value = project.get(FIELD, {}).get(resource_id, {}).get(kind)
    if is_valid_studio_ratio(value):
        return value
    return resolve_video_aspect_ratio(project, 'storyboards' if kind == 'image' else 'videos')


OVERLAYS = {
    'lib.artifacts.generation_input': (
        'canvas_ratio = resolve_video_aspect_ratio(project, "storyboards")',
        'canvas_ratio = shot_ratio(project, resource_id, "image")'),
    'lib.artifacts.media_artifact_currency': (
        'aspect_ratio=resolve_video_aspect_ratio(project),\n        absent=gaps,',
        'aspect_ratio=shot_ratio(project, resource_id, "video"),\n        absent=gaps,'),
    'server.services.tasks.generation_tasks': (
        'aspect_ratio = get_aspect_ratio(project, "videos")',
        'aspect_ratio = shot_ratio(project, resource_id, "video")'),
}


class _Overlay(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def __init__(self, root):
        self.sources = {}
        replacements = {name: [pair] for name, pair in OVERLAYS.items()}
        replacements.update({
            'lib.backends.huanggua': [
                ('self._base + "/v2/videos",', 'self._base + video_specs.video_collection(self.model, request.task_id),'),
                ('base + "/v2/videos/" + quote(job_id, safe="")', 'base + video_specs.video_collection(self.model, request.task_id) + "/" + quote(job_id, safe="")'),
                ('content_url = job_url + "/content"', 'content_url = video_specs.download_location(job_url, body)'),
            ],
            'lib.final_cut.basis': [
                ('return output_profile_for_aspect_ratio(resolve_video_aspect_ratio(project, video_resource_type_for(script_kind)))',
                 'return video_specs.export_profile(output_profile_for_aspect_ratio(resolve_video_aspect_ratio(project, video_resource_type_for(script_kind))), project)'),
            ],
            'lib.generation.generation_queue': [
                # Reattaching to an accepted text task compares the caller's own prompt inputs.
                ('_LEGACY_TEXT_PAYLOAD_KEYS = frozenset({"projects_root"})',
                 '_LEGACY_TEXT_PAYLOAD_KEYS = frozenset({"projects_root", "desktop_video"})'),
                ('        requested_facts = _reference_request_facts(task_type, payload)',
                 '        payload = await video_specs.freeze_task(project_name, task_type, script_file, resource_id, payload)\n'
                 '        requested_facts = _reference_request_facts(task_type, payload)'),
            ],
        })
        for name, pairs in replacements.items():
            path = root.joinpath(*name.split('.')).with_suffix('.py')
            if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
                raise ValueError('studio_invalid_engine')
            source = path.read_text(encoding='utf-8')
            future = 'from __future__ import annotations'
            if source.count(future) != 1 or name in sys.modules:
                raise ValueError('studio_media_extension_incompatible')
            for old, new in pairs:
                if source.count(old) != 1:
                    raise ValueError('studio_media_extension_incompatible')
                source = source.replace(old, new)
            source = source.replace(future, future + '\nfrom shot_media import shot_ratio\nimport video_specs')
            self.sources[name] = (path, compile(source, str(path), 'exec'))

    def find_spec(self, fullname, path=None, target=None):
        if fullname in self.sources:
            return importlib.util.spec_from_file_location(fullname, self.sources[fullname][0], loader=self)

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        exec(self.sources[module.__name__][1], module.__dict__)


def install_ratio_support(root: Path):
    sys.meta_path.insert(0, _Overlay(root))


def prepare_video_frame(source, output, ratio):
    """Preserve the whole frame; pad a temporary copy to the requested canvas."""
    from PIL import Image, ImageOps
    parsed = parse_ratio_pair(ratio)
    if not parsed:
        return source
    width, height = parsed
    with Image.open(source) as original:
        frame = ImageOps.exif_transpose(original).convert('RGB')
        if frame.width * height == frame.height * width:
            return source
        scale = 1024.0 / max(width, height)
        size = (max(2, round(width * scale / 2) * 2), max(2, round(height * scale / 2) * 2))
        # Neutral padding sampled from the corner avoids stretching/cropping.
        canvas = Image.new('RGB', size, frame.getpixel((0, 0)))
        fitted = ImageOps.contain(frame, size)
        canvas.paste(fitted, ((size[0] - fitted.width) // 2, (size[1] - fitted.height) // 2))
        canvas.save(output, format='PNG')
        return output


def _conform_output_image_sync(output_path: Path, target_ratio: str, target_pixels: tuple[int, int] | None) -> None:
    from PIL import Image, ImageOps
    parsed = parse_ratio_pair(target_ratio)
    if not parsed and not target_pixels:
        return
    with Image.open(output_path) as raw:
        img = ImageOps.exif_transpose(raw)
        w, h = img.size
        changed = False
        if parsed:
            target = parsed[0] / parsed[1]
            current = w / h if h else target
            if abs(current - target) > 0.015:
                if current > target:
                    new_w = max(2, int(round(h * target)))
                    left = (w - new_w) // 2
                    img = img.crop((left, 0, left + new_w, h))
                else:
                    new_h = max(2, int(round(w / target)))
                    top = (h - new_h) // 2
                    img = img.crop((0, top, w, top + new_h))
                changed = True
        if target_pixels and img.size != target_pixels:
            img = img.resize(target_pixels, Image.Resampling.LANCZOS)
            changed = True
        if changed:
            tmp = output_path.with_suffix(output_path.suffix + '.tmp')
            img.save(tmp, format='PNG')
            tmp.replace(output_path)


def install_frame_ratios():
    """Adapt custom/4:3/3:4 aspect ratios & custom resolutions for upstream image/video backends."""
    import asyncio
    from dataclasses import replace
    import tempfile
    from lib.backends.huanggua import HuangguaImageBackend, HuangguaVideoBackend

    if not getattr(HuangguaImageBackend, '_desktop_image_ratios', False):
        orig_img_generate = HuangguaImageBackend.generate

        async def _img_generate(self, request):
            model_id = getattr(self, 'model', '') or ''
            allowed = allowed_image_ratios_for_model(model_id)
            upstream_ratio = closest_supported_ratio(request.aspect_ratio, allowed)
            effective_req = replace(request, aspect_ratio=upstream_ratio) if upstream_ratio != request.aspect_ratio else request
            result = await orig_img_generate(self, effective_req)

            custom_pixels = None
            try:
                from media_staging import CURRENT_TASK
                task = CURRENT_TASK.get()
                if task and task.get('project_name'):
                    from lib.project.project_manager import get_project_manager
                    proj = await asyncio.to_thread(get_project_manager().load_project, task['project_name'])
                    if request.aspect_ratio == proj.get('aspect_ratio'):
                        custom_pixels = parse_custom_resolution(proj.get(CUSTOM_RESOLUTION_FIELD))
            except Exception:
                custom_pixels = None

            if upstream_ratio != request.aspect_ratio or custom_pixels is not None:
                await asyncio.to_thread(_conform_output_image_sync, Path(request.output_path), request.aspect_ratio, custom_pixels)
            return result

        HuangguaImageBackend.generate = _img_generate
        HuangguaImageBackend._desktop_image_ratios = True

    if getattr(HuangguaVideoBackend, '_desktop_frame_ratios', False):
        return
    original = HuangguaVideoBackend.payload

    async def payload(self, request):
        model_id = getattr(self, 'model', '') or ''
        allowed = allowed_video_ratios_for_model(model_id)
        upstream_ratio = closest_supported_ratio(request.aspect_ratio, allowed)
        if upstream_ratio != request.aspect_ratio:
            request = replace(request, aspect_ratio=upstream_ratio)
        if not is_valid_studio_ratio(request.aspect_ratio) or not request.start_image or request.reference_images:
            return await original(self, request)
        with tempfile.TemporaryDirectory(prefix='hg-frame-') as directory:
            paths = {}
            for field in ('start_image', 'end_image'):
                source = getattr(request, field)
                if source:
                    paths[field] = await asyncio.to_thread(prepare_video_frame, source, Path(directory) / f'{field}.png', request.aspect_ratio)
            return await original(self, replace(request, **paths))

    HuangguaVideoBackend.payload = payload
    HuangguaVideoBackend._desktop_frame_ratios = True


async def shot_operation(name, body, client, checked):
    from lib.project.project_manager import get_project_manager
    from lib.script.storyboard_sequence import get_storyboard_items, find_storyboard_item
    from lib.infra.async_thread import run_sync_transaction
    from workspace_api import segment, diagnostic_request
    episode, target = body['_episode'], body.get('id')
    segment(target)
    base = f'projects/{name}'
    detail = await checked(client, 'GET', base)
    project = detail['project']
    if project.get('generation_mode') == 'reference_video':
        raise ValueError('studio_shot_mode_required')
    current = next((e for e in project.get('episodes', []) if e['episode'] == episode), {})
    script_file = current.get('script_file', '').removeprefix('scripts/')
    if not script_file:
        raise ValueError('studio_script_required')
    pm = get_project_manager()
    script = await run_sync_transaction(lambda: pm.load_script(name, script_file))
    items, id_field, *_ = get_storyboard_items(script)
    resolved = find_storyboard_item(items, id_field, target)
    if not resolved:
        raise ValueError('studio_invalid_request')
    item = resolved[0]
    action, data = body['action'], body.get('data', {})
    if action == 'shot_settings':
        from lib.artifacts.video_visual_provenance import resolve_video_aspect_ratio
        tasks = await checked(client, 'GET', f'{base}/tasks?task_type=video&page_size=500')
        latest = next((t for t in tasks.get('items', []) if t.get('resource_id') == target), {})
        recoverable = latest.get('task_id') if latest.get('status') == 'failed' and latest.get('error_code') == 'artifact_download_failed' else None
        project_ratio = project.get('aspect_ratio', '9:16')
        available_ratios = list(RATIOS)
        if isinstance(project_ratio, str) and is_valid_studio_ratio(project_ratio) and project_ratio not in available_ratios:
            available_ratios.append(project_ratio)
        return {'overrides': project.get(FIELD, {}).get(target, {}),
                'references': project.get('desktop_shot_references', {}).get(target, {'images': [], 'videos': []}),
                'recoverableVideoTask': recoverable,
                'ratios': available_ratios, 'projectRatio': project_ratio,
                'customResolution': project.get(CUSTOM_RESOLUTION_FIELD),
                'defaults': {kind: resolve_video_aspect_ratio(project, bucket) for kind, bucket in (('image', 'storyboards'), ('video', 'videos'))},
                'effective': {kind: shot_ratio(project, target, kind) for kind in ('image', 'video')}}
    kind = data.get('kind')
    if kind not in ('image', 'video'):
        raise ValueError('studio_invalid_request')
    if action == 'shot_precheck':
        from media_staging import build_shot_precheck
        prompt = item.get('image_prompt' if kind == 'image' else 'video_prompt')
        if not prompt:
            raise ValueError('studio_prompt_required')
        configured_ref = (project.get('default_image_backend') if kind == 'image'
                          else project.get('video_provider_i2v') or project.get('video_backend')) or ''
        fallback_model = configured_ref.split('/', 1)[1] if '/' in configured_ref else configured_ref
        selected_model = (body.get('models') or {}).get(kind) or fallback_model
        project_path = await run_sync_transaction(lambda: pm.get_project_path(name))
        return await build_shot_precheck(
            root=Path.cwd(),
            project_path=project_path,
            project=project,
            item=item,
            shot_id=target,
            kind=kind,
            target_ratio=shot_ratio(project, target, kind),
            selected_model=selected_model,
        )
    task_type = 'storyboard' if kind == 'image' else 'video'
    for status in ('queued', 'running'):
        tasks = await checked(client, 'GET', f'{base}/tasks?status={status}&page_size=500')
        if any(t.get('resource_id') == target and t.get('task_type') in ('storyboard', 'video') for t in tasks.get('items', [])):
            raise ValueError('studio_shot_busy')
    if action == 'shot_ratio':
        ratio = data.get('ratio')
        if ratio is not None and not is_valid_studio_ratio(ratio):
            raise ValueError('studio_invalid_ratio')
        def save(p):
            settings = p.setdefault(FIELD, {}).setdefault(target, {})
            if ratio is None:
                settings.pop(kind, None)
            else:
                settings[kind] = ratio
        await run_sync_transaction(lambda: pm.update_project(name, save))
        return {'ok': True}
    if action == 'shot_recover':
        task_id = segment(data.get('taskId'))
        task = (await checked(client, 'GET', f'tasks/{task_id}'))['task']
        if kind != 'video' or task.get('project_name') != name or task.get('resource_id') != target or task.get('script_file', '').removeprefix('scripts/') != script_file:
            raise ValueError('studio_invalid_task')
        result = await diagnostic_request(client, 'POST', f'tasks/{task_id}/retry-download', {})
        return result if result.get('rejected') else {'task_id': task_id}
    if action != 'shot_generate':
        raise ValueError('studio_operation_denied')
    prompt = item.get('image_prompt' if kind == 'image' else 'video_prompt')
    if not prompt:
        raise ValueError('studio_prompt_required')
    payload = {'script_file': script_file, 'prompt': prompt}
    if kind == 'video':
        payload['duration_seconds'] = item.get('duration_seconds')
        import video_specs
        selected = (body.get('models') or {}).get('video') or body.get('_video_model')
        if not selected:
            selected = str(project.get('video_provider_i2v') or project.get('video_backend') or '').partition('/')[2]
        spec = video_specs.catalog.get(selected)
        if spec and spec.get('spec_status') == 'available':
            size = video_specs.resolution(spec, body.get('nativeVideoResolution'))
            video_specs.require_seconds(spec, size, item.get('duration_seconds'))
    # No request-scoped project ratio mutation: worker and provenance resolve the
    # same durable per-shot override, including Agent-created queue entries.
    return await diagnostic_request(client, 'POST', f'{base}/generate/{task_type}/{segment(target)}', payload)
