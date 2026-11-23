"""Scoped image and video attachments. Renderer stores opaque references, never native paths."""
import base64
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import tempfile
from PIL import Image, ImageOps


def image_bytes(stream):
    with Image.open(stream) as image:
        if image.format not in {'PNG', 'JPEG', 'WEBP'} or image.width * image.height > 40_000_000:
            raise ValueError('studio_invalid_attachment')
        image.load()
        image = ImageOps.exif_transpose(image).convert('RGB')
        image.thumbnail((2048, 2048))
        for quality in (88, 75, 60, 40):
            buffer = io.BytesIO()
            image.save(buffer, format='JPEG', quality=quality)
            raw = buffer.getvalue()
            if len(raw) <= 1536 * 1024:
                return raw
        raise ValueError('studio_upload_size')


def _safe_stem(filename: str | None, fallback: str) -> str:
    stem = Path(filename or fallback).stem
    cleaned = re.sub(r'[^0-9A-Za-z_\-\u4e00-\u9fff]+', '_', stem).strip('_')[:48]
    return cleaned or fallback


def _persist_project_record(project_dir: Path | None, subdir: str, filename: str | None, ext: str, raw_or_path) -> str | None:
    if not project_dir or not project_dir.is_dir():
        return None
    if isinstance(raw_or_path, Path):
        with raw_or_path.open('rb') as handle:
            digest = hashlib.file_digest(handle, 'sha256').hexdigest()[:12]
    else:
        digest = hashlib.sha256(raw_or_path).hexdigest()[:12]
    stem = _safe_stem(filename, 'media')
    rel = f'uploads/{subdir}/{stem}_{digest}{ext}'
    dest = project_dir / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not dest.exists():
        tmp = dest.with_suffix(dest.suffix + '.tmp')
        if isinstance(raw_or_path, Path):
            shutil.copyfile(raw_or_path, tmp)
        else:
            tmp.write_bytes(raw_or_path)
        tmp.replace(dest)
    return rel


def save_attachment(data_root, binding, stream, *, filename=None, project_dir: Path | None = None):
    ext = Path(filename or '').suffix.lower()
    if ext in {'.mp4', '.mov', '.m4v', '.webm'}:
        return _save_video_attachment(data_root, binding, stream, filename=filename, project_dir=project_dir)
    stream.seek(0)
    original_bytes = stream.read()
    raw = image_bytes(io.BytesIO(original_bytes))
    identity = hashlib.sha256(raw).hexdigest()
    folder = data_root / 'attachments' / binding
    folder.mkdir(parents=True, exist_ok=True)
    destination = folder / (identity + '.jpg')
    if not destination.exists():
        temporary = destination.with_suffix('.tmp')
        temporary.write_bytes(raw)
        temporary.replace(destination)
    img_ext = ext if ext in {'.png', '.jpg', '.jpeg', '.webp'} else '.jpg'
    project_rel = _persist_project_record(project_dir, 'images', filename, img_ext, original_bytes)
    if project_rel:
        meta_path = folder / (identity + '.meta.json')
        meta_path.write_text(json.dumps({'kind': 'image', 'name': filename or '对话附图.jpg', 'project_path': project_rel}, ensure_ascii=False), encoding='utf-8')
    return {'id': identity, 'size': len(raw), 'kind': 'image', 'projectPath': project_rel}


def _save_video_attachment(data_root, binding, stream, *, filename=None, project_dir: Path | None = None):
    from media_staging import convert_video_to_mp4_sync, extract_video_keyframes_sync
    ext = Path(filename or 'video.mp4').suffix.lower()
    if ext not in {'.mp4', '.mov', '.m4v', '.webm'}:
        raise ValueError('studio_invalid_attachment')
    staging_dir = Path(tempfile.mkdtemp(prefix='hg-chat-vid-'))
    try:
        staged = staging_dir / ('input' + ext)
        stream.seek(0)
        total = 0
        with staged.open('wb') as out:
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > 128 * 1024 * 1024:
                    raise ValueError('studio_upload_size')
                out.write(chunk)
        if total <= 0:
            raise ValueError('studio_invalid_attachment')
        frames = extract_video_keyframes_sync(staged, count=2)
        if not frames:
            raise ValueError('studio_invalid_attachment')
        with staged.open('rb') as handle:
            identity = hashlib.file_digest(handle, 'sha256').hexdigest()
        folder = data_root / 'attachments' / binding
        folder.mkdir(parents=True, exist_ok=True)
        # Store keyframe JPEG at {identity}.jpg so attachment_path & preview work uniformly.
        thumb_bytes = image_bytes(io.BytesIO(frames[0]))
        destination = folder / (identity + '.jpg')
        if not destination.exists():
            tmp = destination.with_suffix('.tmp')
            tmp.write_bytes(thumb_bytes)
            tmp.replace(destination)
        if len(frames) > 1:
            second_bytes = image_bytes(io.BytesIO(frames[1]))
            second_dest = folder / (identity + '.frame2.jpg')
            if not second_dest.exists():
                second_dest.write_bytes(second_bytes)
        normalized = staged
        out_ext = ext
        if ext in {'.mov', '.m4v', '.webm'}:
            normalized = convert_video_to_mp4_sync(staged, staging_dir / 'normalized.mp4')
            out_ext = '.mp4'
        project_rel = _persist_project_record(project_dir, 'videos', filename, out_ext, normalized)
        meta_path = folder / (identity + '.meta.json')
        meta_path.write_text(
            json.dumps({'kind': 'video', 'name': filename or '本地视频.mp4', 'project_path': project_rel, 'size': total}, ensure_ascii=False),
            encoding='utf-8',
        )
        return {'id': identity, 'size': total, 'kind': 'video', 'projectPath': project_rel}
    finally:
        shutil.rmtree(staging_dir, ignore_errors=True)


