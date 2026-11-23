import { useState } from 'react';
import { Clock, RotateCcw, Send, Trash2 } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import type { StudioExecution } from '../../types/studio';
import { studioWorkspace, workspaceError, type StudioScope } from '../../services/studioWorkspaceService';
import { pollStudioExecutions } from '../../services/studioExecutionService';

export default function StudioMessageQueue({
  scope,
  messages,
  disabled,
  questionPending,
}: {
  scope: StudioScope;
  messages: NonNullable<StudioExecution['queued']>;
  disabled: boolean;
  questionPending: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<string>();

  const act = async (action: string, id: string) => {
    setBusy(true);
    setError('');
    try {
      const result = await studioWorkspace<{ outcome?: string; message?: (typeof messages)[number] }>(scope, action, { id });
      if (action === 'queue_edit' && result.outcome === 'withdrawn' && result.message) {
        useAppStore
          .getState()
          .restoreStudioMessage(scope.projectId, scope.episodeId, result.message.text, result.message.attachments ?? []);
      }
      setConfirm(undefined);
      await pollStudioExecutions();
    } catch (e) {
      setError(workspaceError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ui-scroll max-h-36 shrink-0 space-y-1.5 overflow-y-auto border-t border-canvas-border bg-canvas-card/30 px-3 py-2 text-xs">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-canvas-text-muted">
        <Clock size={12} />
        <span>待发送队列（{messages.length}）</span>
      </div>
      {messages.map(m => (
        <div className="space-y-1.5 rounded-lg border border-canvas-border bg-canvas-surface px-2.5 py-2" key={m.id}>
          <div className="flex items-start justify-between gap-2">
            <p className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap text-xs leading-5">
              <span className="mr-1.5 rounded bg-canvas-card px-1.5 py-0.5 text-[10px] text-canvas-text-muted">
                {m.state === 'unsent' ? '未发送' : '排队中'}
              </span>
              {m.text}
              {m.attachments?.length ? `（${m.attachments.length} 个附件）` : ''}
            </p>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                className="ui-btn ui-btn--ghost ui-btn--sm px-1.5"
                title={m.state === 'unsent' ? '重新发送' : '立即发送'}
                disabled={busy || disabled || questionPending}
                onClick={() => void act(m.state === 'unsent' ? 'queue_resend' : 'queue_now', m.id)}
              >
                <Send size={12} />
                <span>{m.state === 'unsent' ? '重发' : '立即'}</span>
              </button>
              <button
                type="button"
                className="ui-btn ui-btn--ghost ui-btn--sm px-1.5"
                title="退回输入框编辑"
                disabled={busy || disabled}
                onClick={() => void act('queue_edit', m.id)}
              >
                <RotateCcw size={12} />
                <span>编辑</span>
              </button>
              <button
                type="button"
                className="ui-btn ui-btn--ghost ui-btn--sm px-1.5 text-[var(--danger-light)]"
                title="删除排队消息"
                aria-label="删除排队消息"
                disabled={busy || disabled}
                onClick={() => setConfirm(m.id)}
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
          {confirm === m.id && (
            <div className="flex items-center justify-between gap-2 border-t border-canvas-border/60 pt-1.5 text-[11px] text-canvas-text-muted">
              <span>确认移除这条排队消息？</span>
              <div className="flex gap-1">
                <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => setConfirm(undefined)}>
                  取消
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn--primary ui-btn--sm"
                  disabled={busy}
                  onClick={() => void act('queue_delete', m.id)}
                >
                  确认
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
      {error && (
        <p role="alert" className="text-[11px] text-[var(--danger-light)]">
          {error}
        </p>
      )}
    </div>
  );
}
