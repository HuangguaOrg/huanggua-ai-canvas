import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import StudioVideoModelPicker from '../../src/components/studio/StudioVideoModelPicker';

vi.mock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
vi.mock('../../src/services/studioWorkspaceService', () => ({ studioWorkspace: vi.fn(), workspaceError: String }));

const base = {
  scope: { projectId: 'p', episodeId: 'e' }, disabled: false,
  onChange: vi.fn(), refreshModels: vi.fn(async () => {}),
};

it('only offers IDs in the current mode list even if a saved choice or unknown spec still exists', () => {
  const merged = 'hg-video-agnes-2.5';
  const old = 'grsai-agnes-video-2.5-720p';
  const markup = renderToStaticMarkup(<StudioVideoModelPicker {...base} ids={[merged]} value={old} specs={{
    [merged]: { id: merged, display_name: 'Agnes Video 2.5', spec_status: 'available' },
    pending: { id: 'pending', display_name: 'Pending', spec_status: 'unknown' },
  }} />);
  expect(markup).toContain(`value="${merged}"`);
  expect(markup).not.toContain(`value="${old}"`);
  expect(markup).not.toContain('value="pending"');
});

it('keeps follow-model available when an old lock has no matching tier in an ordinary catalog', () => {
  const markup = renderToStaticMarkup(<StudioVideoModelPicker {...base} ids={['legacy']} value="legacy" lock="720p"
    specs={{ legacy: { id: 'legacy', display_name: 'Legacy', spec_status: 'legacy' } }} />);
  expect(markup).toContain('本集锁定的素材分辨率与当前模型不兼容');
  expect(markup).toContain('跟随模型（推荐）');
});
