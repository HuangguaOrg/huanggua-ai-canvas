import { useEffect, useMemo, useState } from 'react';
import type { StudioArtifact, StudioShot } from '../../types/studio';

export interface StudioDisplayShot extends StudioShot {
  imagePrompt?: string; videoPrompt?: string; image?: StudioArtifact; endFrame?: StudioArtifact; video?: StudioArtifact;
  imagePath?: string; endFramePath?: string; videoPath?: string;
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const promptText = (value: unknown) => typeof value === 'string' ? value : value && typeof value === 'object' ? JSON.stringify(value, null, 2) : '';

/** Read the hash-verified, imported script. Never write formal output over authoring drafts. */
export function useStudioScript(artifacts: StudioArtifact[]) {
  const source = artifacts.find(a => a.name.startsWith('scripts/') && a.name.endsWith('.json') && a.imported && a.url && a.size <= 8 * 1024 * 1024);
  const [loaded, setLoaded] = useState<{ url: string; name: string; shots: StudioDisplayShot[]; error?: boolean } | null>(null);
  const url = source?.url;
  const name = source?.name;
  useEffect(() => {
    if (!url || !name) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error('studio_script_read_failed');
        const data = object(await response.json());
        const items = data.scenes ?? data.shots ?? data.video_units;
        if (!Array.isArray(items)) throw new Error('studio_script_invalid');
        const shots = items.flatMap((value): StudioDisplayShot[] => {
          const scene = object(value);
          const id = scene.scene_id ?? scene.shot_id ?? scene.unit_id;
          if (typeof id !== 'string') return [];
          const generated = object(scene.generated_assets);
          const endFrameRaw = scene.end_frame_image ?? generated.end_frame_image;
          return [{ id, title: id,
            description: String(scene.scene_description ?? scene.description ?? scene.text ?? ''),
            duration: typeof scene.duration_seconds === 'number' ? scene.duration_seconds : 0,
            imagePrompt: promptText(scene.image_prompt), videoPrompt: promptText(scene.video_prompt),
            imagePath: typeof generated.storyboard_image === 'string' ? generated.storyboard_image : undefined,
            endFramePath: typeof endFrameRaw === 'string' ? endFrameRaw : undefined,
            videoPath: typeof generated.video_clip === 'string' ? generated.video_clip : undefined }];
        });
        if (!controller.signal.aborted) setLoaded({ url, name, shots });
      } catch { if (!controller.signal.aborted) setLoaded({ url, name, shots: [], error: true }); }
    })();
    return () => controller.abort();
  }, [url, name]);
  // Keep the same script mounted while its next verified version loads. Otherwise
  // media uploads briefly remove every shot and close an in-progress editor.
  const result = loaded?.name === name ? loaded : null;
  const shots = useMemo(() => result?.shots.map(shot => ({ ...shot,
    image: artifacts.find(a => a.kind === 'image' && a.name === shot.imagePath),
    endFrame: artifacts.find(a => a.kind === 'image' && a.name === shot.endFramePath),
    video: artifacts.find(a => a.kind === 'video' && a.name === shot.videoPath),
  })), [result, artifacts]);
  return { shots, loading: !!url && loaded?.url !== url, error: result?.error, formal: !!url };
}
