const studio: Record<string, string> = {
  '图片比例': 'Image aspect ratio',
  '视频比例': 'Video aspect ratio',
  '跟随项目': 'Use project default',
  '生成图片': 'Generate image',
  '请先确认规划，生成正式脚本。': 'Confirm the plan to create the formal script first.',
  '请先在脚本规划中编写画面提示词。': 'Write visual prompts in Script planning first.',
  '请先生成或上传本镜头的分镜图。': 'Generate or upload the storyboard image for this shot first.',
  '比例已保存，仅影响本镜头后续生成。': 'Ratio saved for subsequent generations of this shot only.',
  '生成任务已提交，可在制作进度中查看。': 'Generation submitted. Track it in production progress.',
  '点击生成将先核对目标规格与本地参考素材；确认后暂存至黄瓜 AI 服务器转 URL 提交上游。': 'Generating checks target specs and local references first, then stages them to Huanggua AI as URLs for upstream generation.',
  '本镜头仍有生成任务，请等待完成后再修改比例或生成。': 'Wait for this shot’s active generation before changing its ratio or generating again.',
  '当前比例不受支持，请重新选择。': 'This ratio is not supported. Choose another ratio.',

  "连接执行服务": "Connect runtime",

  "上次提交结果待确认，可原样恢复请求。": "Previous submission is unconfirmed. Recover the original request.",
  "恢复上次提交": "Recover submission",
  "执行状态": "Execution status",
  "正在调用工具": "Using tool",
  "取消任务": "Cancel task",
  "停止 Agent": "Stop Agent",
  "确认并继续": "Confirm and continue",
  "输入制作要求，如：先拆解本集分镜脚本（支持粘贴或拖入图片/视频）": "Enter instructions, e.g. break down this episode's storyboard (paste or drop images/videos)",
  "Ctrl+Enter 快捷发送 · 调用模型按量计费，生成资源自动保存至本地与资源库": "Ctrl+Enter to send · Model calls are billed by usage; assets save locally and to your library",
  "生成资源": "Generated assets",
  "刷新与重试入库": "Refresh and retry import",
  "已进入个人资源库": "Saved to personal library",
  "入库未完成，可重试": "Import incomplete; retry available",

  "待命": "Ready",
  "执行中": "Running",
  "已完成": "Completed",
  "执行失败": "Failed",
  "已停止": "Interrupted",
  "已关闭": "Closed",
  "创作模式": "Creation mode",
  "无限画布": "Infinite canvas",
  "短剧 Agent": "Drama Agent",
  "公共工作区": "Shared workspace",
  "画布项目": "Canvas projects",
  "个人资源库": "Personal library",
  "任务概览": "Task overview",
  "当前画布的 Agent 任务": "Agent tasks in the current canvas",

  "人物与场景": "Cast & settings",

  "审查": "Review",

  "成片": "Final cut",

  "新建短剧项目": "New drama project",
  "给你的故事起个名字": "Give your story a name",
  "项目将保存到本机，可先编写剧本和分镜。": "Your project is saved locally. Start with scripts and shots.",
  "无法读取短剧草稿，请重试。": "Could not load drama drafts. Please retry.",
  "正在读取短剧草稿…": "Loading drama drafts…",
  "短剧工作区": "Drama workspace",

  "保存失败，请重试": "Save failed. Retry.",
  "已保存到本机": "Saved locally",
  "新建短剧": "New drama",

  "准备制作": "Prepare production",

  "当前短剧": "Current drama",
  "添加分集": "Add episode",
  "已填写剧本": "Script drafted",
  "待编写": "Not written yet",

  "打开资源库": "Open library",

  "分集名称": "Episode name",
  "分集剧本": "Episode script",
  "字": "characters",

  "个镜头": "shots",
  "添加镜头": "Add shot",

  "镜头名称": "Shot name",
  "镜头时长": "Shot duration",
  "画面描述": "Shot description",

  "未生成": "Not generated",

  "导出剪映草稿": "Export Jianying draft",
  "收起 Agent": "Collapse Agent",

  "制作要求": "Production brief",

  "开始制作": "Start production",

  "短剧草稿保存失败，请重试后关闭。": "Drama draft save failed. Retry before closing.",
  '取回视频结果': 'Retrieve video result',
  '视频下载未完成，可取回原任务结果，不会重新生成。': 'The video download is incomplete. Retrieve the original result without generating again.',
  '首帧比例不同时会补边适配视频画幅，原分镜图保持不变。': 'If the first frame has a different ratio, padding fits it to the video canvas. The original storyboard image is preserved.',
};
export default studio;
