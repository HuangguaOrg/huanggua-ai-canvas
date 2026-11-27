import os,sys,json,tempfile,hashlib,zipfile,requests,concurrent.futures,http.client,ssl,uuid,socket,contextlib,shutil,time
from pathlib import Path
c=json.loads(Path('release-transfer.json').read_text())
c['token']=os.environ['TEMP_GITEE_TOKEN']
c['mac_url']=None
with requests.get('https://gitee.com/api/v5/repos/'+c['repo']+'/releases/'+str(c['release_id'])+'/attach_files',params={'access_token':c['token']},timeout=60) as r:
 r.raise_for_status();c['existing']=[a['name'] for a in r.json()]

def digest(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
def download(url,p,expected):
 if p.is_file() and digest(p)==expected:
  print('REUSING_VERIFIED',p.name,flush=True);return
 with requests.get(url,stream=True,timeout=(30,120)) as r:
  r.raise_for_status()
  with p.open('wb') as f:
   for b in r.iter_content(1024*1024):f.write(b)
 assert digest(p)==expected
 print('DOWNLOAD_VERIFIED',p.name,flush=True)
def work(folder,meta):
 p=folder/meta['name'];assert p.stat().st_size==meta['size'] and digest(p)==meta['sha256']
 endpoint=f"/api/v5/repos/{c['repo']}/releases/{c['release_id']}/attach_files"
 if meta['name'] not in c['existing']:
  boundary='----'+uuid.uuid4().hex
  prefix=(f'--{boundary}\r\nContent-Disposition: form-data; name="access_token"\r\n\r\n'+c['token']+f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{p.name}"\r\nContent-Type: application/octet-stream\r\n\r\n').encode()
  suffix=f'\r\n--{boundary}--\r\n'.encode()
  print('UPLOADING',p.name,flush=True)
  conn=http.client.HTTPSConnection('gitee.com',timeout=180)
  conn.putrequest('POST',endpoint);conn.putheader('Content-Type',f'multipart/form-data; boundary={boundary}');conn.putheader('Content-Length',len(prefix)+p.stat().st_size+len(suffix));conn.putheader('User-Agent','HuangGuaAI-Release');conn.endheaders()
  conn.send(prefix);sent=0;last=0
  with p.open('rb') as f:
   for b in iter(lambda:f.read(1024*1024),b''):
    conn.send(b);sent+=len(b)
    if sent-last>=4*1024*1024:print('UPLOAD_MIB',p.name,sent//1048576,flush=True);last=sent
  conn.send(suffix);r=conn.getresponse();raw=r.read();assert r.status in (200,201),f'Upload status {r.status}'
  uploaded=json.loads(raw);assert uploaded['browser_download_url']==meta['url'];conn.close()
  print('UPLOADED',p.name,flush=True)
 h=hashlib.sha256();size=0
 with requests.get(meta['url'],stream=True,timeout=(30,120)) as r:
  r.raise_for_status()
  for b in r.iter_content(1024*1024):h.update(b);size+=len(b)
 assert h.hexdigest()==meta['sha256'] and size==meta['size']
 print('VERIFIED_JSON '+json.dumps(dict(meta,release_id=c['release_id'])),flush=True)
try:
 with contextlib.nullcontext('payload') as d:
  folder=Path(d)
  with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
   jobs=[pool.submit(download,'file://unused',folder/'mac.zip',c['mac_hash']),pool.submit(download,c['win_url'],folder/c['files'][0]['name'],c['files'][0]['sha256'])]
   for j in jobs:j.result()
  with zipfile.ZipFile(folder/'mac.zip') as z:
   for info in z.infolist():
    if info.is_dir():continue
    name=Path(info.filename).name
    if name in {v['name'] for v in c['files']}:(folder/name).write_bytes(z.read(info))
  with concurrent.futures.ThreadPoolExecutor(max_workers=7) as pool:
   list(pool.map(lambda m:work(folder,m),c['files']))
 print('ALL_REMOTE_ATTACHMENTS_VERIFIED',len(c['files']),flush=True)

except Exception as e:
 print('REMOTE_FAILURE',type(e).__name__,flush=True);sys.exit(1)
