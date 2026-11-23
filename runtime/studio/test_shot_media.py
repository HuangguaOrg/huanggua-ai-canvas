"""Isolated, non-billable checks of per-shot ratios and upstream provenance."""
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.error
import unittest
import tempfile

from runtime.studio.test_workspace import WorkspaceTest


class FrameRatioTest(unittest.IsolatedAsyncioTestCase):
    async def test_frame_copy_matches_ratio_and_keeps_original(self):
        sys.path.insert(0, os.environ['HUANGGUA_STUDIO_ENGINE'])
        from runtime.studio.shot_media import install_frame_ratios
        from lib.backends.huanggua import HuangguaVideoBackend
        from arcreel_market_core.video_backend_contract import VideoGenerationRequest
        from PIL import Image
        from unittest.mock import patch
        seen = []

        async def payload(backend, request):
            with Image.open(request.start_image) as frame:
                self.assertEqual(frame.size, (576, 1024))
                self.assertEqual(frame.getpixel((288, 512)), (0, 255, 0))
                self.assertEqual(frame.getpixel((0, 0)), (255, 255, 255))
            seen.append(request.start_image)
            return {'aspect_ratio':request.aspect_ratio}

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source.png'
            frame = Image.new('RGB', (100, 100), 'white')
            frame.paste((0, 255, 0), (20, 20, 80, 80)); frame.save(source)
            before = source.read_bytes()
            with patch.object(HuangguaVideoBackend, 'payload', payload):
                install_frame_ratios()
                try:
                    result = await HuangguaVideoBackend.payload(None, VideoGenerationRequest(prompt='test', output_path=Path(directory)/'video.mp4', start_image=source, aspect_ratio='9:16'))
                    self.assertEqual(result, {'aspect_ratio':'9:16'})
                finally:
                    del HuangguaVideoBackend._desktop_frame_ratios
            self.assertEqual(source.read_bytes(), before)
            self.assertFalse(seen[0].exists())


