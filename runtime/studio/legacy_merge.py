"""Copy-on-merge migration. Sources stay immutable; the scope pointer commits last."""
import asyncio
import hashlib
import json
import re
import shutil
import tempfile
import unicodedata
from pathlib import Path
from project_scope import legacy_name, save_scope

TABLES = ('characters', 'scenes', 'props', 'products')


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def inventory(data, root, body):
    project, current, ids = body.get('projectId'), body.get('episodeId'), body.get('episodeIds')
    if not isinstance(ids, list) or not 0 < len(ids) <= 1000 or current not in ids or any(not isinstance(x, str) or not re.fullmatch(r'[a-f0-9-]{36}', x) for x in [project, *ids]):
        raise ValueError('studio_invalid_project')
    scope_path = data / 'project-scopes' / (project + '.json')
    mapping = read(scope_path) if scope_path.exists() else {}
    canonical = mapping.get('project')
    names = ([canonical] if canonical and (root / canonical / 'project.json').is_file() else [])
    names += [legacy_name(project, e) for e in ids if legacy_name(project, e) not in names and legacy_name(project, e) not in mapping.get('merged_sources', []) and (root / legacy_name(project, e) / 'project.json').is_file()]
    digest = hashlib.sha256(json.dumps(mapping, sort_keys=True).encode())
    rows, conflicts, seen = [], [], {}
    for index, name in enumerate(names):
        folder = root / name
        files = []
        for path in sorted(folder.rglob('*')):
            if path.is_symlink() or (hasattr(path, 'is_junction') and path.is_junction()):
                raise ValueError('studio_invalid_artifact')
            if not path.is_file() or path.name.endswith('.lock') or path.name == '.last_activity':
                continue
            rel = path.relative_to(folder).as_posix()
            files.append(rel)
            digest.update((name + '/' + rel).encode())
            with path.open('rb') as stream:
                digest.update(hashlib.file_digest(stream, 'sha256').digest())
        detail = read(folder / 'project.json')
        rows.append({'name': name, 'title': detail.get('title', name), 'episodes': len(detail.get('episodes', [])), 'files': len(files)})
        for table in TABLES:
            for asset in detail.get(table, {}):
                # Original engine uses one namespace across asset categories.
                key = unicodedata.normalize('NFC', asset.strip()).casefold()
                if key in seen:
                    source_derivatives = detail[table][asset].get('derivatives', {})
                    target_derivatives = seen[key][2].get('derivatives', {})
                    can_reuse = table == seen[key][0] and all(target_derivatives.get(k) == v for k, v in source_derivatives.items())
                    conflicts.append({'key': f'{index}:{table}:{asset}', 'source': index, 'category': table, 'name': asset, 'targetCategory': seen[key][0], 'target': seen[key][1], 'canReuse': can_reuse, 'suggested': f'{asset}（旧项目{index + 1}）'})
                else:
                    seen[key] = (table, asset, detail[table][asset])
    modes = {(read(root / n / 'project.json').get('content_mode', 'drama'), read(root / n / 'project.json').get('generation_mode', 'storyboard')) for n in names}
    blockers = []
    if len(modes) > 1 or any(mode[0] == 'ad' for mode in modes) and len(names) > 1:
        blockers.append('不同内容类型或制作方式不能合并；广告项目只能保留单集。')
    # A legacy independent project must have an unambiguous desktop episode.
    if any(r['episodes'] != 1 for r in rows if r['name'] != canonical):
        blockers.append('独立旧项目的分集对应不唯一，需先明确对应关系。')
    settings = ('style', 'aspect_ratio', 'video_backend', 'default_image_backend', 'default_text_backend')
    differences = [key for key in settings if len({json.dumps(read(root / n / 'project.json').get(key), sort_keys=True) for n in names}) > 1]
    return {'required': len(names) > 1, 'sources': rows, 'conflicts': conflicts, 'revision': digest.hexdigest(), 'blockers': blockers, 'settings': differences}, mapping, scope_path


