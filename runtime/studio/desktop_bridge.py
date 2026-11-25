"""HuangGuaAI local studio adapter; no launcher UI, browser, or legacy user data.

The desktop passes bootstrap secrets over stdin. Only nonsecret provider handles
are stored in the engine database; actual credentials live in this process.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import socket
import sys
import time
from windows_compat import install_resume_paths, install_render_paths, install_download_paths
from creative_profile import prepare_profile

install_resume_paths()

bootstrap = json.loads(sys.stdin.readline())
ROOT = Path(bootstrap["root"]).resolve()
DATA = Path(bootstrap["data"]).resolve()
TOKEN = bootstrap["token"]
SESSION = bootstrap["session"]
listener = socket.socket()
listener.bind(("127.0.0.1", 0))
PORT = listener.getsockname()[1]
print(json.dumps({"port": PORT}), flush=True)
sys.stdout = open(os.devnull, "w")
os.chdir(ROOT)
sys.path.insert(0, str(ROOT))
for key in list(os.environ):
    if key.startswith(("ANTHROPIC_", "OPENAI_", "ARCREEL_", "AUTH_")) or key in {"DATABASE_URL", "CLAUDE_CODE_EXECUTABLE", "NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONHOME"}:
        os.environ.pop(key, None)
os.environ.update({
    "ARCREEL_DATA_DIR": str(DATA / "data"), "ARCREEL_PROFILE_DIR": str(prepare_profile(ROOT, DATA, Path(__file__).parent)),
    "ARCREEL_API_BASE": f"http://127.0.0.1:{PORT}/api/v1",
    "CLAUDE_CONFIG_DIR": str(DATA / "claude"), "AUTH_ENABLED": "true",
    "AUTH_TOKEN_SECRET": secrets.token_hex(32), "AUTH_PASSWORD": secrets.token_urlsafe(32),
    "DISABLE_AUTOUPDATER": "1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8",
})
from shot_media import install_ratio_support, install_frame_ratios
from media_staging import install_huanggua_staging, wrap_task_executor
from owned_services import install_owned_services, upstream_route
install_owned_services()
install_ratio_support(ROOT)
install_render_paths()
install_download_paths()
install_frame_ratios()
install_huanggua_staging(ROOT)

import httpx
import uvicorn
from fastapi import Request
from fastapi.responses import JSONResponse, FileResponse
from lib.db import protected_secret

secret_values: dict[str, str] = {}
def store_secret(self, value, dialect):
    if not value:
        return ""
    handle = "desktop-memory:" + hashlib.sha256(value.encode()).hexdigest()
    secret_values[handle] = value
    return handle
def read_secret(self, value, dialect):
    return secret_values.get(value, "")
protected_secret.ProtectedCredential.process_bind_param = store_secret
protected_secret.ProtectedCredential.process_result_value = read_secret

from server.app import app
import server.app as engine_app
from account_worker import AccountBoundGenerationWorker
from server.auth import create_token, verify_token
from server.routers.huanggua_agent import router as model_bridge
from server.routers.assistant import get_assistant_service
from lib.infra.data_root_layout import DataRootLayout

app.title = "HuangGuaAI Studio"
app.description = "黄瓜 AI 短剧工作区"
app.include_router(model_bridge, prefix="/huanggua-agent")
engine_app.create_generation_worker = lambda: AccountBoundGenerationWorker(
    executor=wrap_task_executor(engine_app.execute_generation_task), resume_executor=engine_app.execute_resume_video_task)
account_lock = asyncio.Lock()
account_checked = 0.0
account_fingerprint = ""
models: dict[str, list[str]] = {}
model_refs: dict[str, dict[str, str]] = {}
artifact_paths: dict[tuple[str, str], Path] = {}
artifact_pages: dict[str, tuple[str, list[dict]]] = {}
file_hashes: dict[str, tuple[int, int, str]] = {}
run_locks: dict[str, asyncio.Lock] = {}

@app.middleware("http")
async def desktop_boundary(request: Request, call_next):
    if not request.client or request.client.host not in {"127.0.0.1", "::1"}:
        return JSONResponse({"error": "studio_access_denied"}, status_code=403)
    path = request.url.path
    if upstream_route(path):
        return JSONResponse({"error": "studio_upstream_service_disabled"}, status_code=403)
    if path.startswith("/desktop/"):
        if request.headers.get("origin") or not hmac.compare_digest(request.headers.get("authorization", ""), "Bearer " + TOKEN):
            return JSONResponse({"error": "studio_access_denied"}, status_code=403)
    elif path.startswith("/huanggua-agent/"):
        pass  # Project-scoped model bridge validates its own current model key.
    elif path.startswith("/api/v1/"):
        if not verify_token(request.headers.get("authorization", "").removeprefix("Bearer ")):
            return JSONResponse({"error": "studio_access_denied"}, status_code=403)
    else:
        return JSONResponse({"error": "studio_access_denied"}, status_code=403)
    if path.startswith("/desktop/"):
        try:
            length = int(request.headers.get("content-length", "0"))
            if length < 0:
                raise ValueError()
        except ValueError:
            return JSONResponse({"error": "studio_invalid_request"}, status_code=400)
        if length > 2_000_000:
            return JSONResponse({"error": "studio_request_too_large"}, status_code=413)
    try:
        return await call_next(request)
    except Exception:
        # Never return raw exceptions, provider bodies, paths or request secrets.
        return JSONResponse({"error": "studio_execution_failed"}, status_code=500)

def local_client():
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=f"http://127.0.0.1:{PORT}/api/v1/",
                            headers={"Authorization": "Bearer " + create_token("admin"), "Accept-Language": "zh-CN"}, timeout=None)

async def checked(client, method, path, payload=None):
    response = await client.request(method, path, json=payload)
    if not response.is_success:
        if response.status_code == 409 and 'script-edits' in path:
            raise ValueError("studio_edit_conflict")
        raise ValueError("studio_engine_rejected")
    return response.json() if response.content else {}

async def connect_account():
    global account_checked, account_fingerprint, models, model_refs
    async with account_lock:
        if time.monotonic() - account_checked < 40:
            return
        try:
            async with httpx.AsyncClient(timeout=20, trust_env=False) as remote:
                response = await remote.get("https://huanggua.my/api/arcreel/account", headers={"Authorization": "Bearer " + SESSION})
                response.raise_for_status()
                envelope = response.json()
            account = envelope["data"]
            if envelope.get("success") is not True or account["expires_at"] <= time.time():
                raise ValueError("expired")
            services = account["services"]
            fingerprint = hashlib.sha256(json.dumps(services, sort_keys=True).encode()).hexdigest()
            if fingerprint != account_fingerprint:
                await configure_models(services)
                account_fingerprint = fingerprint
            await app.state.generation_worker.start_authorized()
            account_checked = time.monotonic()
        except Exception:
            secret_values.clear()
            models, model_refs = {}, {}
            account_fingerprint = ""
            raise ValueError("studio_login_required") from None

def is_account_bound_key(category, value):
    if category not in ("text", "image", "video") or not isinstance(value, str):
        return False
    return bool(re.fullmatch(rf"sk-ad1\.[0-9a-f]{{64}}\.{category}\.[0-9a-f]{{64}}", value))


async def configure_models(services):
    global models, model_refs
    preset = json.loads((ROOT / "huanggua-models.json").read_text(encoding="utf-8"))["models"]
    available, refs = {}, {}
    async with local_client() as client:
        providers = (await checked(client, "GET", "custom-providers"))["providers"]
        defaults = {}
        for category in ("text", "image", "video"):
            service = services.get(category, {})
            if service.get("status") != "connected":
                continue
            if service.get("base_url") != "https://huanggua.my" or not is_account_bound_key(category, service.get("api_key", "")):
                raise ValueError("invalid account")
            allowed = service["models"]
            if not isinstance(allowed, list) or len(allowed) > 5000 or any(not isinstance(m,str) or len(m)>300 for m in allowed):
                raise ValueError("invalid models")
            if category == "text":
                text_models = [m for m in allowed if m.startswith("gpt-") and not any(x in m for x in ("image", "audio", "realtime"))]
                items = [{"model_id": m, "display_name": m, "endpoint": "openai-responses", "is_default": i == 0,
                          "capability_overrides": {"image_input": True, "structured_output": True}}
                         for i, m in enumerate(text_models)]
            else:
                endpoint = "huanggua-images" if category == "image" else "huanggua-video"
                items = [dict(m) for m in preset if m["model_id"] in allowed and m["endpoint"] == endpoint]
            if not items:
                continue
            if not any(m.get("is_default") for m in items):
                items[0]["is_default"] = True
            name = "黄瓜客户端 · " + category
            old = next((p for p in providers if p["display_name"] == name), None)
            body = {"display_name": name, "base_url": "https://huanggua.my/v1" if category == "text" else "https://huanggua.my",
                    "api_key": service["api_key"], "models": items, "image_max_workers": 1, "video_max_workers": 1}
            provider = await checked(client, "PUT" if old else "POST", f"custom-providers/{old['id']}" if old else "custom-providers",
                                     body if old else {**body, "discovery_format": "openai"})
            refs[category] = {m["model_id"]: f"custom-{provider['id']}/{m['model_id']}" for m in items}
            available[category] = list(refs[category])
            selected = next(m for m in items if m.get("is_default"))
            ref = refs[category][selected["model_id"]]
            if category == "text":
                defaults.update(default_text_backend=ref, text_backend_simple=ref, text_backend_complex=ref)
                credentials = (await checked(client, "GET", "agent/credentials"))["credentials"]
                old_credential = next((c for c in credentials if c["display_name"] == "黄瓜客户端 Agent"), None)
                model = selected["model_id"]
                credential = {"display_name": "黄瓜客户端 Agent", "api_key": service["api_key"], "base_url": f"http://127.0.0.1:{PORT}/huanggua-agent",
                              "model": model, "haiku_model": model, "sonnet_model": model, "opus_model": model, "subagent_model": model}
                if old_credential:
                    cred = await checked(client, "PATCH", f"agent/credentials/{old_credential['id']}", credential)
                    await checked(client, "POST", f"agent/credentials/{cred['id']}/activate")
                else:
                    await checked(client, "POST", "agent/credentials", {**credential, "preset_id": "__custom__", "activate": True})
            elif category == "image":
                defaults.update(default_image_backend=ref, default_image_backend_t2i=ref, default_image_backend_i2i=ref)
            else:
                defaults.update(default_video_backend=ref, default_video_backend_i2v=ref, default_video_backend_r2v=ref)
        if "text" not in refs:
            raise ValueError("no supported text model")
        await checked(client, "PATCH", "system/config", defaults)
    models, model_refs = available, refs

def project_name(body, *, allow_deleted=False):
    from project_scope import resolve_scope, legacy_name
    name, number, _, mapping = resolve_scope(DATA, DataRootLayout.current().projects_dir, body)
    if mapping.get('deleted') and not allow_deleted:
        raise ValueError('studio_invalid_project')
    body['_source_projects'] = mapping.get('merged_sources', [])
    body['_episode'] = number
    body['_binding'] = legacy_name(body['projectId'], body['episodeId'])
    body['_data_root'] = DATA
    return name

def binding_path(project):
    folder = DATA / "bindings"
    folder.mkdir(exist_ok=True)
    return folder / (project + ".json")

async def delete_studio_project(name, body, client):
    from project_scope import resolve_scope, save_scope
    from workspace_api import uploads
    _, _, path, mapping = resolve_scope(DATA, DataRootLayout.current().projects_dir, body)
    if mapping.get('deleted'):
        return {'ok': True}
    # Active agents can still write files, so require the user to stop them first.
    service = get_assistant_service()
    if await service.list_sessions(project_name=name, status='running', limit=1):
        raise ValueError('studio_session_busy')
    response = await client.delete(f'projects/{name}')
    if not response.is_success and response.status_code != 404:
        raise ValueError('studio_engine_rejected')
    # Keep the stable mapping, including merged legacy sources. A persistent
    # tombstone blocks late requests and makes a lost deletion response retryable.
    save_scope(path, {**mapping, 'deleted': True})
    for key, entry in list(uploads.items()):
        if entry.get('project') == name:
            entry['file'].close()
            uploads.pop(key, None)
    return {'ok': True}

def read_binding(project):
    try:
        return json.loads(binding_path(project).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}

def write_binding(project, value):
    path = binding_path(project)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value), encoding="utf-8")
    temp.replace(path)

def artifacts(project):
    root = (DataRootLayout.current().projects_dir / project).resolve()
    rows = []
    kinds = {"png":"image", "jpg":"image", "jpeg":"image", "webp":"image", "mp4":"video", "mov":"video", "m4v":"video", "webm":"video", "wav":"audio", "mp3":"audio", "m4a":"audio", "ogg":"audio", "txt":"text", "md":"text", "json":"text"}
    kinds.update(zip="file", srt="text", vtt="text", pdf="file", docx="file", epub="file")
    def _record_file(path: Path):
        ext = path.suffix.lower().lstrip(".")
        if ext not in kinds or not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(root) or any(p.startswith(".") for p in path.relative_to(root).parts):
            return
        stat = path.stat()
        if not 0 < stat.st_size <= 1024**3:
            return
        previous = file_hashes.get(str(path))
        if previous and previous[:2] == (stat.st_mtime_ns, stat.st_size):
            digest = previous[2]
        else:
            with path.open("rb") as handle:
                digest = hashlib.file_digest(handle, "sha256").hexdigest()
            file_hashes[str(path)] = (stat.st_mtime_ns, stat.st_size, digest)
        artifact_paths[(project, digest)] = path
        rows.append({"id": digest, "name": path.relative_to(root).as_posix(), "kind": kinds[ext], "size": stat.st_size})
    style_path = root / "style_reference.png"
    if style_path.is_file():
        _record_file(style_path)
    for folder in ("characters", "scenes", "props", "products", "storyboards", "end_frames", "grids", "videos", "reference_videos", "uploads", "audio", "bgm", "renders", "source", "output", "scripts", "subtitles", "presentations", "versions"):
        directory = root / folder
        if not directory.is_dir() or directory.is_symlink():
            continue
        for path in directory.rglob("*"):
            ext = path.suffix.lower().lstrip(".")
            if folder == 'renders' and path.name.endswith('.render.json'):
                continue  # Engine bookkeeping is not a user resource.
            if folder == 'versions' and ext not in {'png', 'jpg', 'jpeg', 'webp', 'mp4', 'mov', 'm4v', 'webm', 'wav', 'mp3'}:
                continue
            _record_file(path)
    return rows

def artifact_page(binding: str, rows: list[dict]) -> dict:
    """Keep a stable snapshot across bounded responses; one snapshot per episode."""
    import uuid
    page, remaining = rows[:200], rows[200:]
    cursor = uuid.uuid4().hex if remaining else None
    if cursor:
        artifact_pages[binding] = (cursor, remaining)
    else:
        artifact_pages.pop(binding, None)
    return {"artifacts": page, "artifactCursor": cursor}


@app.post("/desktop/{operation}")
async def desktop_operation(operation: str, request: Request):
    body = await request.json()
    try:
        if operation == "status":
            await connect_account()
            return {"ready": True, "models": models, "videoModelsByMode": {
                mode: [m['model_id'] for m in compatible_video_models(mode)]
                for mode in ('storyboard', 'reference_video')
            }}
        if operation == 'workspace' and body.get('action') in {'legacy_preview', 'legacy_merge'}:
            from legacy_merge import merge_workspace, inventory
            from contextlib import AsyncExitStack
            # Serializes migrations and normal bridge requests; engine active work
            # is independently checked before staging and source hashes before commit.
            async with run_locks.setdefault('desktop-legacy-merge', asyncio.Lock()):
                preview, _, _ = await asyncio.to_thread(inventory, DATA, DataRootLayout.current().projects_dir, body)
                async with AsyncExitStack() as stack:
                    for source in sorted(preview['sources'], key=lambda s: s['name']):
                        await stack.enter_async_context(run_locks.setdefault(source['name'], asyncio.Lock()))
                    scope_path = DATA / 'project-scopes' / (body['projectId'] + '.json')
                    if scope_path.exists() and json.loads(scope_path.read_text(encoding='utf-8')).get('deleted'):
                        raise ValueError('studio_invalid_project')
                    async with local_client() as client:
                        return await merge_workspace(DATA, DataRootLayout.current().projects_dir, body, client, get_assistant_service())
        deleting = operation == 'workspace' and body.get('action') == 'project_delete'
        name = project_name(body, allow_deleted=deleting)
        if operation == "run":
            await connect_account()
            async with run_locks.setdefault(name, asyncio.Lock()):
                if project_name(body) != name:
                    raise ValueError('studio_edit_conflict')
                return await run_episode(name, body)
        if operation == "workspace":
            from workspace_api import workspace
            async with run_locks.setdefault(name, asyncio.Lock()):
                if project_name(body, allow_deleted=deleting) != name:
                    raise ValueError('studio_edit_conflict')
                if deleting:
                    async with local_client() as client:
                        return await delete_studio_project(name, body, client)
                if body.get('action') == 'message_attachments':
                    from conversation_api import is_synthetic_user_text, queued_display
                    session = read_binding(body['_binding']).get('session_id')
                    service = get_assistant_service()
                    meta = await service.get_session(session) if session else None
                    if not meta or meta.project_name != name:
                        raise ValueError('studio_invalid_session')
                    entries = (await service.list_session_entries(session))['entries']
                    entry = next(
                        (
                            e for e in entries
                            if e.get('uuid') == body.get('id')
                            and e.get('type') == 'user'
                            and not e.get('parent_tool_use_id')
                            and e.get('subtype') not in {'compact_summary', 'question_answer'}
                        ),
                        None,
                    )
                    if not entry:
                        raise ValueError('studio_invalid_request')
                    displayed = queued_display(DATA, body['_binding'], {**entry, 'id': entry['uuid']})
                    if not displayed.get('attachments') and is_synthetic_user_text(displayed.get('text', '')):
                        raise ValueError('studio_invalid_request')
                    return displayed
                if body.get("action") == "initialize":
                    await connect_account()
                    await ensure_project(name, body)
                    return {"ok": True}
                if body.get("action") in {"plan_generate", "prompts_generate", "timeline_render", "timeline_draft", 'queue_resend', 'queue_now', 'ad_generate', 'reference_generate', 'reference_batch', 'reference_precheck', 'reference_batch_preview', 'shot_precheck', 'shot_generate', 'shot_recover'}:
                    await connect_account()
                    if body.get('action') in {'plan_generate', 'prompts_generate', 'ad_generate', 'reference_generate', 'reference_batch', 'reference_precheck', 'reference_batch_preview', 'shot_precheck', 'shot_generate', 'shot_recover'}:
                        await ensure_project(name, body)
                async with local_client() as client:
                    return await workspace(name, body, client, checked, get_assistant_service(),
                                           lambda _: read_binding(body['_binding']), lambda _, v: write_binding(body['_binding'], v))
        binding = read_binding(body['_binding'])
        session_id = binding.get("session_id")
        service = get_assistant_service()
        if operation == "poll":
            cursor = body.get('artifactCursor')
            if cursor is not None:
                saved = artifact_pages.get(body['_binding'])
                if not saved or not isinstance(cursor, str) or cursor != saved[0]:
                    raise ValueError('studio_artifact_cursor_expired')
                return artifact_page(body['_binding'], saved[1])
            from conversation_api import normalize_session_entries, queued_display
            result = await service.list_session_entries(session_id) if session_id else {"status":"idle", "entries":[], "draft":None}
            meta = await service.get_session(session_id) if session_id else None
            result['supersededBy'] = ('legacy-archive' if meta.project_name != name else meta.superseded_by) if meta else None
            limit = body.get('historyLimit', 100)
            if type(limit) is not int or not 1 <= limit <= 1000:
                raise ValueError('studio_invalid_request')
            redactions = (SESSION, TOKEN, *secret_values.values())
            clean_entries = normalize_session_entries(result.get("entries", []), redactions)
            result['hasOlder'] = len(clean_entries) > limit
            result["entries"] = clean_entries[-limit:]
            draft = result.get("draft")
            if isinstance(draft, dict):
                if draft.get("parent_tool_use_id"):
                    result["draft"] = None
                elif isinstance(draft.get("content"), list):
                    draft_blocks = []
                    for block in draft["content"]:
                        if isinstance(block, dict) and block.get("type") == "text":
                            txt = str(block.get("text") or "")[:30000]
                            for secret in redactions:
                                if secret:
                                    txt = txt.replace(secret, "[REDACTED]")
                            if txt.strip():
                                draft_blocks.append({"type": "text", "text": txt})
                    result["draft"] = {"content": draft_blocks} if draft_blocks else None
            result["questions"] = await service.session_manager.get_pending_questions_snapshot(session_id) if session_id else []
            result['queued'] = [queued_display(DATA, body['_binding'], q) for q in service.session_manager.get_queued_messages_snapshot(session_id)] if session_id else []
            async with local_client() as client:
                tasks = await checked(client, "GET", f"projects/{name}/tasks?page_size=100") if (DataRootLayout.current().projects_dir / name / "project.json").is_file() else {"items":[]}
                timeline_episodes = {}
                if any(t.get('payload', {}).get('timeline_id') for t in tasks.get('items', [])):
                    timelines = await checked(client, 'GET', f'projects/{name}/edit-timelines')
                    timeline_episodes = {t['id']: t['episode'] for t in timelines.get('timelines', [])}
            # Return only display fields, never task credentials/payload or native paths.
            from lib.episode.episode_ids import episode_ids_in_record
            scoped_tasks = []
            for task in tasks.get('items', []):
                episode_ids = episode_ids_in_record(task)
                timeline_episode = timeline_episodes.get(task.get('payload', {}).get('timeline_id'))
                if timeline_episode:
                    episode_ids.add(timeline_episode)
                if not episode_ids or body['_episode'] in episode_ids:
                    scoped_tasks.append(task)
            result["tasks"] = [{k:t.get(k) for k in ("task_id", "task_type", "status", "resource_id", "progress")} for t in scoped_tasks]
            result["artifacts"] = await asyncio.to_thread(artifacts, name)
            # Shared assets are project-wide; only the selected episode's formal script
            # is exposed as the editable script. Never fall back to another episode.
            from lib.project.project_manager import get_project_manager
            pm = get_project_manager()
            detail = pm.load_project(name) if pm.project_exists(name) else {}
            selected = next((e for e in detail.get('episodes', []) if e.get('episode') == body['_episode']), {})
            script = selected.get('script_file', '')
            if script and not script.startswith('scripts/'):
                script = 'scripts/' + script
            result['artifacts'] = [a for a in result['artifacts'] if not (a['name'].startswith('scripts/') and a['name'].endswith('.json')) or a['name'] == script]
            result.update(artifact_page(body['_binding'], result['artifacts']))
            from media_staging import reference_warnings
            result['referenceWarnings'] = reference_warnings(name)
            result['episodeNumber'] = body['_episode']
            result["project"] = name
            result["sessionId"] = session_id
            result["uncertain"] = bool(binding.get("pending"))
            return result
        if not session_id:
            raise ValueError("studio_session_missing")
        if operation == "interrupt":
            return await service.interrupt_session(session_id)
        if operation == "answer":
            return await service.answer_user_question(session_id, body["questionId"], body["answers"])
        if operation == "cancel_task":
            async with local_client() as client:
                task = await checked(client, "GET", f"tasks/{body['taskId']}")
                if task.get("project_name") != name:
                    raise ValueError("studio_invalid_task")
                return await checked(client, "POST", f"tasks/{body['taskId']}/cancel")
        raise ValueError("studio_operation_denied")
    except OSError:
        return JSONResponse({'error': 'studio_project_storage_unavailable'}, status_code=409)
    except Exception as exc:
        message = str(exc)
        return JSONResponse({"error": message if re.fullmatch(r"studio_[a-z_]+", message) else "studio_execution_failed"}, status_code=409)

def display_entry(entry):
    from conversation_api import normalize_session_entries
    items = normalize_session_entries([entry], (SESSION, TOKEN, *secret_values.values()))
    return items[0] if items else {"uuid": entry.get("uuid"), "type": entry.get("type"), "content": []}

async def run_episode(name, body):
    binding_key = body['_binding']
    binding = read_binding(binding_key)
    client_key = body.get("requestId", "")
    if not re.fullmatch(r"[a-f0-9-]{36}", client_key):
        raise ValueError("studio_invalid_request")
    if binding.get("lastRequest") == client_key:
        return {"session_id":binding["session_id"], "project":name, "status":"accepted"}
    content = body.get("content", "").strip()
    if not content or len(content) > 300000:
        raise ValueError("studio_invalid_content")
    if binding.get("pending") and binding["pending"] != client_key:
        raise ValueError("studio_submission_uncertain")
    service = get_assistant_service()
    session_id = binding.get("session_id")
    meta = await service.get_session(session_id) if session_id else None
    if meta and meta.project_name != name:
        raise ValueError('studio_session_superseded')
    if meta and meta.superseded_by and not (binding.get('pending') == client_key and body.get('rewriteAnchor')):
        raise ValueError('studio_session_superseded')
    try:
        await ensure_project(name, body)
    except ValueError as exc:
        # Only a request that never reached the engine can be safely released.
        # An earlier attempt with this key may already have been accepted.
        if str(exc) in {'studio_video_model_incompatible', 'studio_model_unavailable', 'studio_style_required'} and not binding.get('pending'):
            return {'status': 'rejected', 'error': str(exc), 'requestId': client_key}
        raise
    from conversation_api import describe_local_attachments, load_images
    images = load_images(DATA, binding_key, body.get('attachments', []))
    local_media_note = describe_local_attachments(DATA, binding_key, body.get('attachments', []))
    content = (f"当前分集正式编号：{body['_episode']}。仅编辑这一集的脚本与时间线，角色、场景、道具为全剧共享。\n"
               "先读取项目内容类型。广告项目沿用广告 brief 到正式脚本的专用流程；以下原创原文路径仅用于短剧。"
               "本地客户端已提供 original-story Skill 与 write-original-story 子智能体。若短剧用户要求从创意写故事/剧本，"
               "先使用该 Skill 创作并通过 edit_source_text 登记当前集原文，再以 generate_script_plan 拆分镜；"
               "episode_source_missing 不表示不能原创。已有故事、规划或正式脚本请读取后接续，不覆盖或重复创建。\n\n") + local_media_note + content
    binding["pending"] = client_key
    write_binding(binding_key, binding)
    if body.get('rewriteAnchor'):
        response = await service.rewrite_message(name, session_id, anchor_entry_uuid=body['rewriteAnchor'], content=content, images=images, locale='zh-CN', client_key=client_key)
    else:
        response = await service.send_or_create(name, content, session_id=session_id, images=images, locale="zh-CN", client_key=client_key)
    sessions = list(dict.fromkeys([*binding.get('sessions', []), *([session_id] if session_id else []), response['session_id']]))
    titles = dict(binding.get('titles', {}))
    titles.setdefault(response['session_id'], content.split('本轮制作要求：', 1)[-1].strip()[:60])
    write_binding(binding_key, {"session_id": response["session_id"], "lastRequest":client_key, 'sessions': sessions, 'titles': titles})
    return {"session_id":response["session_id"], "project":name, "status":"accepted"}

def compatible_video_models(mode):
    preset = json.loads((ROOT / 'huanggua-models.json').read_text(encoding='utf-8'))['models']
    return [m for m in preset if m['model_id'] in model_refs.get('video', {}) and (
        m.get('capability_overrides', {}).get('max_reference_images', 0) > 0
        if mode == 'reference_video' else m.get('capability_overrides', {}).get('first_frame'))]


async def ensure_project(name, body):
    selection = body.get("models", {})
    if any(value and value not in model_refs.get(kind, {}) for kind, value in selection.items()):
        raise ValueError('studio_model_unavailable')
    selected_refs = {kind: model_refs[kind][selection.get(kind) or models[kind][0]] for kind in models}
    if 'video' in models:
        preset = json.loads((ROOT / 'huanggua-models.json').read_text(encoding='utf-8'))['models']
        compatible = compatible_video_models(body.get('generationMode', 'storyboard'))
        requested = selection.get('video')
        chosen = next((m for m in compatible if m['model_id'] == requested), None) if requested else next((m for m in compatible if m.get('is_default')), compatible[0] if compatible else None)
        if not chosen:
            raise ValueError('studio_video_model_incompatible')
        selected_refs['video'] = model_refs['video'][chosen['model_id']]
    config = {"default_text_backend":selected_refs["text"], "text_backend_simple":selected_refs["text"], "text_backend_complex":selected_refs["text"]}
    if "image" in selected_refs:
        config.update(default_image_backend=selected_refs["image"], image_provider_t2i=selected_refs["image"], image_provider_i2i=selected_refs["image"])
    if "video" in selected_refs:
        config.update(video_backend=selected_refs["video"], video_provider_i2v=selected_refs["video"], video_provider_r2v=selected_refs["video"])
        if body.get('generationMode') == 'reference_video' and not chosen.get('capability_overrides', {}).get('first_frame'):
            fallback = next((m for m in preset if m['model_id'] in model_refs['video'] and m.get('capability_overrides', {}).get('first_frame')), None)
            if fallback:
                config['video_provider_i2v'] = model_refs['video'][fallback['model_id']]
    style_tpl = body.get('styleTemplateId') if isinstance(body.get('styleTemplateId'), str) and body.get('styleTemplateId') else None
    from shot_media import CUSTOM_RESOLUTION_FIELD, is_valid_studio_ratio, normalize_custom_resolution
    init_ratio = body.get('aspectRatio') if is_valid_studio_ratio(body.get('aspectRatio')) else None
    async with local_client() as client:
        existing = await client.get(f"projects/{name}")
        if existing.status_code == 404:
            content, generation = body.get('contentMode', 'drama'), body.get('generationMode', 'storyboard')
            if content not in {'drama', 'ad'} or generation not in {'storyboard', 'reference_video'}:
                raise ValueError('studio_invalid_request')
            await checked(client, "POST", "projects", {
                "name": name,
                "title": body["title"][:100],
                "content_mode": content,
                "generation_mode": generation,
                **({"style_template_id": style_tpl} if style_tpl else {}),
                **({"aspect_ratio": init_ratio} if init_ratio else {}),
                **config,
            })
            if body.get('customResolution') is not None:
                norm_res = normalize_custom_resolution(body.get('customResolution'))
                if norm_res:
                    from lib.project.project_manager import get_project_manager
                    from lib.infra.async_thread import run_sync_transaction
                    pm = get_project_manager()
                    await run_sync_transaction(lambda: pm.update_project(name, lambda p: p.__setitem__(CUSTOM_RESOLUTION_FIELD, norm_res)))
        elif not existing.is_success:
            raise ValueError("studio_project_unavailable")
        else:
            current_proj = (existing.json() or {}).get("project") or {}
            has_style = bool(current_proj.get("style_template_id") or (current_proj.get("style") or "").strip() or current_proj.get("style_image"))
            patch_body = {**config, **({"style_template_id": style_tpl} if (not has_style and style_tpl) else {})}
            await checked(client, "PATCH", f"projects/{name}", patch_body)
        from project_scope import ensure_episode
        await ensure_episode(body, client, checked)
    if body.get("action") != "initialize":
        from lib.project.project_manager import get_project_manager
        from lib.infra.async_thread import run_sync_transaction
        pm = get_project_manager()
        proj = await asyncio.to_thread(pm.load_project, name)
        if not (proj.get("style_template_id") or (proj.get("style") or "").strip() or proj.get("style_image")):
            raise ValueError("studio_style_required")
        if proj.get("style_image") and not (proj.get("style_description") or "").strip():
            style_file = pm.get_project_path(name) / str(proj["style_image"])
            if style_file.is_file():
                try:
                    from lib.backends.providers import CallPurpose
                    from lib.backends.text_backends.base import ImageInput, TextGenerationRequest, TextTaskType
                    from lib.backends.text_generator import TextGenerator
                    from lib.prompts.prompt_templates.builtin import builtin_templates
                    generator = await TextGenerator.create(TextTaskType.STYLE_ANALYSIS, name, purpose=CallPurpose.STYLE_ANALYSIS)
                    analyzed = await generator.generate(
                        TextGenerationRequest(prompt=builtin_templates.render("text/style_analysis"), images=[ImageInput(path=style_file)]),
                        project_name=name,
                    )
                    if analyzed.text and analyzed.text.strip():
                        await run_sync_transaction(lambda: pm.update_project(name, lambda p: p.__setitem__("style_description", analyzed.text.strip())))
                except Exception:
                    pass

@app.get("/desktop/artifact/{project}/{artifact}")
async def read_artifact(project: str, artifact: str):
    path = artifact_paths.get((project, artifact))
    root = (DataRootLayout.current().projects_dir / project).resolve()
    if not path or path.is_symlink() or not path.resolve().is_relative_to(root):
        return JSONResponse({"error":"studio_invalid_artifact"}, status_code=404)
    def current_digest():
        with path.open("rb") as stream:
            return hashlib.file_digest(stream, "sha256").hexdigest()
    try:
        if await asyncio.to_thread(current_digest) != artifact:
            return JSONResponse({"error":"studio_artifact_changed"}, status_code=409)
    except OSError:
        return JSONResponse({"error":"studio_invalid_artifact"}, status_code=404)
    return FileResponse(path, headers={"x-studio-extension":path.suffix.lower().lstrip(".")})

uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=PORT, access_log=False, log_level="error")).run(sockets=[listener])
