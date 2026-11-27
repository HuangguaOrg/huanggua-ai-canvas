import { pollStudioExecutions, studioRequest } from './studioExecutionService';

export interface StudioScope { projectId: string; episodeId: string }
export function studioWorkspace<T>(scope: StudioScope, action: string, options: { id?: string; category?: string; data?: Record<string, unknown> } = {}): Promise<T> {
  return studioRequest<T>('workspace', { ...scope, action, ...options });
}

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export async function uploadStudioLocalFile(
  scope: StudioScope,
  kind: string,
  file: File,
  options: {
    name?: string;
    derivative?: string;
    category?: string;
    onProgress?: (percent: number) => void;
  } = {},
): Promise<void> {
  if (file.size > MAX_UPLOAD_BYTES || !file.size) {
    throw 'studio_upload_size';
  }
  let id: string | undefined;
  try {
    const result = await studioWorkspace<{ id: string }>(scope, 'upload_begin', {
      data: {
        kind,
        name: options.name,
        derivative: options.derivative,
        category: options.category,
        filename: file.name,
        size: file.size,
      },
    });
    id = result.id;
    for (let offset = 0; offset < file.size; offset += 384 * 1024) {
      const bytes = new Uint8Array(await file.slice(offset, offset + 384 * 1024).arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }
      await studioWorkspace(scope, 'upload_chunk', { id, data: { offset, chunk: btoa(binary) } });
      options.onProgress?.(Math.round(((offset + bytes.length) / file.size) * 100));
    }
    await studioWorkspace(scope, 'upload_finish', { id });
    id = undefined;
    await pollStudioExecutions();
  } finally {
    if (id) {
      try {
        await studioWorkspace(scope, 'upload_cancel', { id });
      } catch {
        /* Server expires the staged file. */
      }
    }
  }
}
export function workspaceError(error: unknown): string {
  if (error === 'studio_attachment_limit') return '每条消息最多添加 5 个附件，请移除部分附件后重试。';
  if (error === 'studio_project_storage_unavailable') return '附件未完整保存：项目存储目录不可用或磁盘写入失败，请检查目录权限和剩余空间后重新上传。';
  if (error === 'studio_connection_lost' || error === 'studio_transport_failed') return '与短剧执行服务的连接已断开，请恢复连接后重试。';
  if (error === 'studio_style_required') return '请先在「项目概览」中选择一个画面风格模版，或上传一张风格参考图。';
  if (error === 'studio_shot_busy') return '本镜头仍有生成任务，请等待完成后再修改比例或生成。';
  if (error === 'studio_prompt_required') return '请先在脚本规划中编写画面提示词。';
  if (error === 'studio_script_required') return '请先确认规划，生成正式脚本。';
  if (error === 'studio_invalid_ratio') return '当前比例不受支持，请重新选择。';
  if (error === 'studio_video_model_incompatible') return '所选视频模型不支持当前制作方式，请在 Agent 模型设置中更换视频模型。';
  if (error === 'studio_model_unavailable') return '所选模型已不可用，请刷新执行服务并重新选择模型。输入内容已保留。';
  if (error === 'studio_login_required') return '登录已失效，请在账号页面重新登录后连接执行服务。';
  if (error === 'studio_account_unavailable') return '暂时无法获取账号模型，请检查网络或稍后刷新模型列表。';
  if (error === 'studio_account_forbidden') return '当前账号暂时无法访问模型服务，请检查账号的服务权限。';
  if (error === 'studio_account_invalid_response') return '账号模型数据异常，请刷新模型列表；若仍失败，请联系平台处理。';
  if (error === 'studio_text_models_unavailable') return '账号暂未返回可用的文本模型，短剧 Agent 无法连接。请检查 Agent / text 的模型服务后刷新列表。';
  if (error === 'studio_model_configuration_failed') return '短剧模型配置失败，请重新连接执行服务后刷新模型列表。';
  if (error === 'studio_save_failed') return '本地草稿保存失败，请先重试保存。';
  if (error === 'studio_merge_blocked') return '合并条件已变化，请重新检查冲突，等待旧项目任务完成。';
  if (error === 'studio_merge_invalid_script') return '旧项目存在结构异常的脚本，已保留原项目，请修复后重新合并。';
  if (error === 'studio_merge_history_conflict') return '发现已删除素材遗留的同名版本记录，已停止合并并保留原项目，请先处理这些历史素材。';
  if (error === 'studio_merge_choices_required') return '请先选择每个同名素材的处理方式。';
  if (error === 'studio_session_superseded') return '这是改写前的会话，请切换到新分支继续。';
  if (error === 'studio_legacy_merge_required') return '检测到多个旧版独立执行项目，已保留原数据；请先完成旧项目合并再继续。';
  if (error === 'studio_invalid_attachment') return '附件不可用，请重新选择 PNG/JPEG/WebP 图片（≤ 30 MB）或 MP4/MOV/M4V/WebM 视频（≤ 128 MB）。';
  if (error === 'studio_invalid_video') return '视频文件无法解析或不包含有效视频流，请选择 MP4、MOV、M4V 或 WebM 文件。';
  if (error === 'studio_upload_size') return '文件大小超出本地上传上限（图片不超过 30 MB，视频不超过 200 MB）。';
  if (error === 'studio_session_busy') return '当前会话仍在执行，请先停止 Agent。';
  if (error === 'studio_submission_uncertain') return '请先恢复上次提交，确认结果后再切换会话。';
  if (error === 'studio_edit_conflict') return '内容已更新，请重新读取后再修改。';
  if (error === 'studio_engine_rejected') return '操作未完成，请检查素材、脚本和制作条件后重试。';
  if (error === 'studio_runtime_not_packaged' || error === 'studio_runtime_damaged') return '短剧运行环境缺失或校验失败，请重新运行黄瓜 AI 完整安装包修复。';
  if (error === 'studio_runtime_disk_full') return '磁盘空间不足，短剧运行环境约需 1 GB 可用空间，请清理后重试。';
  if (error === 'studio_runtime_prepare_failed') return '短剧运行环境准备失败，请重启应用后重试。';
  if (error === 'studio_runtime_not_installed') return '本地开发环境缺少短剧运行时，请准备运行环境后重新连接。';
  return '操作失败，请检查连接后重试。';
}
