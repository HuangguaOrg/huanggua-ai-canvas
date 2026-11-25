import Select from '../shared/Select';
import { useAppStore } from '../../store/useAppStore';
import { pollStudioExecutions } from '../../services/studioExecutionService';
import { useT } from '../../i18n';
import type { StudioArtifact } from '../../types/studio';
import { useEffect, useState } from 'react';
import ModalOverlay from '../shared/ModalOverlay';
import { copyLocalFileStreamed } from '../../services/fileService';
import { localMediaUrlToPath } from '../../utils/mediaUrl';
import { save } from '@tauri-apps/plugin-dialog';

export default function StudioResults({ projectId, episodeId }: { projectId: string; episodeId: string }) {
  const execution = useAppStore(s => s.studioExecutions[`${projectId}/${episodeId}`]);
  const t = useT();
  const visible = execution?.artifacts.filter(a => !a.name.startsWith('versions/')) ?? [];
  if (!visible.length) return null;
  return <section className="mt-6 border-t border-canvas-border pt-4"><div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-medium">{t('生成资源')}</h3><button className="ui-btn ui-btn--sm" onClick={() => void pollStudioExecutions({ retryImports: true })}>{t('刷新与重试入库')}</button></div>
    <StudioArtifactGrid artifacts={visible} />
  </section>;
}

export function StudioArtifactGrid({ artifacts }: { artifacts: StudioArtifact[] }) {
  const t = useT();
  const [preview, setPreview] = useState<StudioArtifact | null>(null);
  const [filter, setFilter] = useState('');
  const [kind, setKind] = useState('all');
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');
  const [text, setText] = useState<{ id: string; value: string }>();
  useEffect(() => {
    if (!preview?.url || preview.kind !== 'text') return;
    const controller = new AbortController();
    if (preview.size > 8 * 1024 * 1024) return;
    void fetch(preview.url, { signal: controller.signal }).then(r => { if (!r.ok) throw new Error('read'); return r.text(); }).then(value => {
      if (!controller.signal.aborted) setText({ id: preview.id, value });
    }, () => { if (!controller.signal.aborted) setText({ id: preview.id, value: '无法读取文件，请重试。' }); });
    return () => controller.abort();
  }, [preview]);
  const download = async (artifact: StudioArtifact) => {
    if (!artifact.url) return;
    setSaving(artifact.id); setError('');
    try {
      const name = artifact.name.split('/').at(-1) ?? 'resource';
      const source = localMediaUrlToPath(artifact.url);
      if (!source) throw new Error('read');
      const destination = await save({ defaultPath: name, filters: [{ name: t('资源文件'), extensions: [name.split('.').at(-1) ?? '*'] }] });
      if (destination) await copyLocalFileStreamed(source, destination);
    } catch { setError('导出失败，请重试。'); } finally { setSaving(''); }
  };
  return <>{artifacts.length > 4 && <div className="mb-3 flex flex-wrap gap-2"><input aria-label={t('搜索资源')} placeholder={t('搜索资源')} className="ui-input max-w-60" value={filter} onChange={e => setFilter(e.target.value)} /><Select aria-label={t('资源类型')} className="max-w-36" value={kind} onChange={setKind} options={Object.entries({ all: '全部', image: '图片', video: '视频', audio: '音频', text: '文本', file: '文件' }).map(([value, label]) => ({ value, label: t(label) }))} /></div>}{error && <p role="alert" className="ui-alert text-xs">{t(error)}</p>}<div className="studio-resource-grid">{artifacts.filter(a => a.name.toLowerCase().includes(filter.toLowerCase()) && (kind === 'all' || a.kind === kind)).map(a => <article className="overflow-hidden rounded-lg border border-canvas-border bg-canvas-surface p-3" key={`${a.id}/${a.name}`}>
      {a.url && a.kind === 'image' && <button className="block w-full" aria-label={`${t('查看图片')} ${a.name}`} onClick={() => setPreview(a)}><img className="aspect-video w-full rounded object-contain" src={a.url} alt={a.name}/></button>}
      {a.url && a.kind === 'video' && <video className="aspect-video w-full rounded" src={a.url} controls preload="metadata"/>}
      {a.url && a.kind === 'audio' && <audio className="w-full" src={a.url} controls preload="metadata"/>}
      <p className="mt-2 break-words text-xs">{a.name}</p><p className="mt-1 text-[10px] text-canvas-text-muted">{t(a.imported ? '已进入个人资源库' : '入库未完成，可重试')}</p>
      <div className="mt-2 flex gap-2">{a.url && a.kind === 'text' && <button className="ui-btn ui-btn--sm" onClick={() => setPreview(a)}>{t('查看内容')}</button>}{a.url && <button className="ui-btn ui-btn--ghost ui-btn--sm" disabled={!!saving} onClick={() => void download(a)}>{t(saving === a.id ? '正在导出…' : '导出')}</button>}</div>
    </article>)}</div><ModalOverlay isOpen={!!preview} onClose={() => setPreview(null)} ariaLabel={t('资源预览')} zIndex={400} className="w-[min(960px,90vw)] p-4">
      <div className="mb-3 flex items-center justify-between gap-3"><span className="truncate text-xs">{preview?.name}</span><button className="ui-btn ui-btn--sm" onClick={() => setPreview(null)}>{t('关闭')}</button></div>
      {preview?.url && (preview.kind === 'image' ? <img className="max-h-[75vh] w-full object-contain" src={preview.url} alt={preview.name} /> : <pre className="ui-scroll max-h-[70vh] overflow-auto whitespace-pre-wrap break-words text-xs leading-6">{preview.size > 8 * 1024 * 1024 ? t('文件较大，请导出后查看。') : text?.id === preview.id ? text.value : t('正在读取…')}</pre>)}
    </ModalOverlay></>;
}
