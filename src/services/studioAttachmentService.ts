import { studioWorkspace, type StudioScope } from './studioWorkspaceService';
import { pollStudioExecutions } from './studioExecutionService';
import type { StudioAttachment } from '../types/studio';

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
const VIDEO_RE = /\.(mp4|mov|m4v|webm)$/i;

export async function uploadStudioAttachment(scope: StudioScope, file: File): Promise<StudioAttachment> {
  const isImage = IMAGE_RE.test(file.name);
  const isVideo = VIDEO_RE.test(file.name);
  const maxBytes = isVideo ? 128 * 1024 * 1024 : 30 * 1024 * 1024;
  if ((!isImage && !isVideo) || file.size <= 0 || file.size > maxBytes) throw 'studio_invalid_attachment';
  let id: string | undefined;
  try {
    id = (await studioWorkspace<{ id: string }>(scope, 'upload_begin', { data: { kind: 'attachment', filename: file.name, size: file.size } })).id;
    for (let offset = 0; offset < file.size; offset += 384 * 1024) {
      const bytes = new Uint8Array(await file.slice(offset, offset + 384 * 1024).arrayBuffer());
      let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      await studioWorkspace(scope, 'upload_chunk', { id, data: { offset, chunk: btoa(binary) } });
    }
    const result = await studioWorkspace<{ id: string; kind?: 'image' | 'video'; projectPath?: string }>(scope, 'upload_finish', { id });
    if (!result.projectPath) throw 'studio_project_storage_unavailable';
    id = undefined;
    await pollStudioExecutions();
    return { id: result.id, name: file.name, kind: result.kind ?? (isVideo ? 'video' : 'image'), projectPath: result.projectPath };
  } finally { if (id) await studioWorkspace(scope, 'upload_cancel', { id }).catch(() => {}); }
}
