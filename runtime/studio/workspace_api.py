"""Desktop workspace operations. No caller-selected URL, project path or credentials."""
import asyncio
import base64
import hashlib
import io
from pathlib import Path
import re
import shutil
import tempfile
import time
import uuid
from urllib.parse import quote

uploads = {}

UPLOAD_KINDS = {
    'attachment',
    'source',
    'character',
    'character_ref',
    'character_audio_ref',
    'character_derivative',
    'scene',
    'prop',
    'product',
    'product_ref',
    'bgm',
    'storyboard',
    'end_frame',
    'video',
    'reference_video',
    'style_image',
    'local_media',
    'shot_ref_image',
    'shot_ref_video',
    'unit_ref_image',
    'unit_ref_video',
    'asset_video_ref',
}
IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.webp'}
VIDEO_EXTS = {'.mp4', '.mov', '.m4v', '.webm'}


async def ensure_local_project(name, body, client, checked):
    """Ensure local Studio project + episode exist on disk without requiring paid/remote calls."""
    from project_scope import ensure_episode
    from shot_media import CUSTOM_RESOLUTION_FIELD, is_valid_studio_ratio, normalize_custom_resolution

    existing = await client.get(f'projects/{name}')
    if existing.status_code == 404:
        content_mode = body.get('contentMode', 'drama')
        generation_mode = body.get('generationMode', 'storyboard')
        if content_mode not in {'drama', 'ad'} or generation_mode not in {'storyboard', 'reference_video'}:
            raise ValueError('studio_invalid_request')
        title = str(body.get('title') or name)[:100]
        style_tpl = body.get('styleTemplateId') if isinstance(body.get('styleTemplateId'), str) and body.get('styleTemplateId') else None
        init_ratio = body.get('aspectRatio') if is_valid_studio_ratio(body.get('aspectRatio')) else None
        await checked(client, 'POST', 'projects', {
            'name': name,
            'title': title,
            'content_mode': content_mode,
            'generation_mode': generation_mode,
            **({'style_template_id': style_tpl} if style_tpl else {}),
            **({'aspect_ratio': init_ratio} if init_ratio else {}),
        })
        if body.get('customResolution') is not None:
            norm_res = normalize_custom_resolution(body.get('customResolution'))
            if norm_res:
                from lib.infra.async_thread import run_sync_transaction
                from lib.project.project_manager import get_project_manager
                pm = get_project_manager()
                await run_sync_transaction(lambda: pm.update_project(name, lambda p: p.__setitem__(CUSTOM_RESOLUTION_FIELD, norm_res)))
    elif not existing.is_success:
        raise ValueError('studio_project_unavailable')
    if body.get('episodeId'):
        return await ensure_episode(body, client, checked)
    return body.get('_episode')


def _clean_stem(filename: str) -> str:
    stem = Path(filename or 'media').stem
    cleaned = re.sub(r'[^0-9A-Za-z_\-\u4e00-\u9fff]+', '_', stem).strip('_')[:48]
    return cleaned or 'media'


