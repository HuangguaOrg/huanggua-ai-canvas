import { useState } from 'react';
import { useT } from '../../i18n';
import type { StudioProject, StudioEpisode } from '../../types/studio';
import { studioRequest, pollStudioExecutions } from '../../services/studioExecutionService';
import { studioWorkspace, workspaceError } from '../../services/studioWorkspaceService';
import { useWorkspaceQuery } from './useWorkspaceQuery';
import ModalOverlay from '../shared/ModalOverlay';
import StudioPlanContent from './StudioPlanContent';

interface Review { status: string; fingerprint: string | null; content: Record<string, unknown> | null; quarantine?: unknown; script_overwrite?: { revision: string; text: string } | null }
export default function StudioPlanning({ project, episode }: { project: StudioProject; episode: StudioEpisode }) {
  const t = useT(); const scope = { projectId: project.id, episodeId: episode.id };
  const detail = useWorkspaceQuery<{ project: { episodes?: Array<{ script_file?: string }> } | null; scripts?: Record<string, unknown> }>(scope, 'project');
  const scriptFile = detail.data?.project?.episodes?.[0]?.script_file?.replace(/^scripts\//, '');
  const hasScript = !!scriptFile && !!detail.data?.scripts?.[scriptFile];
  const review = useWorkspaceQuery<Review>(scope, 'review', undefined, !!detail.data?.project);
  const [action, setAction] = useState<'source_save' | 'plan_generate' | 'prompts_generate' | 'review_confirm' | 'review_save' | 'blank_script' | null>(null);
  const [snapshot, setSnapshot] = useState<Review>();
  const [content, setContent] = useState<unknown>(null); const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  const choose = (value: typeof action) => { setSnapshot(review.data); setContent(review.data?.content); setAction(value); setMessage(''); };
  const execute = async () => {
    setBusy(true); setMessage('');
    try {
      await studioRequest('workspace', { ...scope, action: 'initialize', title: `${project.name} · ${episode.name}`, episodeTitle: episode.name, sourceText: episode.script, models: episode.models ?? {} });
      const data = action === 'source_save' ? { text: episode.script, source_kind: 'screenplay', confirm: true }
        : action === 'review_save' ? { content, fingerprint: snapshot?.fingerprint }
          : action === 'review_confirm' ? { revision: snapshot?.script_overwrite?.revision } : { instructions };
      await studioWorkspace(scope, action!, { data });
      setAction(null); setMessage(action?.endsWith('generate') ? '已加入制作队列，结果会自动显示。' : '已保存');
      detail.refresh(); review.refresh(); await pollStudioExecutions();
    } catch (e) { setMessage(e instanceof SyntaxError ? '内容格式不正确，请检查后保存。' : workspaceError(e)); } finally { setBusy(false); }
  };
  return <section className="space-y-4 rounded-lg border border-canvas-border bg-canvas-surface p-4">
    <div className="flex flex-wrap gap-2"><button className="ui-btn ui-btn--sm" disabled={!detail.ready || hasScript} onClick={() => choose('blank_script')}>{t('从空白开始')}</button><button className="ui-btn ui-btn--sm" disabled={!detail.ready || !episode.script.trim()} onClick={() => choose('source_save')}>{t('同步本集原文')}</button><button className="ui-btn ui-btn--primary ui-btn--sm" disabled={!detail.ready} onClick={() => choose('plan_generate')}>{t('AI 规划脚本')}</button><button className="ui-btn ui-btn--sm" disabled={!detail.data?.project} onClick={() => choose('prompts_generate')}>{t('AI 编写提示词')}</button><button className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => { detail.refresh(); review.refresh(); }}>{t('刷新')}</button></div>
    {message && <p role="status" className="text-xs">{t(message)}</p>}
    {review.data?.content && <><h3 className="text-sm">{t('脚本规划与内容确认')}</h3><div className="ui-scroll max-h-96 overflow-auto"><StudioPlanContent value={review.data.content} /></div><div className="flex gap-2"><button className="ui-btn ui-btn--sm" disabled={review.data.status === 'confirmed'} onClick={() => choose('review_save')}>{t('编辑规划内容')}</button><button className="ui-btn ui-btn--primary ui-btn--sm" disabled={review.data.status === 'confirmed' || !!review.data.quarantine} onClick={() => choose('review_confirm')}>{t(review.data.status === 'confirmed' ? '内容已确认' : '确认内容并转为正式脚本')}</button></div>{!!review.data.quarantine && <p className="ui-alert text-xs">{t('规划草稿仍有待修复内容，请让 Agent 修复后再确认。')}</p>}</>}
    <ModalOverlay isOpen={!!action} onClose={() => !busy && setAction(null)} ariaLabel={t('脚本操作')} zIndex={400} className="studio-editor ui-scroll max-h-[85vh] w-[min(680px,90vw)] overflow-auto p-5">
      <form className="space-y-4" onSubmit={e => { e.preventDefault(); void execute(); }}>
        <h2>{t(action === 'source_save' ? '将本集原文同步到制作项目？已有规划可能需要更新。' : action === 'plan_generate' ? '生成新的脚本规划？已有规划将被替换，模型调用使用账号余额。' : action === 'prompts_generate' ? '为正式脚本补写提示词，模型调用使用账号余额。' : action === 'review_confirm' ? '确认这份规划并转为正式脚本？' : action === 'blank_script' ? '创建空白正式脚本？尚未确认的规划将被弃置。' : '编辑脚本规划')}</h2>
        {action === 'review_confirm' && snapshot?.script_overwrite && <p className="ui-alert whitespace-pre-wrap text-xs">{snapshot.script_overwrite.text}</p>}
        {action === 'review_save' && <StudioPlanContent value={content} onChange={setContent} />}
        {action?.endsWith('generate') && <label className="block text-xs">{t('附加要求')}<textarea className="ui-input mt-2" rows={4} value={instructions} onChange={e => setInstructions(e.target.value)} /></label>}
        {message && <p role="alert" className="ui-alert text-xs">{t(message)}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="ui-btn" disabled={busy} onClick={() => setAction(null)}>{t('取消')}</button><button className="ui-btn ui-btn--primary" disabled={busy}>{t(busy ? '正在处理…' : '确认')}</button></div>
      </form>
    </ModalOverlay>
  </section>;
}