def attachment_path(data_root, binding, identity):
    if not isinstance(identity, str) or not re.fullmatch('[a-f0-9]{64}', identity):
        raise ValueError('studio_invalid_attachment')
    path = data_root / 'attachments' / binding / (identity + '.jpg')
    if not path.is_file() or path.is_symlink():
        raise ValueError('studio_invalid_attachment')
    return path


def attachment_meta(data_root, binding, identity) -> dict:
    attachment_path(data_root, binding, identity)
    meta_file = data_root / 'attachments' / binding / (identity + '.meta.json')
    if meta_file.is_file() and not meta_file.is_symlink():
        try:
            return json.loads(meta_file.read_text(encoding='utf-8'))
        except Exception:
            return {}
    return {}


def load_images(data_root, binding, references):
    from server.routers.assistant import ImageAttachment
    if not isinstance(references, list) or len(references) > 5:
        raise ValueError('studio_invalid_attachment')
    result = []
    for ref in references:
        main_jpg = attachment_path(data_root, binding, ref['id'])
        result.append(ImageAttachment(data=base64.b64encode(main_jpg.read_bytes()).decode(), media_type='image/jpeg'))
        second_jpg = data_root / 'attachments' / binding / (ref['id'] + '.frame2.jpg')
        if second_jpg.is_file() and not second_jpg.is_symlink() and len(result) < 8:
            result.append(ImageAttachment(data=base64.b64encode(second_jpg.read_bytes()).decode(), media_type='image/jpeg'))
    return result


def describe_local_attachments(data_root, binding, references) -> str:
    if not isinstance(references, list) or not references:
        return ''
    lines = []
    for idx, ref in enumerate(references, 1):
        try:
            info = attachment_meta(data_root, binding, ref['id'])
        except Exception:
            continue
        rel = info.get('project_path')
        kind_label = '本地视频' if info.get('kind') == 'video' else '本地图片'
        display = info.get('name') or ref.get('name') or f'附件{idx}'
        if rel:
            lines.append(f'- {kind_label} #{idx}（{display}）：已保存在当前项目本地路径 `{rel}`')
        else:
            lines.append(f'- {kind_label} #{idx}（{display}）')
    if not lines:
        return ''
    return '用户本轮上传的本地媒体记录（已保存在本地项目目录，可在资产/分镜/参考单元中复用）：\n' + '\n'.join(lines) + '\n\n'


def thumbnail(source):
    try:
        if source.get('type') != 'base64' or len(source.get('data', '')) > 8 * 1024 * 1024:
            return None
        raw = base64.b64decode(source['data'], validate=True)
        with Image.open(io.BytesIO(raw)) as image:
            image.thumbnail((180, 180))
            buffer = io.BytesIO()
            image.convert('RGB').save(buffer, 'JPEG', quality=65)
        return 'data:image/jpeg;base64,' + base64.b64encode(buffer.getvalue()).decode()
    except Exception:
        return None


def queued_display(data_root, binding, message):
    content = message.get('content', [])
    if isinstance(content, str):
        content = [{'type': 'text', 'text': content}]
    text = '\n'.join(b.get('text', '') for b in content if b.get('type') == 'text')
    if '本轮制作要求：' in text:
        text = text.split('本轮制作要求：', 1)[1].strip()
    attachments = []
    for block in content:
        if block.get('type') == 'image':
            source = block.get('source', {})
            if source.get('type') == 'base64':
                raw = base64.b64decode(source.get('data', ''), validate=True)
                ref = save_attachment(data_root, binding, io.BytesIO(raw))
                attachments.append({'id': ref['id'], 'name': '对话附图.jpg'})
    return {'id': message['id'], 'state': message.get('state', 'queued'), 'text': text[:30000], 'attachments': attachments}