def combine(data, root, body, preview, mapping, scope_path):
    from lib.project.project_manager import ProjectManager
    from lib.script.script_structure_validator import validate_script_structure
    from lib.edit_timeline.model import EditTimelineDocument
    choices = body.get('data', {}).get('choices', {})
    if not isinstance(choices, dict) or set(choices) != {c['key'] for c in preview['conflicts']}:
        raise ValueError('studio_merge_choices_required')
    for conflict in preview['conflicts']:
        if choices[conflict['key']] not in {'keep_both', 'reuse'} or (choices[conflict['key']] == 'reuse' and not conflict['canReuse']):
            raise ValueError('studio_invalid_request')
    # Stable destination makes retries after a process interruption harmless.
    target = 'studio-' + hashlib.sha256((body['projectId'] + preview['revision'] + json.dumps(choices, sort_keys=True)).encode()).hexdigest()[:32]
    new_mapping = {'project': target, 'primary': mapping.get('primary', body['episodeIds'][0]), 'episodes': {}, 'merged_sources': list(dict.fromkeys(mapping.get('merged_sources', []) + [r['name'] for r in preview['sources']]))}
    merged = None
    all_versions = {}
    next_episode = 1
    with tempfile.TemporaryDirectory(prefix='studio-merge-', dir=data) as temporary:
        scratch = Path(temporary)
        manager = ProjectManager(str(scratch))
        destination = scratch / 'result'
        destination.mkdir()
        for index, source in enumerate(preview['sources']):
            name = source['name']
            copied = manager.layout.projects_dir / name
            shutil.copytree(root / name, copied, ignore=shutil.ignore_patterns('*.lock', '.last_activity'))
            reuse = set()
            reuse_renames = []
            for conflict in [c for c in preview['conflicts'] if c['source'] == index]:
                if choices[conflict['key']] == 'keep_both':
                    # Engine cascades mentions, speakers, derivatives, image paths and versions.
                    renamed = conflict['suggested']
                    detail = read(copied / 'project.json')
                    while any(renamed in detail.get(t, {}) or merged and renamed in merged.get(t, {}) for t in TABLES):
                        renamed += '副本'
                    manager.rename_asset(name, conflict['category'], conflict['name'], renamed)
                else:
                    reuse.add((conflict['category'], conflict['name']))
                    reuse_renames.append((conflict['category'], conflict['name'], conflict['target']))
            detail = read(copied / 'project.json')
            ep_map = {}
            for episode in detail.get('episodes', []):
                old = episode['episode']; ep_map[old] = next_episode; next_episode += 1
                if name == mapping.get('project'):
                    for identity, number in mapping.get('episodes', {}).items():
                        if number == old:
                            new_mapping['episodes'][identity] = ep_map[old]
                else:
                    identity = next(e for e in body['episodeIds'] if legacy_name(body['projectId'], e) == name)
                    new_mapping['episodes'][identity] = ep_map[old]
            def renumber(value):
                value = re.sub(r'(?<![A-Za-z0-9])E(\d+)(?=[SUG]\d)', lambda m: 'E' + str(ep_map.get(int(m[1]), int(m[1]))), value)
                return re.sub(r'episode_(\d+)(?!\d)', lambda m: 'episode_' + str(ep_map.get(int(m[1]), int(m[1]))), value)
            paths = {}
            occupied = {p.relative_to(destination).as_posix().casefold() for p in destination.rglob('*') if p.is_file()}
            for file in copied.rglob('*'):
                if not file.is_file() or file.name.endswith('.lock'):
                    continue
                relative = file.relative_to(copied).as_posix()
                renamed = renumber(relative)
                if renamed.casefold() in occupied and relative not in {'project.json', 'versions/versions.json'}:
                    part = Path(renamed)
                    renamed = (part.parent / f'legacy-{index + 1}-{part.name}').as_posix()
                    counter = 1
                    while renamed.casefold() in occupied:
                        counter += 1
                        renamed = (part.parent / f'legacy-{index + 1}-{counter}-{part.name}').as_posix()
                paths[relative] = renamed
                occupied.add(renamed.casefold())
            def transform(value, field=''):
                if isinstance(value, dict):
                    return {renumber(k): transform(v, k) for k, v in value.items()}
                if isinstance(value, list):
                    return [transform(v, field) for v in value]
                if type(value) is int and field in {'episode', 'episode_id', 'episode_number'}:
                    return ep_map.get(value, value)
                if isinstance(value, str):
                    if value in paths:
                        return paths[value]
                    return renumber(value)
                return value
            # Dropped reused sheets and histories remain available in the source backup.
            for table, asset in reuse:
                detail.get(table, {}).pop(asset, None)
            detail = transform(detail)
            if merged is None:
                merged = detail
            else:
                merged['episodes'].extend(detail.get('episodes', []))
                for table in TABLES:
                    merged.setdefault(table, {}).update(detail.get(table, {}))
                merged.setdefault('whole_source_files', []).extend(detail.get('whole_source_files', []))
            versions_path = copied / 'versions/versions.json'
            if versions_path.exists():
                versions = transform(read(versions_path))
                for table, records in versions.items():
                    for asset, record in records.items():
                        if (table, asset) not in reuse and not (table == 'character_derivatives' and any(t == 'characters' and asset.startswith(a + '/') for t, a in reuse)):
                            if asset in all_versions.get(table, {}) and all_versions[table][asset] != record:
                                raise ValueError('studio_merge_history_conflict')
                            all_versions.setdefault(table, {})[asset] = record
            for relative, new_relative in paths.items():
                if relative in {'project.json', 'versions/versions.json'} or relative.startswith(('.claude/', '.arcreel/')) or relative.startswith('.') or relative == 'CLAUDE.md':
                    continue
                src, dst = copied / relative, destination / new_relative
                dst.parent.mkdir(parents=True, exist_ok=True)
                if src.suffix == '.json':
                    value = read(src)
                    from lib.project.asset_rename import rewrite_payload_references
                    for table, old_name, new_name in reuse_renames:
                        rewrite_payload_references(value, {'characters': 'character', 'scenes': 'scene', 'props': 'prop', 'products': 'product'}[table], old_name, new_name)
                    value = transform(value)
                    if relative.startswith('scripts/') and ('scenes' in value or 'shots' in value or 'video_units' in value):
                        if not validate_script_structure(value).valid:
                            raise ValueError('studio_merge_invalid_script')
                    if relative.startswith('edit_timelines/') and re.fullmatch(r'tl-[a-f0-9]{8}\.json', src.name):
                        EditTimelineDocument.model_validate(value)
                    write(dst, value)
                else:
                    shutil.copy2(src, dst)
        merged['episode_id_high_water'] = next_episode - 1
        for entry in merged['episodes']:
            identity = next((identity for identity, number in new_mapping['episodes'].items() if number == entry['episode']), None)
            if identity:
                entry['hook'] = 'desktop:' + identity
        write(destination / 'project.json', merged)
        write(destination / 'versions/versions.json', all_versions)
        write(destination / 'desktop-merge.json', {'sources': new_mapping['merged_sources'], 'revision': preview['revision'], 'choices': choices})
        # Recheck all source bytes immediately before publishing. An Agent/external
        # edit during staging must leave the old scope untouched.
        latest, _, _ = inventory(data, root, body)
        if latest['revision'] != preview['revision']:
            raise ValueError('studio_edit_conflict')
        if not (root / target).exists():
            destination.replace(root / target)
        elif read(root / target / 'desktop-merge.json').get('revision') != preview['revision']:
            raise ValueError('studio_edit_conflict')
        scope_path.parent.mkdir(parents=True, exist_ok=True)
        if scope_path.exists():
            shutil.copy2(scope_path, scope_path.with_suffix('.before-merge.json'))
        save_scope(scope_path, new_mapping)
    return {'ok': True, 'episodes': len(merged['episodes']), 'sources': len(preview['sources'])}


