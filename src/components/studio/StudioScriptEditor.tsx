import { useState } from 'react';
import { useT } from '../../i18n';
import { studioWorkspace, workspaceError, type StudioScope } from '../../services/studioWorkspaceService';
import { pollStudioExecutions } from '../../services/studioExecutionService';
import ModalOverlay from '../shared/ModalOverlay';
import StudioUpload from './StudioUpload';
import StudioVersions from './StudioVersions';
import { useAppStore } from '../../store/useAppStore';

const emptyArtifacts: import('../../types/studio').StudioArtifact[] = [];
export default function StudioScriptEditor({ scope, shotId }: { scope: StudioScope; shotId: string }) {
  const t = useT();
  const artifacts = useAppStore(s => s.studioExecutions[`${scope.projectId}/${scope.episodeId}`]?.artifacts ?? emptyArtifacts);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [snapshot, setSnapshot] = useState<{ file: string; revision: string; scenes: Array<Record<string, unknown>> }>();
  const [description, setDescription] = useState('');
  const [duration, setDuration] = useState(5);
  const [image, setImage] = useState('');
  const [video, setVideo] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const load = async (preserveDraft = false) => {
    setOpen(true); setBusy(true); setError(''); setConfirmDelete(false); setSnapshot(undefined);
    try {
      const detail = await studioWorkspace<{ project: { episodes: Array<{ script_file?: string }> } }>(scope, 'project');
      const file = detail.project.episodes[0]?.script_file?.replace(/^scripts\//, '');
      if (!file) throw new Error('missing script');
      const result = await studioWorkspace<{ revision: string; script: { scenes: Array<Record<string, unknown>> } }>(scope, 'script', { id: file });
      const scene = result.script.scenes.find(s => s.scene_id === shotId);
      if (!scene) throw new Error('missing shot');
      setSnapshot({ file, revision: result.revision, scenes: result.script.scenes });
      if (!preserveDraft) {
        setDescription(String(scene.scene_description ?? '')); setDuration(Number(scene.duration_seconds ?? 5));
        setImage(typeof scene.image_prompt === 'string' ? scene.image_prompt : JSON.stringify(scene.image_prompt ?? {}, null, 2));
        setVideo(typeof scene.video_prompt === 'string' ? scene.video_prompt : JSON.stringify(scene.video_prompt ?? {}, null, 2));
      }
    } catch (e) { setError(workspaceError(e)); } finally { setBusy(false); }
  };
  const save = async (kind: 'update' | 'remove' | 'up' | 'down') => {
    if (!snapshot) return;
    setBusy(true); setError('');
    try {
      const parse = (value: string) => value.trim().startsWith('[') || value.trim().startsWith('{') ? JSON.parse(value) : value;
      const index = snapshot.scenes.findIndex(s => s.scene_id === shotId);
      const operation = kind === 'update' ? { op: 'update', id: shotId, fields: { scene_description: description, duration_seconds: duration, image_prompt: parse(image), video_prompt: parse(video) } }
        : kind === 'remove' ? { op: 'remove', id: shotId }
          : { op: 'move_after', id: shotId, after_id: kind === 'up' ? snapshot.scenes[index - 2]?.scene_id ?? null : snapshot.scenes[index + 1]?.scene_id };
      await studioWorkspace(scope, 'script_edit', { data: { scriptFile: snapshot.file, revision: snapshot.revision, operations: [operation] } });
      setOpen(false); await pollStudioExecutions();
    } catch (e) { setError(e instanceof SyntaxError ? '提示词 JSON 格式不正确，请检查后保存。' : workspaceError(e)); } finally { setBusy(false); }
  };
  const index = snapshot?.scenes.findIndex(s => s.scene_id === shotId) ?? -1;
  return <><button className="ui-btn ui-btn--sm" onClick={() => void load()}>{t('编辑正式分镜')}</button><ModalOverlay isOpen={open} onClose={() => !busy && setOpen(false)} ariaLabel={t('编辑正式分镜')} zIndex={400} className="studio-editor ui-scroll max-h-[85vh] w-[min(680px,90vw)] overflow-y-auto p-5">
    <form className="space-y-4" onSubmit={e => { e.preventDefault(); void save('update'); }}><div className="flex justify-between"><h2>{shotId} · {t('编辑正式分镜')}</h2><button type="button" className="ui-btn ui-btn--sm" disabled={busy} onClick={() => setOpen(false)}>{t('关闭')}</button></div>
      {snapshot && <><label className="block text-xs">{t('画面描述')}<textarea className="ui-input mt-2" rows={5} value={description} onChange={e => setDescription(e.target.value)} /></label><label className="block text-xs">{t('镜头时长')}<input type="number" min={1} max={120} required className="ui-input mt-2" value={duration} onChange={e => setDuration(Number(e.target.value))} /></label>
        <div className="flex gap-2"><StudioUpload scope={scope} kind="storyboard" name={shotId} label="上传分镜图" accept=".png,.jpg,.jpeg,.webp" onComplete={() => void load(true)} /><StudioUpload scope={scope} kind="video" name={shotId} label="上传镜头视频" accept=".mp4,.webm,.mov" onComplete={() => void load(true)} /></div>
        <div className="flex gap-2"><span className="text-xs">分镜图</span><StudioVersions scope={scope} category="storyboards" name={shotId} artifacts={artifacts} /><span className="text-xs">视频</span><StudioVersions scope={scope} category="videos" name={shotId} artifacts={artifacts} /></div><label className="block text-xs">{t('图片提示词')}<textarea className="ui-input mt-2 font-mono text-xs" rows={6} value={image} onChange={e => setImage(e.target.value)} /></label><label className="block text-xs">{t('视频提示词')}<textarea className="ui-input mt-2 font-mono text-xs" rows={6} value={video} onChange={e => setVideo(e.target.value)} /></label>
        <div className="flex flex-wrap gap-2"><button className="ui-btn ui-btn--primary" disabled={busy}>{t('保存修改')}</button><button type="button" className="ui-btn" disabled={busy || index <= 0} onClick={() => void save('up')}>{t('上移')}</button><button type="button" className="ui-btn" disabled={busy || index >= snapshot.scenes.length - 1} onClick={() => void save('down')}>{t('下移')}</button><button type="button" className="ui-btn" disabled={busy} onClick={() => setConfirmDelete(!confirmDelete)}>{t('删除镜头')}</button></div>
        {confirmDelete && <div className="ui-alert text-xs">{t('将删除脚本中的此镜头，已有资源仍保留。')}<button type="button" className="ui-btn ml-3" disabled={busy} onClick={() => void save('remove')}>{t('确认删除')}</button></div>}
      </>}
      {error && <p role="alert" className="ui-alert text-xs">{t(error)} <button type="button" className="ui-btn ui-btn--sm" onClick={() => void load()}>{t('重新读取')}</button></p>}
    </form>
  </ModalOverlay></>;
}