_CUTOFF_RETRY_PREFIX = 'your response above was cut off mid-stream'
_SYNTHETIC_USER_PREFIXES = (
    _CUTOFF_RETRY_PREFIX,
    'this session is being continued from a previous conversation',
    'base directory for this skill:',
    'skill content:',
    '[request interrupted',
    '<command-message>',
    '<command-name>',
    '<local-command-stdout>',
    '<local-command-caveat>',
    '<task-notification>',
)


def is_stream_cutoff_retry(text: str) -> bool:
    stripped = (text or '').strip().lower()
    return stripped.startswith(_CUTOFF_RETRY_PREFIX)


def is_synthetic_user_text(text: str) -> bool:
    stripped = (text or '').strip()
    if not stripped:
        return True
    if '本轮制作要求：' in stripped:
        return False
    lowered = stripped.lower()
    if any(lowered.startswith(prefix) for prefix in _SYNTHETIC_USER_PREFIXES):
        return True
    without_reminders = re.sub(r'<system-reminder>[\s\S]*?</system-reminder>', '', stripped, flags=re.IGNORECASE).strip()
    return not without_reminders


def clean_user_text(text: str) -> tuple[str, bool]:
    had_brief_marker = '本轮制作要求：' in (text or '')
    cleaned = text.split('本轮制作要求：', 1)[1] if had_brief_marker else (text or '')
    cleaned = re.sub(r'<system-reminder>[\s\S]*?</system-reminder>', '', cleaned, flags=re.IGNORECASE).strip()
    if cleaned == '请查看附图。':
        cleaned = ''
    return cleaned, had_brief_marker


def _redact_text(text: str, secrets: tuple[str, ...] = ()) -> str:
    result = (text or '')[:30000]
    for secret in secrets:
        if secret:
            result = result.replace(secret, '[REDACTED]')
    return result


def summarize_tool_input(name: str, tool_input: object, secrets: tuple[str, ...] = ()) -> str | None:
    if not isinstance(tool_input, dict):
        return None
    short_name = (name or '').removeprefix('mcp__arcreel__')
    raw_detail: str | None = None
    if short_name in {'Task', 'Agent'}:
        desc = str(tool_input.get('description') or '').strip()
        subagent = str(tool_input.get('subagent_type') or '').strip()
        raw_detail = desc or subagent or None
    elif short_name in {'create_character', 'create_scene', 'create_prop', 'create_product', 'update_character', 'update_scene', 'update_prop', 'update_product'}:
        target = str(tool_input.get('name') or tool_input.get('character_name') or tool_input.get('scene_name') or '').strip()
        if target:
            raw_detail = target[:24]
    elif short_name in {'generate_videos', 'generate_storyboards', 'generate_reference_videos', 'generate_narration_audio'}:
        ids = (
            tool_input.get('scene_ids')
            or tool_input.get('shot_ids')
            or tool_input.get('unit_ids')
            or ([tool_input['scene_id']] if tool_input.get('scene_id') else None)
            or ([tool_input['unit_id']] if tool_input.get('unit_id') else None)
        )
        if isinstance(ids, list):
            clean_ids = [str(item).strip() for item in ids if str(item).strip() and '/' not in str(item) and '\\' not in str(item)]
            if clean_ids:
                head = ', '.join(clean_ids[:3])
                raw_detail = f'{head} 等 {len(clean_ids)} 项' if len(clean_ids) > 3 else head
    elif short_name == 'generate_assets':
        cats = tool_input.get('categories')
        if isinstance(cats, list) and cats:
            label_map = {'characters': '角色', 'scenes': '场景', 'props': '道具', 'products': '产品'}
            mapped = [label_map.get(str(c), str(c)) for c in cats[:4] if isinstance(c, str)]
            if mapped:
                raw_detail = ' / '.join(mapped)
    if not raw_detail:
        return None
    # Never expose filesystem paths or credentials in tool detail hints.
    if '/' in raw_detail and ('\\' in raw_detail or ':' in raw_detail or raw_detail.startswith('/')):
        return None
    return _redact_text(raw_detail[:48], secrets)


def _format_question_answer_entry(entry: dict, secrets: tuple[str, ...] = ()) -> dict | None:
    answers = entry.get('answers')
    parts: list[str] = []
    if isinstance(answers, dict) and answers:
        for question, answer in answers.items():
            ans = str(answer or '').strip()
            if not ans:
                continue
            q = str(question or '').strip()
            parts.append(f'{q}：{ans}' if len(answers) > 1 and q else ans)
    summary = ' · '.join(parts) if parts else str(entry.get('content') or '').strip()
    if not summary or is_synthetic_user_text(summary):
        return None
    text = _redact_text(f'已确认：{summary}' if parts else summary, secrets)
    return {
        'uuid': entry.get('uuid'),
        'type': 'user',
        'subtype': 'question_answer',
        'rewritable': False,
        'content': [{'type': 'text', 'text': text}],
    }


