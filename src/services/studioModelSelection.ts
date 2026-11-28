import legacyIds from '../../runtime/studio/legacy-media-model-ids.json';
import type { StudioDraftDocument, StudioProject } from '../types/studio';

const successors: Record<string, string> = legacyIds;
type VideoModelsByMode = Partial<Record<NonNullable<StudioProject['generationMode']>, string[]>>;

export function selectStudioModel(saved: string | undefined, available: string[]): string | undefined {
  if (saved && available.includes(saved)) return saved;
  const merged = saved && successors[saved];
  return merged && available.includes(merged) ? merged : available[0];
}

// Only repair an existing preference when the account has an admitted replacement.
// Empty/unreachable catalogs and already submitted tasks retain their original records.
export function reconcileStudioDraftModels(draft: StudioDraftDocument, models: Record<string, string[]>, videoByMode: VideoModelsByMode) {
  let changed = false;
  const projects = draft.projects.map(project => {
    const videos = videoByMode[project.generationMode ?? 'storyboard'] ?? [];
    let projectChanged = false;
    const episodes = project.episodes.map(episode => {
      let next = episode.models;
      for (const kind of ['video', 'image', 'text'] as const) {
        const saved = episode.models?.[kind];
        if (!saved) continue;
        const replacement = selectStudioModel(saved, kind === 'video' ? videos : models[kind] ?? []);
        if (replacement && saved !== replacement) next = { ...next, [kind]: replacement };
      }
      if (next === episode.models) return episode;
      projectChanged = true;
      return { ...episode, models: next };
    });
    if (!projectChanged) return project;
    changed = true;
    return { ...project, episodes };
  });
  return changed ? { ...draft, projects } : draft;
}
