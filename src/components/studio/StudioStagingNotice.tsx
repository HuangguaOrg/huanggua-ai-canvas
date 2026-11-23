import type { StudioStagingPrecheck } from '../../types/studio';

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export default function StudioStagingNotice({ precheck }: { precheck: StudioStagingPrecheck }) {
  return <div className="space-y-3 rounded-lg border border-canvas-border bg-canvas-card p-3 text-xs">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <strong className="text-canvas-text">目标规格 · {precheck.model}</strong>
      <span className="text-canvas-text-secondary">
        画幅 {precheck.targetRatio} · 档位 {precheck.targetResolution}
        {precheck.targetPixelSize ? ` (${precheck.targetPixelSize})` : ''}
        {precheck.requestDuration ? ` · 请求时长 ${precheck.requestDuration}s` : ''}
      </span>
    </div>
    {precheck.references.length > 0 ? <div className="space-y-2 border-t border-canvas-border pt-2">
      <p className="text-[11px] font-medium text-canvas-text-secondary">参与参考的本地素材（共 {precheck.references.length} 项）</p>
      <ul className="space-y-1.5">
        {precheck.references.map((item, idx) => <li key={`${item.name}-${idx}`} className="flex flex-wrap items-center justify-between gap-2 rounded border border-canvas-border bg-canvas-surface p-2">
          <div className="min-w-0 flex-1">
            <span className="font-medium text-canvas-text">{item.role}</span>
            <span className="ml-2 break-all text-canvas-text-muted">{item.name}</span>
          </div>
          <span className="shrink-0 text-[11px] text-canvas-text-secondary">
            {item.format ?? item.kind.toUpperCase()}
            {item.width && item.height ? ` · ${item.width}×${item.height}` : ''}
            {typeof item.durationSeconds === 'number' ? ` · ${item.durationSeconds}s` : ''}
            {` · ${formatBytes(item.sizeBytes)}`}
            {item.cached ? ' · 已命中有效 URL 缓存' : ` · 待暂存至 ${precheck.stagingHost}`}
          </span>
        </li>)}
      </ul>
    </div> : <p className="text-canvas-text-muted">本次请求为纯提示词生成，不包含本地参考图片或参考视频上传。</p>}
    {precheck.warnings.length > 0 && <div className="space-y-1 border-t border-canvas-border pt-2 text-[11px] leading-5 text-canvas-text-secondary">
      {precheck.warnings.map((w, i) => <p key={i}>• {w}</p>)}
    </div>}
    {precheck.blockers.length > 0 && <div role="alert" className="ui-alert space-y-1 text-xs">
      {precheck.blockers.map((b, i) => <p key={i}>{b}</p>)}
    </div>}
  </div>;
}