def _drop_superseded_cutoff_assistant(normalized: list[dict]) -> None:
    """When stream recovery asks the model to rewrite its cut-off response from scratch,
    strip the truncated text from the immediately preceding assistant entry."""
    if not normalized or normalized[-1].get('type') != 'assistant':
        return
    prev = normalized[-1]
    kept_blocks = [b for b in prev.get('content', []) if b.get('type') != 'text']
    if kept_blocks:
        prev['content'] = kept_blocks
    else:
        normalized.pop()


def normalize_session_entries(raw_entries: list[dict], secrets: tuple[str, ...] = ()) -> list[dict]:
    normalized: list[dict] = []
    total = len(raw_entries)
    for idx, entry in enumerate(raw_entries):
        if not isinstance(entry, dict):
            continue
        # Subagent transcripts carry parent_tool_use_id and belong inside subagent execution, not main chat.
        if entry.get('parent_tool_use_id'):
            continue
        entry_type = entry.get('type')
        subtype = entry.get('subtype')

        if entry_type == 'system':
            if subtype == 'agent_turn_failure':
                failure = entry.get('failure') if isinstance(entry.get('failure'), dict) else {}
                msg = str(failure.get('user_message') or failure.get('message') or 'Agent 本轮执行中断，请重试或检查模型连接。').strip()
                normalized.append({
                    'uuid': entry.get('uuid'),
                    'type': 'assistant',
                    'subtype': 'error',
                    'content': [{'type': 'text', 'text': _redact_text(msg[:500], secrets), 'is_error': True}],
                })
            continue

        if entry_type not in {'user', 'assistant'}:
            continue
        if subtype == 'compact_summary' or entry.get('isMeta'):
            continue
        if entry_type == 'user' and subtype == 'question_answer':
            qa_item = _format_question_answer_entry(entry, secrets)
            if qa_item:
                normalized.append(qa_item)
            continue

        raw_content = entry.get('content', [])
        if isinstance(raw_content, str):
            raw_content = [{'type': 'text', 'text': raw_content}]
        if not isinstance(raw_content, list):
            continue

        if entry_type == 'user':
            combined_text = '\n'.join(str(b.get('text', '')) for b in raw_content if isinstance(b, dict) and b.get('type') == 'text')
            if is_stream_cutoff_retry(combined_text):
                has_later_assistant = any(
                    isinstance(later, dict) and not later.get('parent_tool_use_id') and later.get('type') == 'assistant'
                    for later in raw_entries[idx + 1 : total]
                )
                if has_later_assistant:
                    _drop_superseded_cutoff_assistant(normalized)
                continue
            has_images = any(isinstance(b, dict) and b.get('type') == 'image' for b in raw_content)
            if not has_images and is_synthetic_user_text(combined_text):
                continue

        blocks: list[dict] = []
        had_brief_marker = False
        for block in raw_content:
            if not isinstance(block, dict):
                continue
            btype = block.get('type')
            if btype == 'text':
                raw_text = str(block.get('text', ''))
                if entry_type == 'user':
                    if is_synthetic_user_text(raw_text):
                        continue
                    cleaned, had_marker = clean_user_text(raw_text)
                    had_brief_marker = had_brief_marker or had_marker
                    if not cleaned:
                        continue
                    blocks.append({'type': 'text', 'text': _redact_text(cleaned, secrets)})
                else:
                    cleaned_asst = _redact_text(raw_text.strip(), secrets)
                    if cleaned_asst:
                        blocks.append({'type': 'text', 'text': cleaned_asst})
            elif btype == 'tool_use':
                tool_name = str(block.get('name', '')).strip()
                if not tool_name:
                    continue
                tool_block: dict = {'type': 'tool_use', 'name': tool_name}
                detail = summarize_tool_input(tool_name, block.get('input'), secrets)
                if detail:
                    tool_block['detail'] = detail
                blocks.append(tool_block)
            elif btype == 'image':
                url = thumbnail(block.get('source', {}))
                if url:
                    blocks.append({'type': 'image', 'url': url})
            elif btype == 'agent_failure':
                blocks.append({'type': 'text', 'text': 'Agent 本轮执行失败，请检查模型配置或重试。', 'is_error': True})

        if not blocks:
            continue

        item: dict = {'uuid': entry.get('uuid'), 'type': entry_type, 'content': blocks}
        if entry_type == 'user':
            uuid_str = str(entry.get('uuid') or '')
            item['rewritable'] = bool(uuid_str) and (uuid_str.startswith('user-') or had_brief_marker)
        normalized.append(item)

    return normalized
