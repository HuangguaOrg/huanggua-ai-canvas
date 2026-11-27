import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/useAppStore';
import type { StudioArtifact, StudioExecution } from '../types/studio';
import { importStudioArtifact, isStudioArtifactAvailable } from './fileService';

export function studioRequest<T>(operation: string, payload: Record<string, unknown> = {}): Promise<T> {
  const project = useAppStore.getState().studioDraft.projects.find(p => p.id === payload.projectId);
  const episode = project?.episodes.find(e => e.id === payload.episodeId);
  const needsSource = operation === 'workspace' && ['initialize', 'blank_script', 'source_save', 'plan_generate', 'review_confirm', 'prompts_generate'].includes(String(payload.action));
  return invoke<T>('studio_request', { operation, payload: { ...(episode ? { title: project!.name, models: episode.models ?? {}, nativeVideoResolution: episode.nativeVideoResolution ?? null, contentMode: project!.contentMode ?? 'drama', generationMode: project!.generationMode ?? 'storyboard', ...(project!.styleTemplateId ? { styleTemplateId: project!.styleTemplateId } : {}), ...(project!.aspectRatio ? { aspectRatio: project!.aspectRatio } : {}), ...(project!.customResolution ? { customResolution: project!.customResolution } : {}), episodeIds: project!.episodes.map(e => e.id), episodeTitle: episode.name, ...(needsSource ? { sourceText: episode.script } : {}) } : {}), ...payload } });
}
export function studioError(error: unknown): string {
  return typeof error === 'string' && /^studio_[a-z_]+$/.test(error) ? error : 'studio_execution_failed';
}
const imports = new Map<string, StudioArtifact>();
let polling = false;
let retryImports = false;
let importEpoch: number | undefined;
/** Polling only reads state; never resubmits generation. Captured IDs isolate late results. */
export async function pollStudioExecutions(options?: { retryImports?: boolean }): Promise<void> {
  if (options?.retryImports) retryImports = true;
  if (polling || useAppStore.getState().studioConnection !== 'ready') return;
  polling = true;
  const epoch = useAppStore.getState().studioEpoch;
  if (retryImports || importEpoch !== epoch) imports.clear();
  retryImports = false;
  importEpoch = epoch;
  try {
    const draft = useAppStore.getState().studioDraft;
    for (const project of draft.projects) for (const episode of project.episodes) {
      const key = `${project.id}/${episode.id}`;
      try {
        const result = await studioRequest<StudioExecution>('poll', { projectId: project.id, episodeId: episode.id, historyLimit: useAppStore.getState().studioHistoryLimits?.[key] ?? 100 });
        if (useAppStore.getState().studioEpoch !== epoch) return;
        while (result.artifactCursor) {
          const page = await studioRequest<Pick<StudioExecution, 'artifacts' | 'artifactCursor'>>('poll', {
            projectId: project.id, episodeId: episode.id, artifactCursor: result.artifactCursor,
          });
          if (useAppStore.getState().studioEpoch !== epoch) return;
          result.artifacts.push(...page.artifacts);
          result.artifactCursor = page.artifactCursor;
        }
        for (const artifact of result.artifacts) {
          if (useAppStore.getState().studioEpoch !== epoch) return;
          const known = imports.get(artifact.id);
          if (known?.imported && known.url && await isStudioArtifactAvailable(known.url).catch(() => false)) {
            Object.assign(artifact, { url: known.url, imported: true }); continue;
          }
          try {
            const url = await importStudioArtifact(result.project, artifact.id);
            Object.assign(artifact, { imported: true, url }); imports.set(artifact.id, { ...artifact });
          } catch { artifact.importError = true; }
        }
        if (useAppStore.getState().studioEpoch === epoch) useAppStore.getState().updateStudioExecution(key, result);
      } catch (error) {
        if (useAppStore.getState().studioEpoch !== epoch) return;
        const previous = useAppStore.getState().studioExecutions[key];
        if (previous) useAppStore.getState().updateStudioExecution(key, { ...previous, error: studioError(error) });
      }
    }
  } finally {
    polling = false;
    if (retryImports) void pollStudioExecutions();
  }
}
export async function submitStudio(projectId: string, episodeId: string, selectedModels: Record<string, string>, retry = false): Promise<void> {
  const state = useAppStore.getState();
  const project = state.studioDraft.projects.find(p => p.id === projectId);
  const episode = project?.episodes.find(e => e.id === episodeId);
  if (!project || !episode) throw new Error('studio_invalid_project');
  const submission = retry ? episode.submission : {
    requestId: crypto.randomUUID(), models: selectedModels, nativeVideoResolution: episode.nativeVideoResolution ?? null, episodeTitle: episode.name, sourceText: episode.script, brief: episode.agentBrief, attachments: episode.attachments ?? [], rewriteAnchor: episode.rewriteAnchor,
    content: [
      `这是黄瓜 AI 客户端的短剧：${project.name}，当前分集：${episode.name}。同剧各集共享角色、场景和道具，先复用正式资产。使用短剧工作区的正式工作流与工具完成下面的制作要求，生成文件保存到当前项目的标准产物目录，不访问其他项目。`,
      '如果制作要求只要求文字、规划或分镜，则只执行相应阶段，不擅自生成付费图片或视频。实际媒体生成只使用本项目配置的黄瓜 AI 模型。需要用户选择时使用 AskUserQuestion。',
      '先读取当前正式项目、原文与脚本。下列内容仅为客户端本地草稿，空值不代表正式原文或脚本不存在；不要用空草稿覆盖正式内容。短剧用户要求原创时先创作并登记本集故事，要求拆镜时调用脚本规划，不能把提示词编写当成故事创作。广告项目继续使用广告 brief 的专用脚本生成流程。',
      `当前界面阶段（不限定用户的制作要求）：${state.studioStage}`, `本地原文草稿：\n${episode.script}`, `本地手工分镜草稿：\n${JSON.stringify(episode.shots)}`,
      `本轮制作要求：\n${episode.agentBrief || '请查看附图。'}`,
    ].join('\n\n'),
  };
  if (!submission) throw new Error('studio_submission_missing');
  if (!retry && episode.submission) throw 'studio_submission_uncertain';
  state.setStudioSubmission(projectId, episodeId, submission);
  await state.saveStudio();
  if (useAppStore.getState().studioSave === 'error') throw 'studio_save_failed';
  const result = await studioRequest<{ status: string; error?: string; requestId?: string }>('run', { projectId, episodeId, title: `${project.name} · ${episode.name}`, ...submission });
  if (result.status === 'rejected' && result.requestId === submission.requestId) {
    const latest = useAppStore.getState();
    const current = latest.studioDraft.projects.find(p => p.id === projectId)?.episodes.find(e => e.id === episodeId);
    if (current?.submission?.requestId === submission.requestId) {
      // Rejection is not acknowledgement: preserve the draft, images and rewrite anchor.
      if (!current.agentBrief.trim() && submission.brief?.trim()) {
        latest.restoreStudioMessage(projectId, episodeId, submission.brief, submission.attachments ?? []);
      }
      latest.setStudioSubmission(projectId, episodeId, undefined);
      await latest.saveStudio();
    }
    throw result.error ?? 'studio_execution_failed';
  }
  if (result.status !== 'accepted') throw 'studio_submission_uncertain';
  useAppStore.getState().acknowledgeStudioSubmission(projectId, episodeId, submission.requestId, submission.brief);
  await pollStudioExecutions();
}
