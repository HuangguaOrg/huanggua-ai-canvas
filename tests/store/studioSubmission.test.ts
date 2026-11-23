import { describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import type { AppState } from '../../src/store/useAppStore';
vi.mock('../../src/services/studioExecutionService', () => ({ studioError: String, studioRequest: vi.fn(), submitStudio: vi.fn(), pollStudioExecutions: vi.fn() }));
import { createStudioExecutionSlice } from '../../src/store/store.studioExecution';

function store() {
  return create<AppState>()((...args) => ({ ...createStudioExecutionSlice(...args),
    saveStudio: vi.fn().mockResolvedValue(undefined),
    studioDraft: { version: 1, projectId: 'p', episodeId: 'e', projects: [{ id: 'p', name: 'P', updatedAt: 1, episodes: [{ id: 'e', name: 'E', script: '', shots: [], agentBrief: 'first command', submission: { requestId: 'r', brief: 'first command', content: 'request', models: {} } }] }] },
  } as unknown as AppState));
}
describe('submission acknowledgement in the real store', () => {
  it('restores a withdrawn message to its original episode after navigation without replacing a newer draft', () => {
    const s = store();
    const episode = s.getState().studioDraft.projects[0].episodes[0];
    episode.attachments = [{ id: 'same', name: 'original.png' }];
    s.getState().studioDraft.projectId = 'other';
    s.getState().restoreStudioMessage('p', 'e', 'queued command', [{ id: 'same', name: 'duplicate.png' }, { id: 'queued', name: 'queued.png' }]);
    expect(s.getState().studioDraft.projects[0].episodes[0]).toMatchObject({ agentBrief: 'first command\n\nqueued command', attachments: [{ id: 'same', name: 'original.png' }, { id: 'queued', name: 'queued.png' }] });
    expect(s.getState().saveStudio).toHaveBeenCalled();
  });
  it('clears sent attachments and rewrite anchor while retaining newly added attachments', () => {
    const s = store();
    const e = s.getState().studioDraft.projects[0].episodes[0];
    e.attachments = [{ id: 'sent', name: 'sent.png' }, { id: 'new', name: 'new.png' }];
    e.rewriteAnchor = 'anchor';
    e.submission!.attachments = [{ id: 'sent', name: 'sent.png' }];
    e.submission!.rewriteAnchor = 'anchor';
    s.getState().acknowledgeStudioSubmission('p', 'e', 'r', 'first command');
    expect(s.getState().studioDraft.projects[0].episodes[0]).toMatchObject({ attachments: [{ id: 'new', name: 'new.png' }], rewriteAnchor: undefined });
  });
  it('stores attachment references in the captured episode even after navigation', () => {
    const s = store();
    s.getState().studioDraft.projectId = 'other';
    s.getState().setStudioAttachments('p', 'e', [{ id: 'scoped', name: 'image.png' }]);
    expect(s.getState().studioDraft.projects[0].episodes[0].attachments).toEqual([{ id: 'scoped', name: 'image.png' }]);
  });
  it('clears only the acknowledged command and persists the cleared draft', () => {
    const s = store(); s.getState().acknowledgeStudioSubmission('p', 'e', 'r', 'first command');
    expect(s.getState().studioDraft.projects[0].episodes[0]).toMatchObject({ agentBrief: '', submission: undefined });
    expect(s.getState().saveStudio).toHaveBeenCalled();
  });
  it('preserves newer input and ignores acknowledgement for another request', () => {
    const s = store(); s.getState().studioDraft.projects[0].episodes[0].agentBrief = 'new command';
    s.getState().acknowledgeStudioSubmission('p', 'e', 'old', 'first command');
    expect(s.getState().studioDraft.projects[0].episodes[0].submission?.requestId).toBe('r');
    s.getState().acknowledgeStudioSubmission('p', 'e', 'r', 'first command');
    expect(s.getState().studioDraft.projects[0].episodes[0]).toMatchObject({ agentBrief: 'new command', submission: undefined });
  });
});
