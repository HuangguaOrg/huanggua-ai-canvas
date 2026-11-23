"""Offline integration tests for Studio local uploads and Huanggua URL staging."""
import base64
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import httpx
from PIL import Image

from runtime.studio.test_workspace import WorkspaceTest


class LocalUploadsAndStagingTest(WorkspaceTest):
    def _upload_bytes(self, kind: str, filename: str, raw: bytes, **extra):
        begin = self.call('upload_begin', data={'kind': kind, 'filename': filename, 'size': len(raw), **extra})
        upload_id = begin['id']
        for offset in range(0, len(raw), 384 * 1024):
            chunk = raw[offset:offset + 384 * 1024]
            self.call('upload_chunk', id=upload_id, data={'offset': offset, 'chunk': base64.b64encode(chunk).decode()})
        return self.call('upload_finish', id=upload_id)

    def _make_video(self, suffix: str = '.mp4', codec: str = 'libx264') -> bytes:
        out = self.root / f'fixture_{codec}{suffix}'
        code = (
            "import os,sys,subprocess;"
            "os.chdir(os.environ['HUANGGUA_STUDIO_ENGINE']);sys.path.insert(0,os.getcwd());"
            "from lib.infra.ffmpeg import ffmpeg_executable;"
            "subprocess.run([ffmpeg_executable(),'-y','-hide_banner','-loglevel','error',"
            "'-f','lavfi','-i','color=c=blue:s=320x180:r=24','-t','1.5',"
            "'-c:v',sys.argv[2],'-pix_fmt','yuv420p',sys.argv[1]],check=True,capture_output=True)"
        )
        subprocess.run([sys.executable, '-s', '-c', code, str(out), codec], check=True, capture_output=True)
        return out.read_bytes()

    def test_all_local_uploads_persist_immediately_in_local_records(self):
        buf = io.BytesIO()
        Image.new('RGB', (120, 120), 'orange').save(buf, format='PNG')
        png_bytes = buf.getvalue()
        mp4_bytes = self._make_video('.mp4', 'libx264')
        webm_bytes = self._make_video('.webm', 'libvpx')

        # 1. Draft project auto-initializes formal shot on first local upload (no AI call).
        fresh_scope = {
            'projectId': '12345678-1234-1234-1234-999999999901',
            'episodeId': '12345678-1234-1234-1234-999999999902',
            'episodeIds': ['12345678-1234-1234-1234-999999999902'],
            'title': '纯本地上传测试剧',
            'episodeTitle': 'EP 01',
            'contentMode': 'drama',
            'generationMode': 'storyboard',
        }
        ensured = json.loads(self.request('/desktop/workspace', {
            **fresh_scope,
            'action': 'ensure_formal_shot',
            'data': {'index': 0, 'shots': [{'id': 'draft-1', 'title': 'SHOT 01', 'description': '雨夜街道', 'duration': 6}]},
        }))
        shot_id = ensured['shotId']
        self.assertTrue(shot_id)

        def fresh_upload(kind: str, filename: str, raw: bytes, **extra):
            uid = json.loads(self.request('/desktop/workspace', {**fresh_scope, 'action': 'upload_begin', 'data': {'kind': kind, 'filename': filename, 'size': len(raw), **extra}}))['id']
            self.request('/desktop/workspace', {**fresh_scope, 'action': 'upload_chunk', 'id': uid, 'data': {'offset': 0, 'chunk': base64.b64encode(raw).decode()}})
            return json.loads(self.request('/desktop/workspace', {**fresh_scope, 'action': 'upload_finish', 'id': uid}))

        # Upload storyboard image, end frame, WebM shot video, shot ref image & video, style image, derivative image, asset video, local media, and video chat attachment!
        fresh_upload('storyboard', 'board.png', png_bytes, name=shot_id)
        fresh_upload('end_frame', 'tail.png', png_bytes, name=shot_id)
        fresh_upload('video', 'clip.webm', webm_bytes, name=shot_id)
        fresh_upload('shot_ref_image', 'ref_img.png', png_bytes, name=shot_id)
        fresh_upload('shot_ref_video', 'ref_vid.mp4', mp4_bytes, name=shot_id)
        fresh_upload('style_image', 'style.png', png_bytes)
        fresh_upload('local_media', 'library_clip.mp4', mp4_bytes)
        chat_vid = fresh_upload('attachment', 'chat_upload.mp4', mp4_bytes)
        self.assertEqual(chat_vid['kind'], 'video')
        self.assertTrue(chat_vid['projectPath'].startswith('uploads/videos/'))

        json.loads(self.request('/desktop/workspace', {**fresh_scope, 'action': 'asset_create', 'category': 'characters', 'data': {'name': '主角', 'description': '黑衣少年'}}))
        json.loads(self.request('/desktop/workspace', {**fresh_scope, 'action': 'derivative_create', 'id': '主角', 'data': {'name': '战损态', 'description': '披风破损'}}))
        fresh_upload('character_derivative', 'deriv.png', png_bytes, name='主角', derivative='战损态')
        fresh_upload('asset_video_ref', 'actor_motion.mp4', mp4_bytes, category='characters', name='主角')

        # Immediately poll (zero sleep!) and verify every local file is indexed in local Studio records!
        polled = json.loads(self.request('/desktop/poll', fresh_scope))
        names = {a['name'] for a in polled['artifacts']}
        self.assertIn('style_reference.png', names)
        self.assertTrue(any(n.startswith('storyboards/') for n in names))
        self.assertTrue(any(n.startswith('end_frames/') for n in names))
        self.assertTrue(any(n.startswith('videos/') and n.endswith('.mp4') for n in names))
        self.assertIn('characters/derivatives/主角/战损态.png', names)
        self.assertIn(chat_vid['projectPath'], names)
        self.assertTrue(any(n.startswith('uploads/shots/') for n in names))
        self.assertTrue(any(n.startswith('uploads/assets/characters/') for n in names))

        # Clear end frame and remove a shot ref without deleting the local file record.
        shot_settings = json.loads(self.request('/desktop/workspace', {**fresh_scope, 'action': 'shot_settings', 'id': shot_id}))
        self.assertEqual(len(shot_settings['references']['images']), 1)
        self.assertEqual(len(shot_settings['references']['videos']), 1)
        json.loads(self.request('/desktop/workspace', {**fresh_scope, 'action': 'shot_end_frame_clear', 'id': shot_id}))

        # Verify style_template_id and style_image mutual exclusion via real Studio engine!
        proj_after_img = json.loads(self.request('/desktop/workspace', {**fresh_scope, 'action': 'project'}))['project']
        self.assertEqual(proj_after_img.get('style_image'), 'style_reference.png')
        self.assertIsNone(proj_after_img.get('style_template_id'))
        json.loads(self.request('/desktop/workspace', {
            **fresh_scope,
            'action': 'project_settings',
            'data': {'style_template_id': 'live_premium_drama', 'clear_style_image': True, 'aspect_ratio': '9:16'},
        }))
        proj_after_tpl = json.loads(self.request('/desktop/workspace', {**fresh_scope, 'action': 'project'}))['project']
        self.assertEqual(proj_after_tpl.get('style_template_id'), 'live_premium_drama')
        self.assertTrue((proj_after_tpl.get('style') or '').strip())
        self.assertFalse(proj_after_tpl.get('style_image'))