async def merge_workspace(data, root, body, client, service):
    preview, mapping, path = await asyncio.to_thread(inventory, data, root, body)
    for source in preview['sources']:
        active = False
        for status in ('queued', 'running'):
            response = await client.get(f'projects/{source["name"]}/tasks?status={status}&page_size=1')
            if not response.is_success:
                raise ValueError('studio_engine_rejected')
            active = active or bool(response.json().get('items'))
        if active or await service.list_sessions(project_name=source['name'], status='running', limit=1):
            preview['blockers'].append('旧项目仍有任务或 Agent 执行中，请先停止并等待完成。')
    from workspace_api import uploads
    if any(u['project'] in {s['name'] for s in preview['sources']} for u in uploads.values()):
        preview['blockers'].append('有素材正在上传，请等待上传完成。')
    for identity in body['episodeIds']:
        binding = data / 'bindings' / (legacy_name(body['projectId'], identity) + '.json')
        if binding.exists() and read(binding).get('pending'):
            preview['blockers'].append('存在结果待确认的 Agent 提交，请先恢复该提交。')
    if body['action'] == 'legacy_preview':
        return preview
    if not preview['required']:
        return {'ok': True, 'alreadyMerged': True}
    if preview['blockers']:
        raise ValueError('studio_merge_blocked')
    if body.get('data', {}).get('revision') != preview['revision']:
        raise ValueError('studio_edit_conflict')
    return await asyncio.to_thread(combine, data, root, body, preview, mapping, path)
