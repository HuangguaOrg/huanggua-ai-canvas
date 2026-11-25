import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Film, Loader2, X } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import type { StudioAttachment } from '../../types/studio';
import { studioWorkspace, workspaceError, type StudioScope } from '../../services/studioWorkspaceService';
import { uploadStudioAttachment } from '../../services/studioAttachmentService';

export interface AttachmentHandle {
  add: (files: File[]) => Promise<void>;
  openPicker: () => void;
}

export default function StudioAttachments({
  scope,
  attachments,
  disabled,
  onBusy,
  ref,
}: {
  scope: StudioScope;
  attachments: StudioAttachment[];
  disabled?: boolean;
  onBusy: (busy: boolean) => void;
  ref?: Ref<AttachmentHandle>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false);

  const add = async (files: File[]) => {
    if (!files.length || busyRef.current || disabled) return;
    busyRef.current = true;
    setBusy(true);
    onBusy(true);
    setError('');
    try {
      if (attachments.length + files.length > 5) throw 'studio_attachment_limit';
      for (const file of files) {
        const refItem = await uploadStudioAttachment(scope, file);
        const state = useAppStore.getState();
        const episode = state.studioDraft.projects
          .find(p => p.id === scope.projectId)
          ?.episodes.find(e => e.id === scope.episodeId);
        if (!episode) break;
        state.setStudioAttachments(scope.projectId, scope.episodeId, [
          ...(episode.attachments ?? []).filter(a => a.id !== refItem.id),
          refItem,
        ]);
      }
    } catch (error) {
      setError(workspaceError(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
      onBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const openPicker = () => {
    if (!disabled && !busyRef.current && attachments.length < 5) {
      input.current?.click();
    }
  };

  useImperativeHandle(ref, () => ({ add, openPicker }));

  const hasVisibleContent = attachments.length > 0 || busy || Boolean(error);

  return (
    <>
      <input
        ref={input}
        type="file"
        hidden
        multiple
        accept=".png,.jpg,.jpeg,.webp,.mp4,.mov,.m4v,.webm"
        onChange={e => void add(Array.from(e.target.files ?? []))}
      />
      {hasVisibleContent && (
        <div className="mb-2 space-y-1.5 border-b border-canvas-border/60 pb-2">
          {(attachments.length > 0 || busy) && (
            <div className="flex flex-wrap items-center gap-2">
              {attachments.map(a => (
                <div key={a.id} className="group relative h-14 w-16 shrink-0">
                  <AttachmentThumb scope={scope} attachment={a} />
                  <button
                    type="button"
                    className="studio-attachment-remove"
                    disabled={busy || disabled}
                    title={`移除 ${a.name}`}
                    aria-label={`移除附件 ${a.name}`}
                    onClick={() =>
                      useAppStore.getState().setStudioAttachments(
                        scope.projectId,
                        scope.episodeId,
                        attachments.filter(item => item.id !== a.id),
                      )
                    }
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
              {busy && (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-canvas-border bg-canvas-card px-2.5 py-1.5 text-[11px] text-canvas-text-muted">
                  <Loader2 size={12} className="animate-spin" />
                  正在保存附件…
                </span>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="text-[11px] text-[var(--danger-light)]">
              {error}
            </p>
          )}
        </div>
      )}
    </>
  );
}

function AttachmentThumb({ scope, attachment }: { scope: StudioScope; attachment: StudioAttachment }) {
  const [preview, setPreview] = useState<{ url: string; kind?: string }>({ url: '', kind: attachment.kind });
  useEffect(() => {
    let active = true;
    void studioWorkspace<{ url: string; kind?: string }>(
      { projectId: scope.projectId, episodeId: scope.episodeId },
      'attachment_preview',
      { id: attachment.id },
    )
      .then(result => {
        if (active) setPreview({ url: result.url, kind: result.kind ?? attachment.kind });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [scope.projectId, scope.episodeId, attachment.id, attachment.kind]);
  const isVideo = preview.kind === 'video' || attachment.kind === 'video';
  return (
    <div
      className="relative h-full w-full overflow-hidden rounded-lg border border-canvas-border bg-canvas-card"
      title={attachment.name}
    >
      {preview.url ? (
        <img className="h-full w-full object-cover" src={preview.url} alt={attachment.name} />
      ) : (
        <span className="flex h-full items-center justify-center p-1 text-center text-[10px] leading-tight text-canvas-text-muted">
          {attachment.name.slice(0, 10)}
        </span>
      )}
      {isVideo && (
        <span className="absolute bottom-0.5 left-0.5 inline-flex items-center gap-0.5 rounded bg-canvas-bg/85 px-1 py-0.5 text-[9px] text-canvas-text">
          <Film size={9} />
          视频
        </span>
      )}
    </div>
  );
}