class MediaStagingBackendTest(unittest.IsolatedAsyncioTestCase):
    async def test_spec_validation_and_huanggua_url_staging_for_image_and_video(self):
        engine_root = Path(os.environ['HUANGGUA_STUDIO_ENGINE'])
        runtime_dir = Path(__file__).parent.resolve()
        for entry in (str(runtime_dir), str(engine_root)):
            if entry not in sys.path:
                sys.path.insert(0, entry)

        from media_staging import build_shot_precheck, install_huanggua_staging, CURRENT_TASK
        from lib.backends.huanggua import HuangguaImageBackend, HuangguaVideoBackend
        from lib.backends.image_backends.base import ImageGenerationRequest, ReferenceImage
        from arcreel_market_core.video_backend_contract import VideoGenerationRequest
        from lib.infra.app_data_dir import reset_for_tests as reset_app_data_dir
        from lib.project.project_manager import ProjectManager, reset_project_manager_for_tests

        install_huanggua_staging(engine_root)

        prev_data_dir = os.environ.get('ARCREEL_DATA_DIR')

        def _restore_pm():
            if prev_data_dir is None:
                os.environ.pop('ARCREEL_DATA_DIR', None)
            else:
                os.environ['ARCREEL_DATA_DIR'] = prev_data_dir
            reset_app_data_dir()
            reset_project_manager_for_tests()

        self.addCleanup(_restore_pm)
        with tempfile.TemporaryDirectory(prefix='hg-stage-unit-') as tmp:
            tmp_root = Path(tmp)
            os.environ['ARCREEL_DATA_DIR'] = str(tmp_root / 'data')
            reset_app_data_dir()
            reset_project_manager_for_tests()
            pm = ProjectManager(str(tmp_root / 'data'))
            proj_name = 'stage-proj'
            pm.create_project(proj_name, content_mode='drama')
            pm.create_project_metadata(proj_name, 'Staging Test', content_mode='drama')
            pm.update_project(proj_name, lambda p: p.__setitem__('generation_mode', 'storyboard'))
            proj_dir = pm.get_project_path(proj_name)

            # Create local storyboard image + local MOV reference video
            sb_rel = 'storyboards/scene_E1S01.png'
            sb_path = proj_dir / sb_rel
            sb_path.parent.mkdir(parents=True, exist_ok=True)
            Image.new('RGB', (600, 600), 'teal').save(sb_path, format='PNG')

            vid_rel = 'uploads/shots/E1S01/motion.mov'
            vid_path = proj_dir / vid_rel
            vid_path.parent.mkdir(parents=True, exist_ok=True)
            from lib.infra.ffmpeg import ffmpeg_executable
            subprocess.run(
                [ffmpeg_executable(), '-y', '-hide_banner', '-loglevel', 'error',
                 '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=24', '-t', '1',
                 '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(vid_path)],
                check=True,
                capture_output=True,
            )
            mov_original_bytes = vid_path.read_bytes()

            pm.update_project(proj_name, lambda p: p.update({
                'aspect_ratio': '9:16',
                'desktop_shot_references': {'E1S01': {'images': [], 'videos': [vid_rel]}},
            }))
            project = pm.load_project(proj_name)
            item = {'scene_id': 'E1S01', 'duration_seconds': 5, 'image_prompt': 'hero portrait', 'video_prompt': 'camera pan',
                    'generated_assets': {'storyboard_image': sb_rel}}

            # 1. Spec check blocks video-reference on models with max_videos == 0, allows on Seedance 2.0!
            blocked = await build_shot_precheck(
                root=engine_root, project_path=proj_dir, project=project, item=item,
                shot_id='E1S01', kind='video', target_ratio='9:16', selected_model='grsai-minimax-h3-768p',
            )
            self.assertFalse(blocked['allowed'])
            self.assertTrue(any('不支持参考视频输入' in b for b in blocked['blockers']))

            allowed = await build_shot_precheck(
                root=engine_root, project_path=proj_dir, project=project, item=item,
                shot_id='E1S01', kind='video', target_ratio='9:16', selected_model='catcode-Seedance-2.0-官转',
            )
            self.assertTrue(allowed['allowed'])
            self.assertEqual(len(allowed['references']), 2)
            self.assertEqual({r['kind'] for r in allowed['references']}, {'image', 'video'})

            img_check = await build_shot_precheck(
                root=engine_root, project_path=proj_dir, project={**project, 'style_image': sb_rel}, item=item,
                shot_id='E1S01', kind='image', target_ratio='9:16', selected_model='grsai-gpt-image-2.5-flare',
            )
            self.assertTrue(img_check['allowed'])
            self.assertEqual(img_check['targetPixelSize'], '720x1280')

            # 2. Mock huanggua.my transport and verify:
            #    (a) HuangguaImageBackend stages image -> /v1/media/uploads -> HTTPS URL -> /v1/images/generations JSON with 2K resolution!
            #    (b) HuangguaVideoBackend stages image + MOV video (remuxed to MP4 without touching local MOV!) -> /v1/media/uploads -> images[] + videos[] URLs!
            requests_seen: list[tuple[str, str, dict | None]] = []
            out_png_buf = io.BytesIO()
            Image.new('RGB', (64, 64), 'purple').save(out_png_buf, format='PNG')
            out_png = out_png_buf.getvalue()

            def handler(req: httpx.Request) -> httpx.Response:
                if req.url.path == '/v1/media/submissions/capabilities':
                    return httpx.Response(404)
                if req.url.path == '/v1/media/uploads':
                    kind = 'video' if b'video/mp4' in req.content else 'image'
                    ext = 'mp4' if kind == 'video' else 'png'
                    requests_seen.append((req.method, f"{req.url.path}?{req.url.query.decode()}", {'kind': kind}))
                    return httpx.Response(200, json={
                        'url': f'https://huanggua.my/api/studio/media/45/{"a" * 48}.{ext}',
                        'kind': kind,
                        'expires_at': 4102444800,
                    })
                if req.url.path.startswith('/api/studio/media/'):
                    return httpx.Response(200, content=b'ok')
                if req.url.path == '/v1/images/generations':
                    payload = json.loads(req.content.decode('utf-8'))
                    requests_seen.append((req.method, req.url.path, payload))
                    return httpx.Response(200, json={
                        'data': [{'b64_json': base64.b64encode(out_png).decode('ascii')}]
                    })
                raise AssertionError(f'Unexpected request: {req.method} {req.url}')

            transport = httpx.MockTransport(handler)
            img_backend = HuangguaImageBackend(
                api_key='sk-test-image',
                base_url='https://huanggua.my',
                model='grsai-nano-banana-2-2k-cl',
                transport=transport,
            )
            img_out = tmp_root / 'generated.png'
            img_res = await img_backend.generate(ImageGenerationRequest(
                prompt='cyberpunk alley',
                output_path=img_out,
                reference_images=[ReferenceImage(path=str(sb_path))],
                aspect_ratio='9:16',
            ))
            self.assertTrue(img_res.image_path.is_file())
            gen_calls = [r for r in requests_seen if r[1] == '/v1/images/generations']
            self.assertEqual(len(gen_calls), 1)
            self.assertEqual(gen_calls[0][2]['resolution'], '2K')
            self.assertEqual(gen_calls[0][2]['images'], [f'https://huanggua.my/api/studio/media/45/{"a" * 48}.png'])

            vid_backend = HuangguaVideoBackend(
                api_key='sk-test-video',
                base_url='https://huanggua.my',
                model='catcode-Seedance-2.0-官转',
                transport=transport,
            )
            token = CURRENT_TASK.set({'task_type': 'video', 'project_name': proj_name, 'resource_id': 'E1S01'})
            try:
                vid_payload = await vid_backend.payload(VideoGenerationRequest(
                    prompt='camera pan across alley',
                    output_path=tmp_root / 'out.mp4',
                    aspect_ratio='9:16',
                    duration_seconds=5,
                    start_image=sb_path,
                    project_name=proj_name,
                ))
            finally:
                CURRENT_TASK.reset(token)

            self.assertEqual(vid_payload['images'], [f'https://huanggua.my/api/studio/media/45/{"a" * 48}.png'])
            self.assertEqual(vid_payload['videos'], [f'https://huanggua.my/api/studio/media/45/{"a" * 48}.mp4'])
            self.assertEqual(vid_payload['video_mode'], 'generate')
            # Local original MOV file is completely untouched!
            self.assertEqual(vid_path.read_bytes(), mov_original_bytes)

            # Single-frame grsai-minimax-h3 sends images[] instead of first_frame!
            h3_backend = HuangguaVideoBackend(
                api_key='sk-test-video',
                base_url='https://huanggua.my',
                model='grsai-minimax-h3-768p',
                transport=transport,
            )
            h3_payload = await h3_backend.payload(VideoGenerationRequest(
                prompt='subtle motion',
                output_path=tmp_root / 'h3.mp4',
                aspect_ratio='1:1',
                duration_seconds=6,
                start_image=sb_path,
            ))
            self.assertIn('images', h3_payload)
            self.assertNotIn('first_frame', h3_payload)


if __name__ == '__main__':
    unittest.main()
