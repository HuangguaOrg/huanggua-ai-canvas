"""Studio engine route checks in a temporary project; never uses an account/model."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
import urllib.error

from runtime.studio.test_bridge import BridgeTest


class WorkspaceTest(BridgeTest):
    # Match a packaged Windows profile's depth; render staging exceeds MAX_PATH.
    data_suffix = 'deep-profile-' + 'x' * 25
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        name = 'studio-' + hashlib.sha256((cls.ids['projectId'] + ':' + cls.ids['episodeId']).encode()).hexdigest()[:32]
        seed = '''
import os,sys
from pathlib import Path
os.environ['ARCREEL_DATA_DIR']=sys.argv[1]
os.chdir(os.environ['HUANGGUA_STUDIO_ENGINE']); sys.path.insert(0,os.getcwd())
from lib.project.project_manager import ProjectManager
pm=ProjectManager(sys.argv[1])
name=sys.argv[2]
pm.create_project(name,content_mode='drama')
pm.create_project_metadata(name,'Offline migration test',content_mode='drama')
pm.save_script(name,{'episode':1,'title':'Test','content_mode':'drama','scenes':[{'scene_id':'E1S01','duration_seconds':2,'scene_description':'offline','characters_in_scene':[],'scenes':[],'props':[],'image_prompt':'image','video_prompt':'motion','generated_assets':{}}]},'episode_1.json')
'''
        subprocess.run([sys.executable, '-s', '-c', seed, str(cls.root / 'data'), name], check=True, capture_output=True)

    def call(self, action, **kwargs):
        return json.loads(self.request('/desktop/workspace', {**self.ids, 'action': action, **kwargs}))

    def test_delete_project_is_scoped_retryable_and_blocks_recreation(self):
        scope = {'projectId': '12345678-1234-1234-1234-123456789030',
                 'episodeId': '12345678-1234-1234-1234-123456789031'}
        self.call('blank_script', **scope, episodeTitle='待删除项目')
        self.assertIsNotNone(self.call('project', **scope)['project'])
        self.assertTrue(self.call('project_delete', **scope)['ok'])
        self.assertTrue(self.call('project_delete', **scope)['ok'])
        mapping = json.loads((self.root / 'project-scopes' / (scope['projectId'] + '.json')).read_text(encoding='utf-8'))
        self.assertTrue(mapping['deleted'])
        self.assertFalse((self.root / 'data' / 'projects' / mapping['project']).exists())
        self.assertIsNotNone(self.call('project')['project'])
        for action in ('blank_script', 'legacy_merge', 'upload_begin'):
            with self.assertRaises(urllib.error.HTTPError) as rejected:
                self.call(action, **scope)
            self.assertEqual(json.loads(rejected.exception.read())['error'], 'studio_invalid_project')
            rejected.exception.close()

    def test_delete_uninitialized_project(self):
        scope = {'projectId': '12345678-1234-1234-1234-123456789032',
                 'episodeId': '12345678-1234-1234-1234-123456789033'}
        self.assertTrue(self.call('project_delete', **scope)['ok'])
        self.assertTrue(self.call('project_delete', **scope)['ok'])

    def test_asset_crud_and_script_revision(self):
        self.call('asset_create', category='characters', data={'name':'离线验收角色','description':'第一版','voice_style':'轻柔'})
        self.call('asset_update', category='characters', id='离线验收角色', data={'description':'第二版'})
        project = self.call('project')['project']
        self.assertEqual(project['characters']['离线验收角色']['description'], '第二版')
        snapshot = self.call('script', id='episode_1.json')
        data = {'scriptFile':'episode_1.json','revision':snapshot['revision'],'operations':[{'op':'update','id':'E1S01','fields':{'scene_description':'updated offline'}}]}
        result = self.call('script_edit', data=data)
        self.assertTrue(result['success'])
        with self.assertRaises(urllib.error.HTTPError) as stale:
            self.call('script_edit', data=data)
        self.assertEqual(stale.exception.code,409); stale.exception.close()
        self.assertEqual(self.call('script', id='episode_1.json')['script']['scenes'][0]['scene_description'],'updated offline')
        inserted = self.call('script_insert', data={'afterId':'E1S01'})
        self.assertNotEqual(inserted['item']['scene_id'], 'E1S01')
        latest = self.call('script', id='episode_1.json')
        self.call('script_edit', data={'scriptFile':'episode_1.json','revision':latest['revision'],'operations':[{'op':'remove','id':inserted['item']['scene_id']}]})

    def test_session_scope_and_path_validation(self):
        self.assertEqual(self.call('sessions')['sessions'], [])
        self.assertTrue(self.call('session_new')['ok'])
        for action, kwargs in [('script', {'id':'../project.json'}), ('session_select', {'id':'foreign-session'}), ('timeline_delete', {'id':'../other'})]:
            with self.assertRaises(urllib.error.HTTPError) as rejected:
                self.call(action, **kwargs)
            self.assertEqual(rejected.exception.code,409); rejected.exception.close()

    def test_shared_assets_versions_and_episode_isolation(self):
        import io
        from PIL import Image
        other = '12345678-1234-1234-1234-123456789014'
        self.call('asset_create', category='characters', data={'name': '共享角色', 'description': '两集共用'})
        self.call('blank_script', episodeId=other, episodeTitle='第二集', sourceText='第二集原文', episodeIds=[self.ids['episodeId'], other])
        second = self.call('project', episodeId=other)
        self.assertEqual(second['project']['characters']['共享角色']['description'], '两集共用')
        self.assertEqual(second['episodeNumber'], 2)
        self.assertEqual(self.call('project')['project']['episodes'][0]['episode'], 1)
        insert = self.call('script_insert', episodeId=other)
        self.assertTrue(insert['item']['scene_id'].startswith('E2'))
        self.call('asset_update', episodeId=other, category='characters', id='共享角色', data={'description':'第二集更新'})
        self.assertEqual(self.call('project')['project']['characters']['共享角色']['description'], '第二集更新')
        self.call('derivative_create', id='共享角色', data={'name':'雨衣', 'description':'穿黄色雨衣'})
        self.assertIn('雨衣', self.call('project', episodeId=other)['project']['characters']['共享角色']['derivatives'])
        for color in ('green', 'blue'):
            buffer = io.BytesIO(); Image.new('RGB', (64,64), color).save(buffer, 'PNG'); raw = buffer.getvalue()
            upload = self.call('upload_begin', data={'kind':'character', 'name':'共享角色', 'filename':'asset.png', 'size':len(raw)})['id']
            self.call('upload_chunk', id=upload, data={'offset':0, 'chunk':base64.b64encode(raw).decode()})
            self.call('upload_finish', id=upload)
        versions = self.call('versions', episodeId=other, category='characters', id='共享角色')
        self.assertEqual(len(versions['versions']), 2)
        self.call('version_restore', episodeId=other, category='characters', id='共享角色', data={'version':1})
        self.assertEqual(self.call('versions', category='characters', id='共享角色')['current_version'], 1)
        self.call('asset_create', category='characters', data={'name':'别名角色', 'description':'合并测试'})
        preview = self.call('asset_merge', category='characters', id='别名角色', data={'target':'共享角色', 'dryRun':True})
        self.assertTrue(preview['dry_run'])
        self.assertIn('别名角色', self.call('project')['project']['characters'])
        self.call('asset_merge', category='characters', id='别名角色', data={'target':'共享角色', 'dryRun':False})
        self.assertNotIn('别名角色', self.call('project', episodeId=other)['project']['characters'])
        original = self.call('script', id='episode_1.json')['script']
        self.assertFalse(any(s['scene_id'].startswith('E2') for s in original['scenes']))

    def test_attachment_scope_validation_and_persistence(self):
        import io
        from PIL import Image
        buffer = io.BytesIO(); Image.new('RGB', (80, 60), 'red').save(buffer, 'PNG'); raw = buffer.getvalue()
        upload = self.call('upload_begin', data={'kind':'attachment', 'filename':'reference.png', 'size':len(raw)})['id']
        other = '12345678-1234-1234-1234-123456789015'
        with self.assertRaises(urllib.error.HTTPError) as rejected:
            self.call('upload_chunk', episodeId=other, id=upload, data={'offset':0,'chunk':base64.b64encode(raw).decode()})
        rejected.exception.close()
        self.call('upload_chunk', id=upload, data={'offset':0, 'chunk':base64.b64encode(raw).decode()})
        attachment = self.call('upload_finish', id=upload)
        preview = self.call('attachment_preview', id=attachment['id'])
        self.assertTrue(preview['url'].startswith('data:image/jpeg;base64,'))
        with self.assertRaises(urllib.error.HTTPError) as rejected:
            self.call('attachment_preview', episodeId=other, id=attachment['id'])
        rejected.exception.close()
        # Stored bytes are real decoded image input to the original Agent contract.
        sys.path.insert(0, str(Path(__file__).parent))
        from conversation_api import attachment_path
        binding = 'studio-' + hashlib.sha256((self.ids['projectId'] + ':' + self.ids['episodeId']).encode()).hexdigest()[:32]
        with Image.open(attachment_path(self.root, binding, attachment['id'])) as image:
            self.assertEqual(image.size, (80, 60))

    def test_secondary_episode_created_before_primary(self):
        primary = '12345678-1234-1234-1234-123456789021'
        secondary = '12345678-1234-1234-1234-123456789022'
        scope = {'projectId': '12345678-1234-1234-1234-123456789020', 'episodeIds': [primary, secondary]}
        # Project initialization normally verifies a real account; seed only the
        # empty formal project so this regression stays entirely offline.
        name = 'studio-' + hashlib.sha256((scope['projectId'] + ':' + primary).encode()).hexdigest()[:32]
        seed = '''
import os,sys
os.environ['ARCREEL_DATA_DIR']=sys.argv[1]
os.chdir(os.environ['HUANGGUA_STUDIO_ENGINE']);sys.path.insert(0,os.getcwd())
from lib.project.project_manager import ProjectManager
pm=ProjectManager(sys.argv[1]);pm.create_project(sys.argv[2],content_mode='drama')
pm.create_project_metadata(sys.argv[2],'Out of order test',content_mode='drama')
'''
        subprocess.run([sys.executable, '-s', '-c', seed, str(self.root / 'data'), name], check=True, capture_output=True)
        self.call('blank_script', **scope, episodeId=secondary, episodeTitle='先创建第二集')
        second = self.call('project', **scope, episodeId=secondary)
        self.call('blank_script', **scope, episodeId=primary, episodeTitle='再创建第一集')
        first = self.call('project', **scope, episodeId=primary)
        self.assertNotEqual(first['episodeNumber'], second['episodeNumber'])
        self.assertEqual(first['project']['episodes'][0]['title'], '再创建第一集')
        self.assertEqual(self.call('project', **scope, episodeId=secondary)['project']['episodes'][0]['title'], '先创建第二集')

    def test_chunk_upload_and_timeline_contract(self):
        # A real decoded PNG passes the original upload validator and is hash-importable.
        import io
        from PIL import Image
        buffer=io.BytesIO(); Image.new('RGB',(64,64),'green').save(buffer,format='PNG'); raw=buffer.getvalue()
        upload=self.call('upload_begin',data={'kind':'storyboard','name':'E1S01','filename':'offline.png','size':len(raw)})['id']
        with self.assertRaises(urllib.error.HTTPError) as bad_offset:
            self.call('upload_chunk',id=upload,data={'offset':1,'chunk':base64.b64encode(raw).decode()})
        bad_offset.exception.close()
        self.call('upload_chunk',id=upload,data={'offset':0,'chunk':base64.b64encode(raw).decode()})
        self.call('upload_finish',id=upload)
        script=self.call('script',id='episode_1.json')['script']
        self.assertTrue(script['scenes'][0]['generated_assets']['storyboard_image'])
        self.assertEqual(self.call('timelines')['timelines'],[])
        with self.assertRaises(urllib.error.HTTPError) as blocked:
            self.call('timeline_create',data={'name':'No video'})
        self.assertEqual(blocked.exception.code,409); blocked.exception.close()
        # Upload a local FFmpeg test clip, then exercise the real timeline and render services.
        clip = self.root / 'offline.mp4'
        make_clip = '''
import os,sys,subprocess
os.chdir(os.environ['HUANGGUA_STUDIO_ENGINE']);sys.path.insert(0,os.getcwd())
from lib.infra.ffmpeg import ffmpeg_executable
subprocess.run([ffmpeg_executable(),'-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=green:s=160x90:r=24','-t','2','-c:v','libx264','-pix_fmt','yuv420p',sys.argv[1]],check=True,capture_output=True)
'''
        subprocess.run([sys.executable,'-s','-c',make_clip,str(clip)],check=True,capture_output=True)
        raw = clip.read_bytes()
        upload=self.call('upload_begin',data={'kind':'video','name':'E1S01','filename':'offline.mp4','size':len(raw)})['id']
        self.call('upload_chunk',id=upload,data={'offset':0,'chunk':base64.b64encode(raw).decode()})
        self.call('upload_finish',id=upload)
        self.call('timeline_create',data={'name':'Offline cut'})
        timeline=self.call('timelines')['timelines'][0]['id']
        readout=self.call('timeline_read',id=timeline)
        self.assertEqual(len(readout['clips']),1)
        self.assertEqual(self.call('timeline_media',id=timeline)['timeline_id'],timeline)
        self.call('timeline_rename',id=timeline,data={'name':'Renamed offline cut'})
        self.assertTrue(self.call('timeline_revisions',id=timeline)['revisions'])
        self.call('timeline_copy',id=timeline,data={'name':'Copy'})
        self.assertEqual(len(self.call('timelines')['timelines']),2)
        name=json.loads(self.request('/desktop/poll',self.ids))['project']
        render='''
import os,sys,asyncio
os.environ['ARCREEL_DATA_DIR']=sys.argv[1]
os.chdir(os.environ['HUANGGUA_STUDIO_ENGINE']);sys.path.insert(0,os.getcwd())
sys.path.insert(0,sys.argv[4])
from windows_compat import install_render_paths
install_render_paths()
from lib.project.project_manager import ProjectManager
from lib.final_cut.service import FinalCutService
from server.services.presentation.timeline_jianying_draft import TimelineJianyingDraftService
async def main():
 pm=ProjectManager(sys.argv[1])
 await FinalCutService(pm).render(sys.argv[2],sys.argv[3],narration='without_narration',subtitles='no_subtitles')
 await TimelineJianyingDraftService(pm).render(sys.argv[2],sys.argv[3],narration='without_narration')
asyncio.run(main())
'''
        result=subprocess.run([sys.executable,'-s','-c',render,str(self.root/'data'),name,timeline,str(Path(__file__).parent.resolve())],capture_output=True,text=True,encoding='utf-8')
        self.assertEqual(result.returncode,0,result.stderr[-2000:])
        self.assertEqual(self.call('timeline_render_status',id=timeline,data={'narration':'without_narration','subtitles':'no_subtitles'})['status'],'current')
        self.assertEqual(self.call('timeline_draft_status',id=timeline,data={'narration':'without_narration'})['status'],'current')
        self.assertEqual(self.call('timeline_export_draft',id=timeline,data={'directory':str(self.root/'export'),'version':'6'})['status'],'exported')


if __name__ == '__main__': unittest.main()
