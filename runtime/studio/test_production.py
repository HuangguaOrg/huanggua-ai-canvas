"""Offline real-engine regressions for production modes and non-destructive merging."""
import hashlib
import base64
import json
import subprocess
import sys
import urllib.error
import unittest
from runtime.studio.test_bridge import BridgeTest


class ProductionTest(BridgeTest):
    def call(self, scope, action, **extra):
        return json.loads(self.request('/desktop/workspace', {**scope, 'action': action, **extra}))

    def seed(self, scope, mode='drama', generation='storyboard', label='original'):
        name = 'studio-' + hashlib.sha256((scope['projectId'] + ':' + scope['episodeId']).encode()).hexdigest()[:32]
        seed = '''
import os,sys,json
os.environ['ARCREEL_DATA_DIR']=sys.argv[1]
os.chdir(os.environ['HUANGGUA_STUDIO_ENGINE']);sys.path.insert(0,os.getcwd())
from lib.project.project_manager import ProjectManager
pm=ProjectManager(sys.argv[1]);name=sys.argv[2];mode=sys.argv[3]
pm.create_project(name,content_mode=mode)
pm.create_project_metadata(name,sys.argv[5],content_mode=mode,extras={'generation_mode':sys.argv[4]})
if sys.argv[4]=='storyboard':
 pm.save_script(name,{'episode':1,'title':'Test','content_mode':'drama','scenes':[{'scene_id':'E1S01','duration_seconds':2,'scene_description':'@[Hero] offline','characters_in_scene':['Hero'],'scenes':[],'props':[],'image_prompt':'image','video_prompt':'motion','generated_assets':{}}]},'episode_1.json')
'''
        subprocess.run([sys.executable, '-s', '-c', seed, str(self.root/'data'), name, mode, generation, label], check=True, capture_output=True)
        return name

    def upload_clip(self, scope, kind, identity):
        clip = self.root / 'production-test.mp4'
        make = '''
import os,sys,subprocess
os.chdir(os.environ['HUANGGUA_STUDIO_ENGINE']);sys.path.insert(0,os.getcwd())
from lib.infra.ffmpeg import ffmpeg_executable
subprocess.run([ffmpeg_executable(),'-y','-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=green:s=160x90:r=24','-t','2','-c:v','libx264','-pix_fmt','yuv420p',sys.argv[1]],check=True,capture_output=True)
'''
        subprocess.run([sys.executable,'-s','-c',make,str(clip)],check=True,capture_output=True)
        raw = clip.read_bytes()
        upload = self.call(scope,'upload_begin',data={'kind':kind,'name':identity,'filename':'offline.mp4','size':len(raw)})['id']
        self.call(scope,'upload_chunk',id=upload,data={'offset':0,'chunk':base64.b64encode(raw).decode()})
        self.call(scope,'upload_finish',id=upload)

    def test_reference_units_roundtrip(self):
        scope = {'projectId':'22345678-1234-1234-1234-123456789012','episodeId':'22345678-1234-1234-1234-123456789013'}
        self.seed(scope, generation='reference_video')
        self.call(scope, 'blank_script')
        first = self.call(scope, 'reference_add', data={'prompt':'A green cucumber on a table','duration_seconds':5})
        self.assertNotIn('rejected', first, first)
        unit = first['unit']['unit_id']
        self.call(scope, 'reference_update', id=unit, data={'prompt':'A blue cucumber', 'duration_seconds':6, 'note':'roundtrip'})
        second = self.call(scope, 'reference_add', data={'prompt':'Second unit', 'duration_seconds':5})['unit']['unit_id']
        self.call(scope, 'reference_move', id=second, data={'after_unit_id':None})
        units = self.call(scope, 'reference_units')['units']
        self.assertEqual(units[0]['unit_id'], second)
        self.assertEqual(units[1]['text'], 'A blue cucumber')
        self.assertEqual(units[1]['duration_seconds'], 6)
        self.assertIn('versions', self.call(scope, 'versions', category='reference_videos', id=unit))
        self.upload_clip(scope, 'reference_video', unit)
        self.assertTrue(self.call(scope,'reference_units')['units'][1]['generated_assets']['video_clip'])
        self.assertEqual(len(self.call(scope,'versions',category='reference_videos',id=unit)['versions']),1)
        self.call(scope, 'reference_delete', id=second)
        self.assertEqual(len(self.call(scope, 'reference_units')['units']), 1)

    def test_ad_brief_and_products(self):
        scope = {'projectId':'32345678-1234-1234-1234-123456789012','episodeId':'32345678-1234-1234-1234-123456789013'}
        self.seed(scope, mode='ad', generation='reference_video')
        self.call(scope, 'project_settings', data={'brief':'A cucumber ad', 'target_duration':30, 'aspect_ratio':'9:16'})
        self.call(scope, 'asset_create', category='products', data={'name':'Cucumber','description':'fresh','brand':'Huanggua','selling_points':['green','fresh']})
        detail = self.call(scope, 'project')['project']
        self.assertEqual(detail['brief'], 'A cucumber ad')
        self.assertEqual(detail['products']['Cucumber']['selling_points'], ['green','fresh'])

    def test_legacy_merge_preserves_sources_and_rejects_stale(self):
        first = {'projectId':'42345678-1234-1234-1234-123456789012','episodeId':'42345678-1234-1234-1234-123456789013'}
        second = {**first, 'episodeId':'42345678-1234-1234-1234-123456789014'}
        names = [self.seed(first, label='First legacy'), self.seed(second, label='Second legacy')]
        self.call(first, 'asset_create', category='characters', data={'name':'Hero', 'description':'first'})
        # Create second before announcing all episode IDs, exactly like the legacy client.
        root = self.root/'data/projects'
        detail = json.loads((root/names[1]/'project.json').read_text(encoding='utf-8'))
        detail['characters']['Hero'] = {'description':'second'}
        (root/names[1]/'project.json').write_text(json.dumps(detail),encoding='utf-8')
        scope = {**first, 'episodeIds':[first['episodeId'], second['episodeId']]}
        self.upload_clip(first,'video','E1S01')
        self.call(first, 'timeline_create', data={'name':'Legacy timeline'})
        preview = self.call(scope, 'legacy_preview')
        self.assertTrue(preview['required']);self.assertEqual(len(preview['conflicts']),1)
        choices = {c['key']:'keep_both' for c in preview['conflicts']}
        (root/names[1]/'source').mkdir(exist_ok=True)
        (root/names[1]/'source/test.txt').write_text('new edit',encoding='utf-8')
        with self.assertRaises(urllib.error.HTTPError) as stale:
            self.call(scope, 'legacy_merge', data={'revision':preview['revision'],'choices':choices})
        stale.exception.close()
        preview = self.call(scope, 'legacy_preview')
        originals = {n:(root/n/'project.json').read_bytes() for n in names}
        result = self.call(scope, 'legacy_merge', data={'revision':preview['revision'],'choices':choices})
        self.assertTrue(result['ok'])
        for n in names:self.assertEqual((root/n/'project.json').read_bytes(),originals[n])
        a = self.call(scope, 'project');b = self.call({**scope,'episodeId':second['episodeId']},'project')
        self.assertNotEqual(a['episodeNumber'], b['episodeNumber'])
        self.assertEqual(len(b['project']['characters']),2)
        script = self.call({**scope,'episodeId':second['episodeId']},'script',id='episode_2.json')['script']
        self.assertEqual(script['scenes'][0]['scene_id'],'E2S01')
        self.assertIn('旧项目2',script['scenes'][0]['characters_in_scene'][0])
        self.assertEqual(len(self.call(scope,'timelines')['timelines']),1)
        self.assertFalse(self.call(scope,'legacy_preview')['required'])

    def test_three_legacy_projects_reuse_and_keep_both(self):
        ids = ['52345678-1234-1234-1234-123456789013', '52345678-1234-1234-1234-123456789014', '52345678-1234-1234-1234-123456789015']
        scope = {'projectId':'52345678-1234-1234-1234-123456789012','episodeId':ids[0],'episodeIds':ids}
        root = self.root/'data/projects'
        for i, identity in enumerate(ids):
            name = self.seed({**scope,'episodeId':identity},label=f'Legacy {i}')
            file = root/name/'project.json'; detail = json.loads(file.read_text(encoding='utf-8'))
            detail['characters']['Hero'] = {'description':f'Hero {i}'}
            file.write_text(json.dumps(detail),encoding='utf-8')
        preview = self.call(scope,'legacy_preview')
        self.assertEqual(len(preview['conflicts']),2)
        choices = {c['key']:('reuse' if c['source']==1 else 'keep_both') for c in preview['conflicts']}
        self.call(scope,'legacy_merge',data={'revision':preview['revision'],'choices':choices})
        detail = self.call(scope,'project')['project']
        self.assertEqual(len(detail['characters']),2)
        self.assertEqual(detail['characters']['Hero']['description'],'Hero 0')
        self.assertEqual(self.call({**scope,'episodeId':ids[2]},'project')['episodeNumber'],3)


class DiagnosticTest(unittest.IsolatedAsyncioTestCase):
    async def test_overwrite_revision_and_rejection_survive_adapter(self):
        import httpx
        from runtime.studio.workspace_api import diagnostic_request
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(409,json={'detail':'Replace script?', 'diagnostic':{'script_overwrite':{'revision':'abc','text':'Existing clips will be detached'}}})),base_url='http://test') as client:
            result = await diagnostic_request(client,'POST','/ad-script',{})
        self.assertTrue(result['rejected'])
        self.assertEqual(result['diagnostic']['script_overwrite']['revision'],'abc')

