import Select from '../shared/Select';
import ModalOverlay from '../shared/ModalOverlay';
import { useState } from 'react';
import { useT } from '../../i18n';
import { useAppStore } from '../../store/useAppStore';
import type { StudioStagingPrecheck } from '../../types/studio';
import { studioWorkspace, workspaceError, type StudioScope } from '../../services/studioWorkspaceService';
import { pollStudioExecutions } from '../../services/studioExecutionService';
import { useWorkspaceQuery } from './useWorkspaceQuery';
import { Feedback, type ProductionReply } from './StudioProductionSetup';
import StudioUpload from './StudioUpload';
import StudioStagingNotice from './StudioStagingNotice';

interface ShotSettings {
  overrides: { image?: string; video?: string };
  references?: { images?: string[]; videos?: string[] };
  ratios: string[];
  effective: { image: string; video: string };
  defaults: { image: string; video: string };
  recoverableVideoTask?: string;
}

export default function StudioShotGenerate({ scope, shotId, kind, formal, promptReady, imageReady, ensureFormalShot }: {
  scope: StudioScope; shotId: string; kind: 'image' | 'video'; formal: boolean; promptReady: boolean; imageReady: boolean;
  ensureFormalShot?: () => Promise<{ name?: string } | void>;
}) {
  const t = useT();
  const settings = useWorkspaceQuery<ShotSettings>(scope, 'shot_settings', shotId, formal);
  const execution = useAppStore(s => s.studioExecutions[`${scope.projectId}/${scope.episodeId}`]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [reply, setReply] = useState<ProductionReply>();
  const [submitted, setSubmitted] = useState<string>();
  const [precheck, setPrecheck] = useState<StudioStagingPrecheck | null>(null);
  const recovery = kind === 'video' ? settings.data?.recoverableVideoTask : undefined;
  const submittedTask = execution?.tasks.find(task => task.task_id === submitted);
  const active = (submitted && (!submittedTask || ['queued', 'running'].includes(submittedTask.status))) || execution?.tasks.some(task => task.resource_id === shotId && ['storyboard', 'video'].includes(task.task_type) && ['queued', 'running'].includes(task.status));
  const generating = (submitted && (!submittedTask || ['queued', 'running'].includes(submittedTask.status))) || execution?.tasks.some(task => task.resource_id === shotId && task.task_type === (kind === 'image' ? 'storyboard' : 'video') && ['queued', 'running'].includes(task.status));
  const unavailable = !formal ? '请先确认规划或上传本地素材初始化正式镜头。' : !promptReady ? '请先在脚本规划或镜头编辑中填写提示词。' : kind === 'video' && !imageReady ? '请先生成或上传本镜头的分镜图。' : '';

  const localImages = settings.data?.references?.images ?? [];
  const localVideos = settings.data?.references?.videos ?? [];
  const artifacts = execution?.artifacts ?? [];

  const saveRatio = async (ratio: string) => {
    setBusy(true); setMessage(''); setReply(undefined);
    try {
      await studioWorkspace(scope, 'shot_ratio', { id: shotId, data: { kind, ratio: ratio || null } });
      settings.refresh(); setMessage('比例已保存，仅影响本镜头后续生成。');
    } catch (error) { setMessage(workspaceError(error)); }
    finally { setBusy(false); }
  };

  const removeLocalRef = async (relPath: string) => {
    setBusy(true); setMessage('');
    try {
      await studioWorkspace(scope, 'local_ref_remove', { id: shotId, data: { scopeKind: 'shot', path: relPath } });
      settings.refresh(); await pollStudioExecutions();
    } catch (error) { setMessage(workspaceError(error)); }
    finally { setBusy(false); }
  };

  const openGenerateConfirm = async () => {
    if (recovery) { await executeGenerate(); return; }
    setBusy(true); setMessage(''); setReply(undefined);
    try {
      const checked = await studioWorkspace<StudioStagingPrecheck>(scope, 'shot_precheck', { id: shotId, data: { kind } });
      setPrecheck(checked);
    } catch (error) { setMessage(workspaceError(error)); }
    finally { setBusy(false); }
  };

  const executeGenerate = async () => {
    setBusy(true); setMessage(''); setReply(undefined);
    try {
      const result = await studioWorkspace<ProductionReply>(scope, recovery ? 'shot_recover' : 'shot_generate', { id: shotId, data: { kind, ...(recovery ? { taskId: recovery } : {}) } });
      setReply(result);
      setPrecheck(null);
      if (!result.rejected && typeof result.task_id === 'string') { setSubmitted(result.task_id); setMessage('生成任务已提交，可在制作进度中查看。'); }
      await pollStudioExecutions();
      settings.refresh();
    } catch (error) { setMessage(workspaceError(error)); }
    finally { setBusy(false); }
  };

  return <div className="mt-3 space-y-2">
    <div className="flex flex-wrap items-center gap-2">
      <StudioUpload scope={scope} kind="shot_ref_image" name={shotId} label={kind === 'image' ? '上传镜头参考图' : '上传附加参考图'} accept=".png,.jpg,.jpeg,.webp" disabled={busy || !!active} resolveTarget={ensureFormalShot} onComplete={() => settings.refresh()} />
      {kind === 'video' && <StudioUpload scope={scope} kind="shot_ref_video" name={shotId} label="上传镜头参考视频" accept=".mp4,.mov,.m4v,.webm" disabled={busy || !!active} resolveTarget={ensureFormalShot} onComplete={() => settings.refresh()} />}
    </div>
    {kind === 'image' && localImages.length > 0 && <div className="space-y-1 rounded border border-canvas-border bg-canvas-card p-2 text-xs">
      <p className="text-[11px] text-canvas-text-secondary">已绑定本地镜头参考图（保存在本地记录，生成时经规格确认后暂存转 URL）</p>
      <div className="flex flex-wrap gap-2">{localImages.map(path => {
        const art = artifacts.find(a => a.name === path);
        return <div key={path} className="w-24 space-y-1">{art?.url ? <img className="h-16 w-24 rounded object-cover" src={art.url} alt={path} /> : <span className="block truncate text-[10px]">{path.split('/').at(-1)}</span>}<button type="button" className="ui-btn ui-btn--ghost ui-btn--sm w-full" disabled={busy} onClick={() => void removeLocalRef(path)}>移除引用</button></div>;
      })}</div>
    </div>}
    {kind === 'video' && (localImages.length > 0 || localVideos.length > 0) && <div className="space-y-2 rounded border border-canvas-border bg-canvas-card p-2 text-xs">
      <p className="text-[11px] text-canvas-text-secondary">已绑定本地视频参考素材（保存在本地记录，生成视频时经规格确认后暂存转 URL）</p>
      <div className="flex flex-wrap gap-2">
        {localImages.map(path => {
          const art = artifacts.find(a => a.name === path);
          return <div key={path} className="w-28 space-y-1">{art?.url ? <img className="h-16 w-28 rounded object-cover" src={art.url} alt={path} /> : <span className="block truncate text-[10px]">{path.split('/').at(-1)}</span>}<button type="button" className="ui-btn ui-btn--ghost ui-btn--sm w-full" disabled={busy} onClick={() => void removeLocalRef(path)}>移除参考图</button></div>;
        })}
        {localVideos.map(path => {
          const art = artifacts.find(a => a.name === path);
          return <div key={path} className="w-40 space-y-1">{art?.url ? <video className="h-20 w-40 rounded bg-canvas-bg object-contain" src={art.url} controls preload="metadata" /> : <span className="block truncate text-[10px]">{path.split('/').at(-1)}</span>}<button type="button" className="ui-btn ui-btn--ghost ui-btn--sm w-full" disabled={busy} onClick={() => void removeLocalRef(path)}>移除参考视频</button></div>;
        })}
      </div>
    </div>}
    <div className="flex flex-wrap items-end gap-2">
      <label className="min-w-32 flex-1 text-xs">{t(kind === 'image' ? '图片比例' : '视频比例')}
        <Select aria-label={t(kind === 'image' ? '图片比例' : '视频比例')} className="mt-1 w-full" disabled={!settings.data || !settings.ready || busy || !!active} value={settings.data?.overrides[kind] ?? ''} onChange={value => void saveRatio(value)} options={[{ value: '', label: `${t('跟随项目')} · ${settings.data?.defaults[kind] ?? '—'}` }, ...(settings.data?.ratios ?? ['9:16', '16:9', '4:3', '3:4', '1:1']).map(value => ({ value, label: value }))]} />
      </label>
      <button className="ui-btn ui-btn--primary" disabled={!settings.ready || !settings.data || busy || !!active || (!!unavailable && !recovery)} onClick={() => void openGenerateConfirm()}>{t(busy ? '处理中…' : generating ? '执行中' : recovery ? '取回视频结果' : kind === 'image' ? '生成图片' : '生成视频')}</button>
    </div>
    {unavailable ? <p className="text-xs text-canvas-text-muted">{t(unavailable)}</p> : <p className="text-[10px] text-canvas-text-muted">{t('点击生成将先核对目标规格与本地参考素材；确认后暂存至黄瓜 AI 服务器转 URL 提交上游。')}</p>}
    {message && <p role="status" className="text-xs">{t(message)}</p>}
    {recovery && <p role="status" className="text-xs">{t('视频下载未完成，可取回原任务结果，不会重新生成。')}</p>}
    {kind === 'video' && <p className="text-[10px] text-canvas-text-muted">{t('首帧比例不同时会补边适配视频画幅，原分镜图保持不变。')}</p>}
    {settings.error && formal && <p role="alert" className="text-xs">{t(settings.error)}</p>}
    {reply?.rejected && <div role="alert" className="ui-alert"><Feedback value={reply.diagnostic} /></div>}
    <ModalOverlay isOpen={!!precheck} onClose={() => !busy && setPrecheck(null)} ariaLabel={t('确认生成规格与素材暂存')} zIndex={470} className="studio-editor ui-scroll max-h-[85vh] w-[min(640px,92vw)] space-y-3 overflow-auto p-3">
      <h2 className="text-sm font-semibold">{kind === 'image' ? '确认图片参考生成规格' : '确认视频参考生成规格'}</h2>
      <p className="text-xs text-canvas-text-secondary">生成将使用当前分集配置的黄瓜 AI 模型并消耗账号余额。请核对以下规格与参考素材清单：</p>
      {precheck && <StudioStagingNotice precheck={precheck} />}
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" className="ui-btn" disabled={busy} onClick={() => setPrecheck(null)}>{t('取消')}</button>
        <button type="button" className="ui-btn ui-btn--primary" disabled={busy || precheck?.allowed === false} onClick={() => void executeGenerate()}>{busy ? '正在暂存并提交…' : '确认规格并生成'}</button>
      </div>
    </ModalOverlay>
  </div>;
}