async def _store_local_record(name: str, entry: dict) -> dict:
    from PIL import Image, ImageOps
    from lib.infra.async_thread import run_sync_transaction
    from lib.infra.media_probe import probe_media
    from lib.project.project_manager import get_project_manager
    from media_staging import SHOT_REFS_FIELD, UNIT_REFS_FIELD, convert_video_to_mp4_sync

    pm = get_project_manager()
    project_dir = await asyncio.to_thread(pm.get_project_path, name)
    filename = entry['filename']
    ext = Path(filename).suffix.lower()
    kind = entry['kind']

    if kind == 'style_image':
        if ext not in IMAGE_EXTS:
            raise ValueError('studio_invalid_request')
        entry['file'].seek(0)
        raw = entry['file'].read()

        def _save_style():
            with Image.open(io.BytesIO(raw)) as img:
                if img.format not in {'PNG', 'JPEG', 'WEBP'}:
                    raise ValueError('studio_invalid_request')
                frame = ImageOps.exif_transpose(img)
                buf = io.BytesIO()
                frame.save(buf, format='PNG')
                png_bytes = buf.getvalue()
            target = project_dir / 'style_reference.png'
            tmp = project_dir / '.style_reference.tmp.png'
            tmp.write_bytes(png_bytes)
            tmp.replace(target)
            def _mutate_style(proj: dict) -> None:
                proj['style_image'] = 'style_reference.png'
                proj.pop('style_template_id', None)
                proj['style'] = ''
                proj.pop('style_description', None)

            pm.update_project(name, _mutate_style)
            return 'style_reference.png'

        rel = await run_sync_transaction(_save_style)
        return {'success': True, 'path': rel}

    if kind in {'shot_ref_image', 'unit_ref_image'} or (kind == 'local_media' and ext in IMAGE_EXTS):
        if ext not in IMAGE_EXTS:
            raise ValueError('studio_invalid_request')
        entry['file'].seek(0)
        raw = entry['file'].read()

        def _validate_img():
            with Image.open(io.BytesIO(raw)) as img:
                if img.format not in {'PNG', 'JPEG', 'WEBP'} or img.width * img.height > 100_000_000:
                    raise ValueError('studio_invalid_request')
                img.verify()

        await asyncio.to_thread(_validate_img)
        digest = hashlib.sha256(raw).hexdigest()[:12]
        if kind == 'shot_ref_image':
            subdir = f"uploads/shots/{re.sub(r'[^0-9A-Za-z_-]+', '_', str(entry['name']))}"
        elif kind == 'unit_ref_image':
            subdir = f"uploads/reference_units/{re.sub(r'[^0-9A-Za-z_-]+', '_', str(entry['name']))}"
        else:
            subdir = 'uploads/images'
        rel = f"{subdir}/{_clean_stem(filename)}_{digest}{ext}"

        def _commit_img():
            dest = project_dir / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_suffix(dest.suffix + '.tmp')
            tmp.write_bytes(raw)
            tmp.replace(dest)
            if kind in {'shot_ref_image', 'unit_ref_image'}:
                field = SHOT_REFS_FIELD if kind == 'shot_ref_image' else UNIT_REFS_FIELD
                target_key = str(entry['name'])

                def _upd(proj):
                    refs = proj.setdefault(field, {}).setdefault(target_key, {'images': [], 'videos': []})
                    imgs = refs.setdefault('images', [])
                    if rel not in imgs:
                        imgs.append(rel)

                pm.update_project(name, _upd)
            return rel

        saved_rel = await run_sync_transaction(_commit_img)
        return {'success': True, 'path': saved_rel, 'kind': 'image'}

    if kind in {'shot_ref_video', 'unit_ref_video', 'asset_video_ref'} or (kind == 'local_media' and ext in VIDEO_EXTS):
        if ext not in VIDEO_EXTS:
            raise ValueError('studio_invalid_request')
        staging_dir = Path(tempfile.mkdtemp(prefix='hg-local-vid-'))
        try:
            staged = staging_dir / ('input' + ext)
            entry['file'].seek(0)

            def _copy_tmp():
                with staged.open('wb') as out:
                    shutil.copyfileobj(entry['file'], out)

            await asyncio.to_thread(_copy_tmp)
            probe = await probe_media(staged)
            if probe.first_stream('video') is None:
                raise ValueError('studio_invalid_video')
            final_src = staged
            final_ext = ext
            if ext in {'.webm', '.mov', '.m4v'}:
                final_src = await asyncio.to_thread(convert_video_to_mp4_sync, staged, staging_dir / 'normalized.mp4')
                final_ext = '.mp4'
            with final_src.open('rb') as handle:
                digest = hashlib.file_digest(handle, 'sha256').hexdigest()[:12]
            if kind == 'shot_ref_video':
                subdir = f"uploads/shots/{re.sub(r'[^0-9A-Za-z_-]+', '_', str(entry['name']))}"
            elif kind == 'unit_ref_video':
                subdir = f"uploads/reference_units/{re.sub(r'[^0-9A-Za-z_-]+', '_', str(entry['name']))}"
            elif kind == 'asset_video_ref':
                cat = str(entry.get('category') or 'assets')
                if cat not in {'characters', 'scenes', 'props', 'products'}:
                    raise ValueError('studio_invalid_request')
                subdir = f"uploads/assets/{cat}"
            else:
                subdir = 'uploads/videos'
            rel = f"{subdir}/{_clean_stem(filename)}_{digest}{final_ext}"

            def _commit_vid():
                dest = project_dir / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                tmp = dest.with_suffix(dest.suffix + '.tmp')
                shutil.copyfile(final_src, tmp)
                tmp.replace(dest)
                if kind in {'shot_ref_video', 'unit_ref_video'}:
                    field = SHOT_REFS_FIELD if kind == 'shot_ref_video' else UNIT_REFS_FIELD
                    target_key = str(entry['name'])

                    def _upd(proj):
                        refs = proj.setdefault(field, {}).setdefault(target_key, {'images': [], 'videos': []})
                        vids = refs.setdefault('videos', [])
                        if rel not in vids:
                            vids.append(rel)

                    pm.update_project(name, _upd)
                elif kind == 'asset_video_ref':
                    asset_key = f"{entry.get('category')}/{entry['name']}"

                    def _upd_asset(proj):
                        vids = proj.setdefault('desktop_asset_videos', {}).setdefault(asset_key, [])
                        if rel not in vids:
                            vids.append(rel)

                    pm.update_project(name, _upd_asset)
                return rel

            saved_rel = await run_sync_transaction(_commit_vid)
            return {'success': True, 'path': saved_rel, 'kind': 'video'}
        finally:
            await asyncio.to_thread(shutil.rmtree, staging_dir, True)

    raise ValueError('studio_invalid_request')


