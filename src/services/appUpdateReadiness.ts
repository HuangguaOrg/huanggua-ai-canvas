import { useAppStore } from '../store/useAppStore';
import { prepareSettingsClose, resumeSettingsPersistence } from './configPersistenceQueue';

/** The update overlay prevents new UI actions; never restart over running work. */
export async function prepareAppUpdate(): Promise<() => void> {
  const state = useAppStore.getState();
  if (state.nodes.some((node) => node.data.status === 'loading')
    || state.studioConnection === 'connecting'
    || state.agentTasks.some((task) => ['queued', 'running', 'planning', 'waiting_tool', 'waiting_approval'].includes(task.status))
    || Object.values(state.studioSubmitting).some(Boolean)
    || Object.values(state.studioExecutions).some((execution) => execution.status === 'running' || execution.uncertain
      || execution.questions.length > 0 || !!execution.queued?.length
      || execution.tasks.some((task) => !['succeeded', 'failed', 'cancelled', 'completed'].includes(task.status)))
    || state.studioDraft.projects.some((project) => project.episodes.some((episode) => !!episode.submission))) {
    throw new Error('请先完成或停止当前生成任务，并处理待确认的提交，再安装更新');
  }
  try {
    if (!await prepareSettingsClose(true)) throw new Error('设置尚未保存，已取消更新安装');
    await state.saveStudio();
    if (useAppStore.getState().studioSave === 'error') throw new Error('短剧草稿保存失败，已取消更新安装');
    if (state.currentProjectId || state.nodes.length) {
      const saved = await state.saveCurrentProjectSilent();
      if (!saved || state.currentProjectId && saved !== state.currentProjectId || useAppStore.getState().autoSaveFailure) {
        throw new Error('画布保存失败，已取消更新安装');
      }
    }
    return resumeSettingsPersistence;
  } catch (error) { resumeSettingsPersistence(); throw error; }
}
