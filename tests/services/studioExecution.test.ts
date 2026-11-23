import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/store/useAppStore';
import type { StudioExecution } from '../../src/types/studio';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), importArtifact: vi.fn(), state: {} as AppState }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../../src/services/fileService', () => ({ importStudioArtifact: mocks.importArtifact }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => mocks.state } }));
import { submitStudio, pollStudioExecutions } from '../../src/services/studioExecutionService';

function execution(): StudioExecution { return { project:'engine-project', status:'idle', entries:[], questions:[], artifacts:[], tasks:[] }; }
describe('ArcReel execution delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const episode = { id:'episode', name:'EP01', script:'script', agentBrief:'only storyboard', shots:[] };
    mocks.state = {
      studioDraft: { version:1, projectId:'project', episodeId:'episode', projects:[{ id:'project', name:'Title', updatedAt:0, episodes:[episode] }] },
      studioStage:'story', studioConnection:'ready', studioEpoch:1, studioExecutions:{}, studioSave:'saved',
      saveStudio:vi.fn().mockResolvedValue(undefined),
      setStudioSubmission:vi.fn((_p, _e, submission) => { Object.assign(episode, { submission }); }),
      restoreStudioMessage:vi.fn((_p, _e, text) => { episode.agentBrief = text; }),
      acknowledgeStudioSubmission:vi.fn((_p, _e, _id, brief) => { Object.assign(episode, { submission: undefined, agentBrief: episode.agentBrief === brief ? '' : episode.agentBrief }); }),
      updateStudioExecution:vi.fn((key, value) => { mocks.state.studioExecutions[key] = value; }),
    } as unknown as AppState;
    mocks.invoke.mockImplementation(async (_command, args) => args.operation === 'poll' ? execution() : { status:'accepted' });
  });
  it('persists submission identity before execution and clears it only after acknowledgement', async () => {
    mocks.invoke.mockImplementation(async (_command, args) => {
      if (args.operation === 'run') {
        expect(mocks.state.studioDraft.projects[0].episodes[0].submission?.requestId).toBe(args.payload.requestId);
        expect(args.payload).toMatchObject({ episodeTitle:'EP01', sourceText:'script' });
      }
      return args.operation === 'poll' ? execution() : { status:'accepted' };
    });
    await submitStudio('project', 'episode', { text:'model' });
    expect(mocks.state.saveStudio).toHaveBeenCalled();
    expect(mocks.state.studioDraft.projects[0].episodes[0].submission).toBeUndefined();
    expect(mocks.state.studioDraft.projects[0].episodes[0].agentBrief).toBe('');
  });
  it('retains an uncertain request and explicitly recovers with the same id', async () => {
    mocks.invoke.mockRejectedValueOnce('studio_connection_lost');
    await expect(submitStudio('project','episode',{})).rejects.toBe('studio_connection_lost');
    const id = mocks.state.studioDraft.projects[0].episodes[0].submission!.requestId;
    mocks.state.studioDraft.projects[0].episodes[0].script = 'edited after uncertain submission';
    await expect(submitStudio('project','episode',{})).rejects.toBe('studio_submission_uncertain');
    await submitStudio('project','episode',{},true);
    const requests = mocks.invoke.mock.calls.filter(([,args]) => args.operation === 'run');
    expect(requests).toHaveLength(2);
    expect(requests[1][1].payload.requestId).toBe(id);
    expect(requests[1][1].payload.sourceText).toBe('script');
  });
  it('releases a definitively rejected old request without losing text or attachments', async () => {
    const episode = mocks.state.studioDraft.projects[0].episodes[0];
    episode.attachments = [{ id: 'image', name: 'ref.png' }];
    episode.rewriteAnchor = 'anchor';
    mocks.invoke.mockRejectedValueOnce('studio_video_model_incompatible');
    await expect(submitStudio('project', 'episode', { video: 'reference-only' })).rejects.toBe('studio_video_model_incompatible');
    const id = episode.submission!.requestId;
    episode.agentBrief = '';
    mocks.invoke.mockImplementationOnce(async (_command, args) => ({ status: 'rejected', error: 'studio_video_model_incompatible', requestId: args.payload.requestId }));
    await expect(submitStudio('project', 'episode', { video: 'first-frame' }, true)).rejects.toBe('studio_video_model_incompatible');
    expect(mocks.invoke.mock.calls.at(-1)![1].payload).toMatchObject({ requestId: id, models: { video: 'reference-only' } });
    expect(episode.submission).toBeUndefined();
    expect(episode.agentBrief).toBe('only storyboard');
    expect(episode.attachments).toEqual([{ id: 'image', name: 'ref.png' }]);
    expect(episode.rewriteAnchor).toBe('anchor');
    expect(mocks.state.acknowledgeStudioSubmission).not.toHaveBeenCalled();
    await submitStudio('project', 'episode', { video: 'first-frame' });
    const request = mocks.invoke.mock.calls.filter(([, args]) => args.operation === 'run').at(-1)![1].payload;
    expect(request.requestId).not.toBe(id);
    expect(request.models.video).toBe('first-frame');
  });
  it('does not clear an uncertain request for an unrelated rejection response', async () => {
    mocks.invoke.mockResolvedValueOnce({ status: 'rejected', error: 'studio_video_model_incompatible', requestId: 'other' });
    await expect(submitStudio('project', 'episode', {})).rejects.toBe('studio_submission_uncertain');
    expect(mocks.state.studioDraft.projects[0].episodes[0].submission).toBeDefined();
  });
  it('retries the original attachment snapshot and passes all episode identities', async () => {
    const episode = mocks.state.studioDraft.projects[0].episodes[0];
    episode.attachments = [{ id: 'first', name: 'first.png' }];
    mocks.invoke.mockRejectedValueOnce('studio_connection_lost');
    await expect(submitStudio('project', 'episode', {})).rejects.toBe('studio_connection_lost');
    episode.attachments = [{ id: 'next', name: 'next.png' }];
    await submitStudio('project', 'episode', {}, true);
    const requests = mocks.invoke.mock.calls.filter(([, args]) => args.operation === 'run');
    expect(requests[1][1].payload).toMatchObject({ attachments: [{ id: 'first', name: 'first.png' }], episodeIds: ['episode'] });
    expect(JSON.stringify(requests[1][1].payload)).not.toContain('data:image');
  });
  it('retries only failed imports, never generation', async () => {
    mocks.invoke.mockImplementation(async () => ({ ...execution(), artifacts:[{ id:'asset-retry',name:'image.png',kind:'image',size:10 }] }));
    mocks.importArtifact.mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce('asset://image');
    await pollStudioExecutions();
    expect(mocks.state.studioExecutions['project/episode'].artifacts[0].importError).toBe(true);
    await pollStudioExecutions(); await pollStudioExecutions();
    expect(mocks.importArtifact).toHaveBeenCalledTimes(2);
    expect(mocks.state.studioExecutions['project/episode'].artifacts[0].imported).toBe(true);
    expect(mocks.invoke.mock.calls.every(([,args]) => args.operation === 'poll')).toBe(true);
  });
  it('does not deliver a late result after account disconnect', async () => {
    mocks.invoke.mockImplementation(async () => { mocks.state.studioEpoch++; return execution(); });
    await pollStudioExecutions();
    expect(mocks.state.updateStudioExecution).not.toHaveBeenCalled();
  });
  it('preserves text typed while a send is awaiting acknowledgement', async () => {
    mocks.invoke.mockImplementation(async (_command, args) => {
      if (args.operation === 'run') mocks.state.studioDraft.projects[0].episodes[0].agentBrief = 'next instruction';
      return args.operation === 'poll' ? execution() : { status:'accepted' };
    });
    await submitStudio('project', 'episode', {});
    expect(mocks.state.studioDraft.projects[0].episodes[0].agentBrief).toBe('next instruction');
  });
  it('does not reintroduce an execution error after account disconnect', async () => {
    mocks.state.studioExecutions['project/episode'] = execution();
    mocks.invoke.mockImplementation(async () => { mocks.state.studioEpoch++; throw 'studio_connection_lost'; });
    await pollStudioExecutions();
    expect(mocks.state.updateStudioExecution).not.toHaveBeenCalled();
  });
});