class ShotMediaTest(WorkspaceTest):

    def test_override_inheritance_and_formal_scope(self):
        self.call('project_settings', data={'aspect_ratio': '16:9', 'style': 'test style'})
        read = lambda: self.call('shot_settings', id='E1S01')
        self.assertEqual(read()['effective'], {'image': '16:9', 'video': '16:9'})
        self.call('shot_ratio', id='E1S01', data={'kind': 'image', 'ratio': '1:1'})
        self.assertEqual(read()['effective'], {'image': '1:1', 'video': '16:9'})
        self.assertEqual(self.call('project')['project']['aspect_ratio'], '16:9')
        self.call('project_settings', data={'aspect_ratio': '9:16'})
        self.assertEqual(read()['effective'], {'image': '1:1', 'video': '9:16'})
        for target, data in [('E999S01', {'kind': 'image', 'ratio': '1:1'}), ('E1S01', {'kind': 'image', 'ratio': 'invalid'})]:
            with self.assertRaises(urllib.error.HTTPError) as result:
                self.call('shot_ratio', id=target, data=data)
            result.exception.close()
        self.call('shot_ratio', id='E1S01', data={'kind': 'image', 'ratio': None})
        self.assertEqual(read()['effective'], {'image': '9:16', 'video': '9:16'})

    def test_four_three_three_four_and_custom_resolutions(self):
        from runtime.studio.shot_media import closest_supported_ratio, normalize_custom_resolution
        self.call('project_settings', data={'aspect_ratio': '4:3', 'custom_resolution': None})
        self.assertEqual(self.call('project')['project']['aspect_ratio'], '4:3')
        self.assertIn('4:3', self.call('shot_settings', id='E1S01')['ratios'])
        self.assertIn('3:4', self.call('shot_settings', id='E1S01')['ratios'])

        self.call('project_settings', data={'aspect_ratio': '3:4', 'custom_resolution': '1080x1440'})
        proj = self.call('project')['project']
        self.assertEqual(proj['aspect_ratio'], '3:4')
        self.assertEqual(proj['desktop_custom_resolution'], '1080x1440')

        self.call('project_settings', data={'aspect_ratio': '12:5', 'custom_resolution': '1920x800'})
        shot_info = self.call('shot_settings', id='E1S01')
        self.assertEqual(shot_info['effective'], {'image': '12:5', 'video': '12:5'})
        self.assertIn('12:5', shot_info['ratios'])
        self.assertEqual(shot_info['customResolution'], '1920x800')

        self.call('project_settings', data={'aspect_ratio': '9:16', 'custom_resolution': None})
        self.assertIsNone(self.call('project')['project'].get('desktop_custom_resolution'))
        self.assertEqual(normalize_custom_resolution('1081x1351'), '1082x1352')
        self.assertEqual(closest_supported_ratio('3:4', ('16:9', '9:16')), '9:16')
        self.assertEqual(closest_supported_ratio('4:3', ('16:9', '9:16')), '16:9')
        self.assertEqual(closest_supported_ratio('12:5', ('1:1', '16:9', '9:16', '4:3', '3:4', '21:9')), '21:9')

    def test_real_input_and_currency_share_override(self):
        # Run before engine imports, just like desktop bootstrap. No model/network.
        code = r'''
import os, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1]); sys.path.insert(0, os.environ['HUANGGUA_STUDIO_ENGINE'])
from shot_media import install_ratio_support, shot_ratio
install_ratio_support(Path(os.environ['HUANGGUA_STUDIO_ENGINE']))
from lib.artifacts.generation_input import storyboard_image_input
from lib.artifacts.media_artifact_currency import _storyboard_visual_basis
project={'content_mode':'drama','aspect_ratio':'16:9','desktop_shot_ratios':{'E1S01':{'image':'1:1','video':'9:16'}}}
item={'scene_id':'E1S01','image_prompt':'test image','video_prompt':'test video','characters_in_scene':[],'scenes':[],'props':[],'generated_assets':{}}
script={'episode':1,'content_mode':'drama','scenes':[item]}
image=storyboard_image_input(project,script,episode=1,resource_id='E1S01',observation=None)
assert image.canvas_ratio=='1:1'
assert not image.gaps
basis=_storyboard_visual_basis(project_path=Path(sys.argv[2]),project=project,item=item,resource_id='E1S01',record_gaps=True)
expected=_storyboard_visual_basis(project_path=Path(sys.argv[2]),project={**project,'aspect_ratio':'9:16','desktop_shot_ratios':{}},item=item,resource_id='E1S01',record_gaps=True)
default=_storyboard_visual_basis(project_path=Path(sys.argv[2]),project={**project,'desktop_shot_ratios':{}},item=item,resource_id='E1S01',record_gaps=True)
assert basis==expected
assert basis!=default
assert shot_ratio(project,'E1S02','image')=='16:9'
assert project['aspect_ratio']=='16:9'
print('image input, video currency, adjacent shot and project isolation: OK')
'''
        result = subprocess.run([sys.executable, '-s', '-c', code, str(Path(__file__).parent.resolve()), str(self.root)], capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stderr[-3000:])

    def test_manual_submit_reads_formal_prompt_and_blocks_active_target(self):
        name = json.loads(self.request('/desktop/poll', self.ids))['project']
        code = r'''
import asyncio, os, sys
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, sys.argv[1]); sys.path.insert(0, os.environ['HUANGGUA_STUDIO_ENGINE'])
os.environ['ARCREEL_DATA_DIR']=sys.argv[2]
from shot_media import shot_operation
from lib.project.project_manager import get_project_manager
pm=get_project_manager(); name=sys.argv[3]; project=pm.load_project(name)
active=False
task={'project_name':name,'resource_id':'E1S01','script_file':'episode_1.json'}
async def checked(client,method,path,payload=None):
    if '/tasks?' in path:
        return {'items':[{'resource_id':'E1S01','task_type':'storyboard'}] if active else []}
    if path.startswith('tasks/'):
        return {'task':task}
    return {'project':project}
class Client:
    calls=[]
    async def request(self,method,path,json):
        self.calls.append((method,path,json))
        return SimpleNamespace(is_success=True,content=b'{}',json=lambda:{'success':True,'task_id':'test-task'})
async def run():
    global active
    client=Client()
    body={'_episode':1,'id':'E1S01','action':'shot_generate','data':{'kind':'image','prompt':'untrusted override'}}
    result=await shot_operation(name,body,client,checked)
    assert result['task_id']=='test-task'
    assert client.calls[0]==('POST',f'projects/{name}/generate/storyboard/E1S01',{'script_file':'episode_1.json','prompt':'image'})
    active=True
    try: await shot_operation(name,body,client,checked)
    except ValueError as error: assert str(error)=='studio_shot_busy'
    else: raise AssertionError('active target accepted')
    assert len(client.calls)==1
    active=False
    body.update(action='shot_recover',data={'kind':'video','taskId':'test-task'})
    result=await shot_operation(name,body,client,checked)
    assert result['task_id']=='test-task'
    assert client.calls[-1]==('POST','tasks/test-task/retry-download',{})
    task['script_file']='episode_2.json'
    try: await shot_operation(name,body,client,checked)
    except ValueError as error: assert str(error)=='studio_invalid_task'
    else: raise AssertionError('cross-episode recovery accepted')
    assert len(client.calls)==2
asyncio.run(run())
'''
        result = subprocess.run([sys.executable, '-s', '-c', code, str(Path(__file__).parent.resolve()), str(self.root / 'data'), name], capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stderr[-3000:])