async def upload(name, body, client, checked):
    # TemporaryFile is deleted on close, including process shutdown. Never use a supplied path.
    now = time.monotonic()
    for key, entry in list(uploads.items()):
        if now - entry['touched'] > 600:
            entry['file'].close()
            del uploads[key]
    action = body['action']
    data = body.get('data', {})
    if action == 'upload_begin':
        if len(uploads) >= 4:
            raise ValueError('studio_upload_busy')
        kind = data.get('kind')
        if kind not in UPLOAD_KINDS:
            raise ValueError('studio_invalid_request')
        filename = data.get('filename')
        segment(filename)
        size = data.get('size')
        if type(size) is not int or not 0 < size <= 200 * 1024 * 1024:
            raise ValueError('studio_upload_size')
        if kind == 'attachment':
            ext = Path(filename).suffix.lower()
            max_attach = 128 * 1024 * 1024 if ext in VIDEO_EXTS else 30 * 1024 * 1024
            if size > max_attach:
                raise ValueError('studio_upload_size')
        if kind == 'character_derivative':
            segment(data.get('name'))
            segment(data.get('derivative'))
        if kind in {'shot_ref_image', 'shot_ref_video', 'unit_ref_image', 'unit_ref_video', 'end_frame', 'storyboard', 'video', 'reference_video', 'asset_video_ref'}:
            segment(data.get('name'))
        key = uuid.uuid4().hex
        uploads[key] = {
            'file': tempfile.TemporaryFile(),
            'project': name,
            'binding': body['_binding'],
            'episode': body.get('_episode'),
            'filename': filename,
            'kind': kind,
            'name': data.get('name'),
            'derivative': data.get('derivative'),
            'category': data.get('category'),
            'size': size,
            'offset': 0,
            'touched': now,
        }
        return {'id': key}
    key = body.get('id')
    entry = uploads.get(key)
    if not entry or entry['project'] != name or entry['binding'] != body['_binding']:
        raise ValueError('studio_invalid_upload')
    entry['touched'] = now
    if action == 'upload_chunk':
        raw = base64.b64decode(data.get('chunk', ''), validate=True)
        if data.get('offset') != entry['offset'] or not 0 < len(raw) <= 384 * 1024 or entry['offset'] + len(raw) > entry['size']:
            raise ValueError('studio_invalid_upload')
        entry['file'].write(raw)
        entry['offset'] += len(raw)
        return {'offset': entry['offset']}
    if action not in {'upload_cancel', 'upload_finish'}:
        raise ValueError('studio_operation_denied')
    try:
        if action == 'upload_cancel':
            return {'ok': True}
        if entry['offset'] != entry['size']:
            raise ValueError('studio_invalid_upload')
        if entry['kind'] == 'attachment':
            from conversation_api import save_attachment
            from lib.project.project_manager import get_project_manager
            try:
                await ensure_local_project(name, body, client, checked)
                project_dir = get_project_manager().get_project_path(name)
                if not project_dir.is_dir():
                    raise ValueError('studio_project_storage_unavailable')
            except OSError as exc:
                raise ValueError('studio_project_storage_unavailable') from exc
            entry['file'].seek(0)
            return await asyncio.to_thread(
                save_attachment,
                body['_data_root'],
                body['_binding'],
                entry['file'],
                filename=entry['filename'],
                project_dir=project_dir,
            )

        resolved_episode = await ensure_local_project(name, body, client, checked)
        if not entry.get('episode') and resolved_episode:
            entry['episode'] = resolved_episode
        if entry['kind'] in {'style_image', 'local_media', 'shot_ref_image', 'shot_ref_video', 'unit_ref_image', 'unit_ref_video', 'asset_video_ref'}:
            return await _store_local_record(name, entry)

        base = f'projects/{name}'
        upload_filename = entry['filename']
        upload_stream = entry['file']
        staging_webm_dir: Path | None = None
        try:
            if entry['kind'] in {'video', 'reference_video'} and Path(upload_filename).suffix.lower() == '.webm':
                from media_staging import convert_video_to_mp4_sync
                staging_webm_dir = Path(tempfile.mkdtemp(prefix='hg-webm-'))
                webm_in = staging_webm_dir / 'input.webm'
                entry['file'].seek(0)
                with webm_in.open('wb') as out:
                    shutil.copyfileobj(entry['file'], out)
                mp4_out = await asyncio.to_thread(convert_video_to_mp4_sync, webm_in, staging_webm_dir / 'converted.mp4')
                upload_filename = Path(upload_filename).stem + '.mp4'
                upload_stream = mp4_out.open('rb')

            if entry['kind'] == 'reference_video':
                path = f'{base}/reference-videos/episodes/{entry["episode"]}/units/{segment(entry["name"])}/upload-video'
            elif entry['kind'] == 'character_derivative':
                path = f'{base}/characters/{segment(entry["name"])}/derivatives/{segment(entry["derivative"])}/upload'
            elif entry['kind'] in {'storyboard', 'video', 'end_frame'}:
                response = await client.get(base)
                if not response.is_success:
                    raise ValueError('studio_engine_rejected')
                script = next(e for e in response.json()['project']['episodes'] if e['episode'] == entry['episode'])['script_file'].removeprefix('scripts/')
                if entry['kind'] == 'end_frame':
                    path = f'{base}/shots/{segment(entry["name"])}/end-frame/upload?script_file={segment(script)}'
                else:
                    path = f'{base}/shots/{segment(entry["name"])}/upload/{entry["kind"]}?script_file={segment(script)}'
            else:
                path = f'{base}/upload/{entry["kind"]}'
                if entry['name']:
                    path += '?name=' + segment(entry['name'])
            upload_stream.seek(0)
            response = await client.post(path, files={'file': (upload_filename, upload_stream, 'application/octet-stream')})
            if not response.is_success:
                raise ValueError('studio_engine_rejected')
            return response.json()
        finally:
            if upload_stream is not entry['file']:
                upload_stream.close()
            if staging_webm_dir is not None:
                await asyncio.to_thread(shutil.rmtree, staging_webm_dir, True)
    finally:
        entry['file'].close()
        uploads.pop(key, None)


