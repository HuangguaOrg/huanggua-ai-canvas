import unittest
from dataclasses import dataclass
from types import SimpleNamespace
from unittest.mock import patch

import httpx
import video_specs as specs


class VideoCatalogTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.row = {"id": "new/public", "display_name": "新视频模型", "kind": "video", "spec_status": "available",
                    "default_resolution": "768p", "seconds_by_resolution": {"768p": [4, 3, 4], "1080p": [6]}}

    async def test_signed_directory_detail_and_ordinary_account(self):
        urls = []
        def handle(req):
            self.assertEqual(req.headers['Authorization'], 'Bearer synthetic-fixture')
            urls.append(req.url.raw_path)
            if req.url.path == '/v1/models':
                return httpx.Response(200, json={"data": [self.row, {"id": "ordinary"}, {"id": "forbidden"}]})
            return httpx.Response(200, json=self.row)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            catalog = await specs.fetch(client, {"api_key": "synthetic-fixture", "models": ["new/public", "ordinary", "removed"]}, "new/public")
        self.assertEqual(urls, [b'/v1/models?kind=video', b'/v1/models/new%2Fpublic'])
        self.assertEqual(set(catalog), {'new/public', 'ordinary'})
        self.assertEqual(catalog['ordinary']['spec_status'], 'legacy')
        self.assertEqual(catalog['new/public']['seconds_by_resolution']['768p'], [3, 4])
        rows = specs.provider_rows([], list(catalog), catalog)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['capability_overrides']['duration_constraints']['by_resolution'], {'768p':[3,4], '1080p':[6]})

    async def test_unknown_or_withdrawn_detail_preserves_no_invented_tier(self):
        for status, value in ((200, []), (200, {**self.row, 'spec_status':'unknown'}), (404, {}), (503, {})):
            def handle(req):
                if req.url.path == '/v1/models':
                    return httpx.Response(200, json={'data':[self.row]})
                return httpx.Response(status, json=value)
            async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
                result = await specs.fetch(client, {'api_key':'fixture', 'models':['new/public']}, 'new/public')
            if status == 404:
                self.assertNotIn('new/public', result)
            else:
                with self.assertRaisesRegex(ValueError, 'studio_video_specs_unavailable'):
                    specs.resolution(result['new/public'])

    async def test_removed_tier_fails_before_media_submission(self):
        paths = []
        def handle(req):
            paths.append((req.method, req.url.path))
            return httpx.Response(200,json={**self.row,'seconds_by_resolution':{'768p':[4]}})
        backend = SimpleNamespace(model='new/public', _base=specs.ORIGIN, headers=lambda url:{},
                                  client=lambda: httpx.AsyncClient(transport=httpx.MockTransport(handle)))
        chosen = {'ref':'custom-1/new/public','resolution':'768p','ratio':'9:16'}
        request = SimpleNamespace(resolution='768p',duration_seconds=3,aspect_ratio='9:16')
        with self.assertRaisesRegex(ValueError, 'studio_video_duration_conflict'):
            await specs.validate_wire(backend, request, chosen)
        request.duration_seconds=4
        await specs.validate_wire(backend, request, chosen)
        self.assertEqual(paths,[('GET','/v1/models/new/public')]*2)

    async def test_planning_and_video_queue_keep_the_accepted_episode_choice(self):
        project = {
            'episodes': [{'episode': 2, 'script_file': 'scripts/episode_2.json'}],
            'aspect_ratio': '9:16',
            'desktop_episode_video': {'2': {'managed': True, 'ref': 'custom-3/public', 'resolution': '768p'}},
        }
        manager = SimpleNamespace(load_project=lambda name: project)
        modules = {'lib.project.project_manager': SimpleNamespace(get_project_manager=lambda: manager),
                   'lib.artifacts.video_visual_provenance': SimpleNamespace(resolve_video_aspect_ratio=lambda *args: '9:16')}
        with patch.dict('sys.modules', modules):
            plan = await specs.freeze_task('project', 'text_reference_script_plan', None, 'episode-2', {'episode': 2})
            self.assertEqual(plan['desktop_video']['ref'], 'custom-3/public')
            self.assertNotIn('ratio', plan['desktop_video'])
            video = await specs.freeze_task('project', 'reference_video', 'episode_2.json', '2U1', {})
            self.assertEqual(video['desktop_video'], {**plan['desktop_video'], 'ratio': '9:16'})
            project['desktop_episode_video']['2'] = {'unavailable': 'studio_video_resolution_conflict'}
            with self.assertRaisesRegex(ValueError, 'studio_video_resolution_conflict'):
                await specs.freeze_task('project', 'reference_video', 'episode_2.json', '2U2', {})
            with self.assertRaisesRegex(ValueError, 'studio_video_resolution_conflict'):
                await specs.freeze_task('project', 'text_reference_script_plan', None, 'episode-2', {'episode': 2})
            self.assertEqual(video['desktop_video']['ref'], 'custom-3/public')
            untouched = await specs.freeze_task('project', 'text_drama_script_plan', None, 'episode-3', {'episode': 3})
            self.assertEqual(untouched, {'episode': 3})

    def test_selection_and_export_are_independent(self):
        spec = specs.entry(self.row)
        self.assertEqual(specs.resolution(spec), '768p')
        with self.assertRaisesRegex(ValueError,'studio_video_resolution_conflict'):
            specs.resolution(spec,'720p')
        @dataclass(frozen=True)
        class Profile:
            width: int
            height: int
            fps: int
        self.assertEqual(specs.export_profile(Profile(1080,1920,24), {'desktop_custom_resolution':'720x1280'}),Profile(720,1280,24))

    def test_download_only_follows_this_job(self):
        job=specs.ORIGIN+'/v1/videos/a'
        self.assertEqual(specs.download_location(job,{'download_url':'/v1/videos/a/content'}), job+'/content')
        for path in ('https://example.invalid/v1/videos/a/content', '/v1/videos/b/content'):
            with self.assertRaisesRegex(ValueError,'studio_invalid_video_download'):
                specs.download_location(job,{'download_url':path})
