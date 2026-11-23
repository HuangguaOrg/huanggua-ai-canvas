"""Stable desktop project/episode identity; legacy projects are adopted in place.

Mappings are private and atomically replaced. No media or conversation is moved.
Multiple populated legacy projects fail closed rather than silently losing one.
"""
import hashlib
import json
import re


def legacy_name(project, episode):
    return 'studio-' + hashlib.sha256((project + ':' + episode).encode()).hexdigest()[:32]


def resolve_scope(data, projects_dir, body):
    project, episode = body.get('projectId', ''), body.get('episodeId', '')
    ids = body.get('episodeIds', [episode])
    if not isinstance(ids, list) or not 0 < len(ids) <= 1000 or episode not in ids or any(not isinstance(x, str) or not re.fullmatch(r'[a-f0-9-]{36}', x) for x in [project, *ids]):
        raise ValueError('studio_invalid_project')
    folder = data / 'project-scopes'
    folder.mkdir(exist_ok=True)
    path = folder / (project + '.json')
    if path.exists():
        mapping = json.loads(path.read_text(encoding='utf-8'))
    else:
        existing = [x for x in ids if (projects_dir / legacy_name(project, x) / 'project.json').is_file()]
        if len(existing) > 1:
            raise ValueError('studio_legacy_merge_required')
        primary = (existing or ids)[0]
        mapping = {'project': legacy_name(project, primary), 'episodes': {}, 'primary': primary}
        if existing:
            detail = json.loads((projects_dir / mapping['project'] / 'project.json').read_text(encoding='utf-8'))
            episodes = detail.get('episodes', [])
            if episodes:
                mapping['episodes'][primary] = episodes[0]['episode']
        save_scope(path, mapping)
    # A previously unreported legacy episode must never be replaced by a blank one.
    old = legacy_name(project, episode)
    if old != mapping['project'] and old not in mapping.get('merged_sources', []) and (projects_dir / old / 'project.json').is_file():
        raise ValueError('studio_legacy_merge_required')
    if episode == mapping['primary'] and episode not in mapping['episodes']:
        file = projects_dir / mapping['project'] / 'project.json'
        if file.exists():
            entries = json.loads(file.read_text(encoding='utf-8')).get('episodes', [])
            # A newly created secondary episode can be the first formal episode.
            # Only adopt unmarked legacy data or this episode's recovery marker.
            if len(entries) == 1 and (not str(entries[0].get('hook', '')).startswith('desktop:') or entries[0].get('hook') == 'desktop:' + episode):
                mapping['episodes'][episode] = entries[0]['episode']
                save_scope(path, mapping)
    return mapping['project'], mapping['episodes'].get(episode), path, mapping


def save_scope(path, mapping):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(mapping, ensure_ascii=False), encoding='utf-8')
    temporary.replace(path)


async def ensure_episode(body, client, checked):
    from lib.project.project_manager import get_project_manager
    name, number, path, mapping = resolve_scope(body['_data_root'], get_project_manager().layout.projects_dir, body)
    if number is None:
        # Recover an interrupted creation using a persistent marker in the episode hook.
        marker = 'desktop:' + body['episodeId']
        detail = await checked(client, 'GET', f'projects/{name}')
        entry = next((e for e in detail['project'].get('episodes', []) if e.get('hook') == marker), None)
        if entry is None:
            source = body.get('sourceText', '')
            if not isinstance(source, str) or len(source) > 300000:
                raise ValueError('studio_invalid_content')
            result = await checked(client, 'POST', f'projects/{name}/episodes', {
                'title': str(body.get('episodeTitle', '新分集'))[:200], 'hook': marker,
                'source_text': source.strip() or None, 'source_kind': 'screenplay',
            })
            entry = result['episode']
        number = entry['episode'] if isinstance(entry, dict) else entry
        mapping['episodes'][body['episodeId']] = number
        save_scope(path, mapping)
    body['_episode'] = number
    return number