def segment(value):
    if not isinstance(value, str) or not value or len(value) > 200 or any(c in value for c in '/\\\x00') or value in {'.', '..'}:
        raise ValueError('studio_invalid_request')
    return quote(value, safe='')


async def workspace(name, body, client, checked, service, read_binding, write_binding):
    action = body.get('action')
    episode = body.get('_episode')
    if action in {'blank_script', 'source_save', 'plan_generate', 'review_confirm', 'prompts_generate', 'project_settings', 'asset_create', 'reference_add', 'reference_parse'}:
        episode = await ensure_local_project(name, body, client, checked)
    if isinstance(action, str) and action.startswith('upload_'):
        return await upload(name, body, client, checked)
    base = f'projects/{name}'
    data = body.get('data', {})
    if not isinstance(data, dict):
        raise ValueError('studio_invalid_request')
    if action == 'attachment_preview':
        from conversation_api import attachment_meta, attachment_path
        path = attachment_path(body['_data_root'], body['_binding'], body.get('id'))
        meta = attachment_meta(body['_data_root'], body['_binding'], body.get('id'))
        return {
            'url': 'data:image/jpeg;base64,' + base64.b64encode(path.read_bytes()).decode(),
            'kind': meta.get('kind', 'image'),
            'projectPath': meta.get('project_path'),
        }
    if action == 'ensure_formal_shot':
        episode = await ensure_local_project(name, body, client, checked)
        detail = await checked(client, 'GET', base)
        ep_row = next((e for e in detail['project'].get('episodes', []) if e['episode'] == episode), {})
        script_file = (ep_row.get('script_file') or '').removeprefix('scripts/')
        if not script_file or script_file not in (detail.get('scripts') or {}):
            await checked(client, 'POST', f'{base}/episodes/{episode}/blank-script')
            detail = await checked(client, 'GET', base)
            ep_row = next((e for e in detail['project'].get('episodes', []) if e['episode'] == episode), {})
            script_file = (ep_row.get('script_file') or '').removeprefix('scripts/')
        snap = await checked(client, 'GET', f'{base}/scripts/{segment(script_file)}')
        draft_shots = data.get('shots') if isinstance(data.get('shots'), list) else []
        target_index = data.get('index', 0)
        if type(target_index) is not int or target_index < 0:
            target_index = 0
        scenes = list((snap.get('script') or {}).get('scenes') or [])
        while len(scenes) <= max(target_index, len(draft_shots) - 1, 0):
            after_id = scenes[-1]['scene_id'] if scenes else None
            inserted = await checked(client, 'POST', f'{base}/script-items', {'script_file': f'scripts/{script_file}', 'after_id': after_id})
            if inserted.get('item'):
                scenes.append(inserted['item'])
            else:
                break
        if draft_shots and scenes:
            latest = await checked(client, 'GET', f'{base}/scripts/{segment(script_file)}')
            ops = []
            for idx, draft in enumerate(draft_shots[: len(scenes)]):
                if not isinstance(draft, dict):
                    continue
                scene_id = scenes[idx].get('scene_id')
                if not scene_id:
                    continue
                fields = {}
                if isinstance(draft.get('description'), str) and draft['description'].strip():
                    fields['scene_description'] = draft['description'][:5000]
                if isinstance(draft.get('duration'), (int, float)) and 1 <= int(draft['duration']) <= 120:
                    fields['duration_seconds'] = int(draft['duration'])
                if fields:
                    ops.append({'op': 'update', 'id': scene_id, 'fields': fields})
            if ops:
                await checked(client, 'POST', f'{base}/script-edits', {
                    'episode': episode,
                    'expected_script_file': script_file,
                    'expected_revision': latest['revision'],
                    'operations': ops,
                })
        chosen = scenes[min(target_index, len(scenes) - 1)]['scene_id'] if scenes else None
        if not chosen:
            raise ValueError('studio_engine_rejected')
        return {'shotId': chosen, 'scriptFile': script_file}
    if action == 'shot_end_frame_clear':
        detail = await checked(client, 'GET', base)
        script = next(e for e in detail['project']['episodes'] if e['episode'] == episode)['script_file'].removeprefix('scripts/')
        return await checked(client, 'DELETE', f'{base}/shots/{segment(body.get("id"))}/end-frame?script_file={segment(script)}')
    if action == 'style_image_clear':
        from lib.infra.async_thread import run_sync_transaction
        from lib.project.project_manager import get_project_manager
        pm = get_project_manager()
        await run_sync_transaction(lambda: pm.update_project(name, lambda p: p.pop('style_image', None)))
        return {'ok': True}
    if action == 'local_ref_remove':
        from lib.infra.async_thread import run_sync_transaction
        from lib.project.project_manager import get_project_manager
        from media_staging import SHOT_REFS_FIELD, UNIT_REFS_FIELD
        scope_kind = data.get('scopeKind')
        rel_path = data.get('path')
        target_id = body.get('id')
        if scope_kind not in {'shot', 'unit', 'asset'} or not isinstance(rel_path, str) or not isinstance(target_id, str):
            raise ValueError('studio_invalid_request')
        pm = get_project_manager()

        def _remove(proj):
            if scope_kind == 'asset':
                items = (proj.get('desktop_asset_videos') or {}).get(target_id)
                if isinstance(items, list) and rel_path in items:
                    items.remove(rel_path)
                return
            field = SHOT_REFS_FIELD if scope_kind == 'shot' else UNIT_REFS_FIELD
            entry = (proj.get(field) or {}).get(target_id)
            if isinstance(entry, dict):
                for bucket in ('images', 'videos'):
                    if isinstance(entry.get(bucket), list) and rel_path in entry[bucket]:
                        entry[bucket].remove(rel_path)

        await run_sync_transaction(lambda: pm.update_project(name, _remove))
        return {'ok': True}
    if action.startswith('queue_'):
        binding = read_binding(name)
        session = binding.get('session_id')
        meta = await service.get_session(session) if session else None
        if not meta or meta.project_name != name:
            raise ValueError('studio_invalid_session')
        key = body.get('id')
        segment(key)
        if action in {'queue_edit', 'queue_delete'}:
            result = await service.withdraw_queued_message(name, session, key, intent=action.removeprefix('queue_'))
        elif action == 'queue_resend':
            result = await service.resend_queued_message(name, session, key, locale='zh-CN')
        elif action == 'queue_now':
            result = await service.send_queued_message_now(name, session, key)
        else:
            raise ValueError('studio_operation_denied')
        from conversation_api import queued_display
        return {'outcome': result.get('outcome'), 'message': queued_display(body['_data_root'], body['_binding'], result['message']) if result.get('message') else None}
    if action == 'sessions':
        binding = read_binding(name)
        owned = set(binding.get('sessions', []) + ([binding['session_id']] if binding.get('session_id') else []))
        titles = dict(binding.get('titles', {}))
        sessions = []
        for identity in owned:
            meta = await service.get_session(identity)
            if not meta or meta.project_name not in [name, *body.get('_source_projects', [])]:
                continue
            row = {k: meta.model_dump(mode='json').get(k) for k in ('id', 'title', 'status', 'created_at', 'updated_at')}
            if identity not in titles:
                from conversation_api import clean_user_text, is_synthetic_user_text
                entries = (await service.list_session_entries(identity))['entries']
                for candidate in entries:
                    if candidate.get('type') != 'user' or candidate.get('parent_tool_use_id') or candidate.get('subtype') in {'compact_summary', 'question_answer'}:
                        continue
                    content = candidate.get('content', [])
                    raw_text = content if isinstance(content, str) else '\n'.join(b.get('text', '') for b in content if isinstance(b, dict) and b.get('type') == 'text')
                    if is_synthetic_user_text(raw_text):
                        continue
                    cleaned, _ = clean_user_text(raw_text)
                    if cleaned:
                        titles[identity] = cleaned.splitlines()[0].strip()[:60]
                        break
            row['title'] = titles.get(identity) or row.get('title') or '新会话'
            row['superseded'] = bool(meta.superseded_by) or meta.project_name != name
            sessions.append(row)
        if titles != binding.get('titles', {}):
            write_binding(name, {**binding, 'titles': titles})
        return {'sessions': sorted(sessions, key=lambda s: s['created_at'] or '', reverse=True), 'selected': binding.get('session_id')}
    if action in {'session_select', 'session_new', 'session_delete'}:
        binding = read_binding(name)
        binding['sessions'] = list(dict.fromkeys(binding.get('sessions', []) + ([binding['session_id']] if binding.get('session_id') else [])))
        if binding.get('pending'):
            raise ValueError('studio_submission_uncertain')
        current = await service.get_session(binding['session_id']) if binding.get('session_id') else None
        if current and current.status == 'running':
            raise ValueError('studio_session_busy')
        target = body.get('id')
        if action != 'session_new':
            meta = await service.get_session(target) if isinstance(target, str) else None
            owned = binding.get('sessions', []) + [binding.get('session_id')]
            if not meta or meta.project_name not in [name, *body.get('_source_projects', [])] or meta.status == 'running' or target not in owned or (action == 'session_delete' and meta.project_name != name):
                raise ValueError('studio_invalid_session')
        if action == 'session_delete':
            await service.delete_session(target)
        if action != 'session_delete' or target == binding.get('session_id'):
            binding['session_id'] = target if action == 'session_select' else None
            binding.pop('lastRequest', None)
            write_binding(name, binding)
        return {'ok': True}
    if action == 'project':
        response = await client.get(base)
        if response.status_code == 404:
            return {'project': None, 'scripts': {}}
        detail = await checked(client, 'GET', base)
        detail['project']['episodes'] = [e for e in detail['project'].get('episodes', []) if e['episode'] == episode]
        detail['episodeNumber'] = episode
        return detail
    if action == 'project_settings':
        from shot_media import CUSTOM_RESOLUTION_FIELD, is_valid_studio_ratio, normalize_custom_resolution
        if 'aspect_ratio' in data and not is_valid_studio_ratio(data['aspect_ratio']):
            raise ValueError('studio_invalid_ratio')
        has_custom_res = 'custom_resolution' in data
        norm_custom_res = normalize_custom_resolution(data.get('custom_resolution')) if has_custom_res else None
        await ensure_local_project(name, body, client, checked)
        patch_payload = {k: v for k, v in data.items() if k in {'brief', 'target_duration', 'style', 'style_template_id', 'clear_style_image', 'aspect_ratio'}}
        result = await checked(client, 'PATCH', base, patch_payload) if patch_payload else {}
        if has_custom_res:
            from lib.infra.async_thread import run_sync_transaction
            from lib.project.project_manager import get_project_manager
            pm = get_project_manager()

            def _save_res(proj):
                if norm_custom_res is None:
                    proj.pop(CUSTOM_RESOLUTION_FIELD, None)
                else:
                    proj[CUSTOM_RESOLUTION_FIELD] = norm_custom_res

            await run_sync_transaction(lambda: pm.update_project(name, _save_res))
        return result
    if action in {'shot_settings', 'shot_ratio', 'shot_precheck', 'shot_generate', 'shot_recover'}:
        from shot_media import shot_operation
        return await shot_operation(name, body, client, checked)
    if action == 'ad_generate':
        return await diagnostic_request(client, 'POST', f'{base}/episodes/{episode}/ad-script', {k: v for k, v in data.items() if k in {'instructions', 'regenerate', 'overwrite_revision'}})
    if action.startswith('reference_'):
        path = f'{base}/reference-videos/episodes/{episode}'
        if action in {'reference_batch_preview', 'reference_batch', 'reference_precheck', 'reference_generate'}:
            import video_specs
            model = (body.get('models') or {}).get('video') or body.get('_video_model')
            spec = video_specs.catalog.get(model)
            if spec and spec.get('spec_status') == 'available':
                size = video_specs.resolution(spec, body.get('nativeVideoResolution'))
                allowed_seconds = spec['seconds_by_resolution'][size]
                units = (await checked(client, 'GET', path + '/units')).get('units', [])
                many = action in {'reference_batch_preview', 'reference_batch'}
                ids = data.get('unit_ids') if many else [body.get('id')]
                affected = [u for u in units if (not ids or u.get('unit_id') in ids)
                            and not (many and (u.get('generated_assets') or {}).get('video_clip'))
                            and u.get('duration_seconds') not in allowed_seconds]
                if affected:
                    labels = '、'.join(str(u.get('unit_id')) + '（' + str(u.get('duration_seconds')) + ' 秒）' for u in affected)
                    return {'decision': 'blocked', 'rejected': True, 'diagnostic':
                            f"请调整 {labels} 的时长，或更换模型。{size} 可选秒数为 {', '.join(map(str, allowed_seconds))}。"}
        routes = {
            'reference_units': ('GET', '/units', None),
            'reference_add': ('POST', '/units', {'prompt', 'duration_seconds', 'note', 'after_unit_id'}),
            'reference_parse': ('POST', '/script-preview', {'prompt'}),
            'reference_batch_preview': ('POST', '/units/generate-batch/preview', {'unit_ids', 'confirmed_request_durations'}),
            'reference_batch': ('POST', '/units/generate-batch', {'unit_ids', 'confirmed_request_durations'}),
        }
        if action in routes:
            method, suffix, fields = routes[action]
        else:
            path += '/units/' + segment(body.get('id'))
            routes = {
                'reference_update': ('PATCH', '', {'prompt', 'duration_seconds', 'note'}),
                'reference_delete': ('DELETE', '', None),
                'reference_move': ('POST', '/move', {'after_unit_id'}),
                'reference_precheck': ('GET', '/duration-precheck', None),
                'reference_preview': ('POST', '/prompt-preview', {'prompt'}),
                'reference_generate': ('POST', '/generate', {'confirmed_request_duration_seconds'}),
            }
            if action not in routes:
                raise ValueError('studio_operation_denied')
            method, suffix, fields = routes[action]
        result = await diagnostic_request(client, method, path + suffix, {k: v for k, v in data.items() if k in fields} if fields else None)
        if action in {'reference_precheck', 'reference_batch_preview'} and not result.get('rejected'):
            try:
                from lib.project.project_manager import get_project_manager
                from media_staging import augment_unit_precheck
                pm = get_project_manager()
                proj = await asyncio.to_thread(pm.load_project, name)
                proj_path = await asyncio.to_thread(pm.get_project_path, name)
                configured_ref = str(proj.get('video_provider_r2v') or proj.get('video_backend') or '')
                fallback_model = configured_ref.split('/', 1)[1] if '/' in configured_ref else configured_ref
                selected_model = (body.get('models') or {}).get('video') or fallback_model
                result = await augment_unit_precheck(Path.cwd(), proj_path, proj, body.get('id') if action == 'reference_precheck' else None, selected_model, result)
            except Exception:
                pass
        if action == 'reference_units' and isinstance(result, dict) and 'units' in result:
            try:
                from lib.project.project_manager import get_project_manager
                from media_staging import UNIT_REFS_FIELD
                proj = await asyncio.to_thread(get_project_manager().load_project, name)
                result['unit_references'] = proj.get(UNIT_REFS_FIELD) or {}
            except Exception:
                result['unit_references'] = {}
        return result
    if action == 'timelines':
        return await checked(client, 'GET', f'{base}/edit-timelines?episode={episode}') if episode else {'timelines': []}
    if action == 'timeline_create':
        return await checked(client, 'POST', f'{base}/episodes/{episode}/edit-timelines', {'from': 'script', 'name': data.get('name')})
    if action == 'timeline_export_draft':
        from lib.project.project_manager import get_project_manager
        from server.services.presentation.timeline_jianying_draft import TimelineJianyingDraftService
        timeline_id = body.get('id')
        segment(timeline_id)
        root = data.get('directory')
        version = data.get('version', '6')
        narration = data.get('narration', 'without_narration')
        if not isinstance(root, str) or not root.strip() or len(root) > 1024 or any(ord(c) < 32 for c in root) or version not in {'5', '6'} or narration not in {'with_narration', 'without_narration'}:
            raise ValueError('studio_invalid_request')
        manager = get_project_manager()
        package, _ = await TimelineJianyingDraftService(manager).package_download(name, timeline_id, narration=narration, draft_root=root.strip(), jianying_version=version)
        project_root = manager.get_project_path(name).resolve()
        destination = project_root / 'output' / f'jianying-export-{uuid.uuid4().hex}.zip'
        try:
            if destination.parent.is_symlink() or not destination.resolve().is_relative_to(project_root):
                raise ValueError('studio_invalid_artifact')
            destination.parent.mkdir(exist_ok=True)
            await asyncio.to_thread(shutil.copyfile, package, destination)
        finally:
            package.unlink(missing_ok=True)
            # The service owns this temporary directory; never delete a caller-supplied path.
            temp_root = Path(tempfile.gettempdir()).resolve()
            parent = package.parent.resolve()
            if parent != temp_root and parent.is_relative_to(temp_root):
                await asyncio.to_thread(shutil.rmtree, parent)
        return {'status': 'exported'}
    if action.startswith('timeline_'):
        path = f'{base}/edit-timelines/{segment(body.get("id"))}'
        routes = {
            'timeline_read': ('GET', '', None), 'timeline_media': ('GET', '/preview-media', None),
            'timeline_rename': ('PATCH', '', {'name': data.get('name')}),
            'timeline_delete': ('DELETE', '', None), 'timeline_revisions': ('GET', '/revisions', None),
            'timeline_copy': ('POST', '/copy', {k: v for k, v in data.items() if k in {'name', 'revision'}}),
            'timeline_restore': ('POST', '/restore', {'revision': data.get('revision')}),
        }
        if action in routes:
            method, suffix, payload = routes[action]
            return await checked(client, method, path + suffix, payload)
        if action in {'timeline_render', 'timeline_render_status', 'timeline_draft', 'timeline_draft_status'}:
            fields = {k: v for k, v in data.items() if k in {'revision', 'narration', 'subtitles'}}
            draft = action in {'timeline_draft', 'timeline_draft_status'}
            if draft:
                fields.pop('subtitles', None)
                fields.pop('revision', None)
            suffix = '/jianying-draft' if draft else '/final-cut'
            if action.endswith('_status'):
                from urllib.parse import urlencode
                result = await checked(client, 'GET', path + suffix + '?' + urlencode(fields))
                result.pop('download_url', None)  # signed engine URLs never reach the renderer
                return result
            return await checked(client, 'POST', path + suffix, fields)
    if action == 'script':
        return await checked(client, 'GET', f'{base}/scripts/{segment(body.get("id"))}')
    if action == 'script_edit':
        return await checked(client, 'POST', f'{base}/script-edits', {
            'episode': episode, 'expected_script_file': data.get('scriptFile'),
            'expected_revision': data.get('revision'), 'operations': data.get('operations'),
        })
    if action == 'script_insert':
        detail = await checked(client, 'GET', base)
        script_file = next(e for e in detail['project']['episodes'] if e['episode'] == episode)['script_file']
        return await checked(client, 'POST', f'{base}/script-items', {'script_file': script_file, 'after_id': data.get('afterId')})
    if action == 'blank_script':
        return await checked(client, 'POST', f'{base}/episodes/{episode}/blank-script')
    if action in {'versions', 'version_restore'}:
        category = body.get('category')
        if category not in {'characters', 'scenes', 'props', 'products', 'storyboards', 'videos', 'reference_videos', 'character-derivative'}:
            raise ValueError('studio_invalid_request')
        path = f'{base}/versions/{category}/{segment(body.get("id"))}'
        if category == 'character-derivative':
            path += '/' + segment(data.get('derivative'))
        if action == 'versions':
            result = await checked(client, 'GET', path)
            # Only original display/provenance fields; native paths are not exposed.
            result['versions'] = [{k: row.get(k) for k in ('version', 'created_at', 'timestamp', 'file', 'prompt', 'restorable')} for row in result.get('versions', [])]
            return result
        version = data.get('version')
        if type(version) is not int or version < 1:
            raise ValueError('studio_invalid_request')
        return await checked(client, 'POST', path + f'/restore/{version}')
    if action.startswith('derivative_'):
        path = f'{base}/characters/{segment(body.get("id"))}/derivatives'
        if action == 'derivative_create':
            return await checked(client, 'POST', path, {'name': data.get('name'), 'description': data.get('description', '')})
        path += '/' + segment(data.get('derivative'))
        if action == 'derivative_update':
            return await checked(client, 'PATCH', path, {'description': data.get('description', '')})
        if action == 'derivative_rename':
            return await checked(client, 'POST', path + '/rename', {'new_name': data.get('name')})
        if action == 'derivative_delete':
            return await checked(client, 'DELETE', path)
    if action.startswith('asset_'):
        category = body.get('category')
        if category not in {'characters', 'scenes', 'props', 'products'}:
            raise ValueError('studio_invalid_request')
        path = f'{base}/{category}'
        allowed = {'name', 'description', 'voice_style', 'brand', 'selling_points'}
        if action == 'asset_create':
            return await checked(client, 'POST', path, {k: v for k, v in data.items() if k in allowed})
        path += '/' + segment(body.get('id'))
        if action == 'asset_update':
            return await checked(client, 'PATCH', path, {k: v for k, v in data.items() if k in allowed - {'name'}})
        if action == 'asset_delete':
            return await checked(client, 'DELETE', path)
        if action == 'asset_rename':
            return await checked(client, 'POST', path + '/rename', {'new_name': data.get('name'), 'dry_run': data.get('dryRun', True)})
        if action == 'asset_merge':
            return await checked(client, 'POST', path + '/merge', {'target': data.get('target'), 'as_derivative': data.get('asDerivative', False), 'dry_run': data.get('dryRun', True)})
    if action == 'workflow':
        return await checked(client, 'GET', f'{base}/workflow-status?episode={episode}') if episode else {}
    if action == 'source_save':
        return await checked(client, 'PUT', f'{base}/episodes/{episode}/source', {k: v for k, v in data.items() if k in {'text', 'source_kind', 'confirm'}})
    if action == 'review':
        return await checked(client, 'GET', f'{base}/episodes/{episode}/script-review') if episode else {'status': 'absent'}
    if action == 'review_save':
        fingerprint = data.get('fingerprint')
        if not isinstance(fingerprint, str) or not fingerprint:
            raise ValueError('studio_invalid_request')
        return await checked(client, 'PUT', f'{base}/episodes/{episode}/script-review/content?base_fingerprint={quote(fingerprint, safe="")}', data.get('content'))
    if action == 'review_confirm':
        return await checked(client, 'POST', f'{base}/episodes/{episode}/script-review/confirm', {'overwrite_revision': data.get('revision')})
    if action == 'plan_generate':
        return await checked(client, 'POST', f'{base}/episodes/{episode}/script-plan', {'instructions': data.get('instructions', '')})
    if action == 'prompts_generate':
        return await checked(client, 'POST', f'{base}/episodes/{episode}/prompt-authoring', {'instructions': data.get('instructions', ''), 'rewrite': data.get('rewrite', False)})
    raise ValueError('studio_operation_denied')


async def diagnostic_request(client, method, path, payload):
    """Keep admission/overwrite feedback, without turning a rejected request into success."""
    response = await client.request(method, path, json=payload)
    if response.is_success:
        return response.json() if response.content else {}
    if response.status_code in {400, 404, 409, 422}:
        envelope = response.json()
        return {'rejected': True, 'diagnostic': envelope.get('diagnostic') or envelope.get('detail') or envelope}
    raise ValueError('studio_engine_rejected')
