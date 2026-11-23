import { useRef, useState } from 'react';
import { uploadStudioLocalFile, workspaceError, type StudioScope } from '../../services/studioWorkspaceService';
import { useT } from '../../i18n';

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export default function StudioUpload({
  scope,
  kind,
  name,
  derivative,
  category,
  label,
  accept,
  disabled,
  onComplete,
  beforeUpload,
  resolveTarget,
}: {
  scope: StudioScope;
  kind: string;
  name?: string;
  derivative?: string;
  category?: string;
  label: string;
  accept: string;
  disabled?: boolean;
  onComplete?: () => void;
  beforeUpload?: () => Promise<void>;
  resolveTarget?: () => Promise<{ name?: string } | void>;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  const transfer = async (file?: File) => {
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES || !file.size) { setError('文件大小需要在 0 到 200 MB 之间。'); return; }
    setProgress(0); setError('');
    try {
      await beforeUpload?.();
      const resolved = await resolveTarget?.();
      const targetName = resolved?.name ?? name;
      await uploadStudioLocalFile(scope, kind, file, {
        name: targetName,
        derivative,
        category,
        onProgress: setProgress,
      });
      onComplete?.();
    } catch (e) { setError(workspaceError(e)); }
    finally {
      setProgress(null);
      if (input.current) input.current.value = '';
    }
  };
  return <span className="inline-flex flex-col gap-1">
    <input hidden ref={input} type="file" accept={accept} onChange={e => void transfer(e.target.files?.[0])} />
    <button type="button" className="ui-btn ui-btn--sm" disabled={disabled || progress !== null} onClick={() => input.current?.click()}>
      {progress === null ? t(label) : `${t('本地保存中')} ${progress}%`}
    </button>
    {error && <span className="text-xs" role="alert">{t(error)}</span>}
  </span>;
}
