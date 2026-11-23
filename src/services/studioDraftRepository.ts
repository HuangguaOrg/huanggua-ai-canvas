import type { StudioDraftDocument } from '../types/studio';

/** Isolated UI drafts, not the studio project database. No credentials or media bytes. */
const DB_NAME = 'huanggua-studio-drafts';
function openDrafts(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('studio_storage_unavailable'));
    request.onblocked = () => reject(new Error('studio_storage_blocked'));
  });
}
function isDocument(value: unknown): value is StudioDraftDocument {
  if (!value || typeof value !== 'object') return false;
  const d = value as StudioDraftDocument;
  return d.version === 1 && Array.isArray(d.projects) && d.projects.every(p =>
    typeof p.id === 'string' && typeof p.name === 'string' && Number.isFinite(p.updatedAt)
    && (p.contentMode === undefined || ['drama', 'ad'].includes(p.contentMode))
    && (p.generationMode === undefined || ['storyboard', 'reference_video'].includes(p.generationMode))
    && Array.isArray(p.episodes) && p.episodes.every(e =>
      typeof e.id === 'string' && typeof e.name === 'string' && typeof e.script === 'string'
      && typeof e.agentBrief === 'string'
      && (e.models === undefined || (e.models !== null && typeof e.models === 'object'
        && !Array.isArray(e.models) && Object.values(e.models).every(m => typeof m === 'string')))
      && (e.submission === undefined || (e.submission !== null && typeof e.submission === 'object'
        && typeof e.submission.requestId === 'string' && typeof e.submission.content === 'string'
        && e.submission.models !== null && typeof e.submission.models === 'object'
        && Object.values(e.submission.models).every(m => typeof m === 'string')))
      && Array.isArray(e.shots) && e.shots.every(s =>
        typeof s.id === 'string' && typeof s.title === 'string' && typeof s.description === 'string'
        && Number.isFinite(s.duration) && s.duration > 0)))
    && (d.projectId === null || typeof d.projectId === 'string')
    && (d.episodeId === null || typeof d.episodeId === 'string');
}
export async function readStudioDrafts(): Promise<StudioDraftDocument> {
  const db = await openDrafts();
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction('drafts').objectStore('drafts').get('workspace');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('studio_read_failed'));
    });
    if (value === undefined) return { version: 1, projects: [], projectId: null, episodeId: null };
    if (!isDocument(value)) throw new Error('studio_invalid_draft');
    return value;
  } finally { db.close(); }
}
export async function writeStudioDrafts(document: StudioDraftDocument): Promise<void> {
  if (!isDocument(document)) throw new Error('studio_invalid_draft');
  const db = await openDrafts();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('drafts', 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(new Error('studio_save_failed'));
      transaction.objectStore('drafts').put(document, 'workspace');
    });
  } finally { db.close(); }
}
