# 短剧 Agent 对话流降噪与全局关于弹窗规范

本文档记录短剧 Agent 工作台聊天面板的消息清洗、轮次聚合展示，以及顶部导航栏全局关于与在线更新入口的设计边界。

---

## 1. 短剧 Agent 对话流降噪架构

短剧引擎底层基于多工具编排与子智能体（Subagent）协作，原始会话 JSONL 中包含大量内部调度记录。为避免内部噪音直接暴露给创作者，采用**后端源头过滤 + 前端轮次聚合**双层处理：

### 1.1 后端桥接层过滤（`runtime/studio/`）

涉及文件：
- `runtime/studio/conversation_api.py`
- `runtime/studio/desktop_bridge.py`
- `runtime/studio/workspace_api.py`

过滤规则：
1. **子智能体内部消息隔离**：忽略带有 `parent_tool_use_id` 的子会话中间流事件与历史记录，仅保留主智能体面向用户的输出与工具摘要。
2. **上下文压缩摘要隐藏**：过滤 `isCompactSummary` / `compact_summary` 等内部上下文折叠标记消息。
3. **流截断自动续写提示词隐藏**：当底层输出因长度截断触发系统自动续写提示（如 `"Your response above was cut off mid-stream..."`）时，后端将其识别为内部控制指令，不在用户气泡中渲染。

### 1.2 前端格式化与紧凑布局（`src/components/studio/`）

涉及文件：
- `src/components/studio/studioChatFormatter.ts`
- `src/components/studio/StudioAgentPanel.tsx`
- `src/components/studio/StudioSessions.tsx`
- `src/components/studio/StudioAttachments.tsx`
- `src/components/studio/StudioMessageQueue.tsx`
- `src/styles/huanggua-workspace.css`
- `src/i18n/locales/{zh-CN,en-US,ja-JP,ko-KR}/studio.ts`

核心行为：
1. **助手消息按轮次（Turn）聚合**：将同一轮回复中的连续思考、工具调用步骤折叠收纳于可展开的步骤摘要条中，突出最终结论正文。
2. **工具名称语义化**：将内部工具标识映射为直观的中文业务动作名称，隐藏原始 JSON 参数噪音。
3. **轻量安全 Markdown 渲染**：支持标题、列表、加粗、行内代码与代码块排版，不引入任意 HTML 注入风险。
4. **空间利用率优化**：顶部采用单行紧凑标题栏，历史会话收折为按需展开的抽屉面板，附件区与待发队列在空态下保持零高度占位。

---

## 2. 全局品牌入口与关于/更新窗口

涉及文件：
- `src/components/AboutDialog.tsx`
- `src/components/Titlebar.tsx`
- `src/components/studio/WorkspaceChrome.tsx`

设计规范：
1. **独立 `AboutDialog` 组件**：
   - 统一承载产品名称、当前版本号、在线检查更新按钮与更新进度提示、核心能力标签、技术栈展示及黄瓜 AI 官网入口（已移除原社区栏中的 GitHub 图标外链按钮）。
2. **全视图左上角 Logo 一键唤起**：
   - 除画布内标题栏菜单入口外，`WorkspaceChrome.tsx` 左上角的“黄瓜 AI”品牌 Logo 区域绑定点击事件，用户在项目列表首页、无限画布或短剧 Agent 任意界面点击左上角 Logo 均可直接打开 `AboutDialog` 查看当前版本或触发在线更新检查。


## 3. 0.11.9 审查后的素材与执行修正（待验收）

本批在任务分支实现，未更改版本号，未发布安装包。客户端基线为 `268d215b`；配套主站分支 `fix/canvas-media-staging` 基线为 `e4c68aa`。部署顺序为服务端先支持无模型参数上传，再交付客户端；旧客户端携带的 model 参数由服务端忽略。

- 缺失参考图片或视频仅提醒，跳过缺失项后使用剩余素材继续；模型本身的素材能力校验仍在生成时执行。
- 聊天附件必须完整保存到项目目录才返回成功，失败保留用户已有草稿并要求重新上传；不把存储、连接或转码异常显示成附件数量超限。
- 上传队列、桌面执行请求和视频转换取消固定处理时限，等待完成或失败；用户取消、连接断开及启动健康探测仍有各自行为。
- 素材暂存不接收模型参数，保留账号鉴权、上传限流、格式和大小限制，不回退到匿名图床。
- 资源采用每页 200 项的稳定快照，读取全部分页后回填，不再按 1000 项截断；入库缓存检查当前素材目录及文件存在性，显式重试会重新导入。
- 桌面 Agent profile 替换旧 Web 操作指引，按内嵌工具的终态返回约定处理任务；未提供的管理入口如实说明。视频关键帧不冒充完整视频或音轨理解。
- 关于页、片场彩蛋和 README 产品入口使用黄瓜品牌；许可证、依赖标识及历史截图保留原有来源。

验收前置：使用包含本批改动的 Tauri 客户端、已部署配套暂存接口的测试环境，准备图片、MOV/WebM 视频及一个可写项目目录。涉及真实付费生成的步骤由用户决定执行。

1. 绑定镜头参考图和视频，再移走对应项目文件；打开生成预检，应显示具体缺失提示，仍可继续。生成执行阶段再缺失时，工作区也应提醒。
2. 令项目目录不可写后添加聊天附件，应报告保存失败、不新增成功附件；恢复目录后重新上传，项目中应保留完整原图或视频。
3. 使用处理超过原 180 秒阈值的视频，界面应继续等待，不因固定处理时限报错；真实服务端失败应可见。主动取消上传不应释放尚未结束的原生传输以并发启动新大文件。
4. 无模型参数、仅文本模型权限及旧客户端携带已下架模型参数时，图片和视频暂存均可用；未登录或失效凭据、格式伪装、超限文件仍被拒绝。
5. 项目有超过 1000 项资源时，应能显示靠后的资源；分页期间新增文件在下一轮出现，不漏项或重复。
6. 删除素材库副本但保留短剧原件，点击“刷新与重试入库”应恢复；切换素材目录后不能沿用旧目录链接。
7. Agent 对工具终态不重复轮询或提交；清空回收站等未提供入口不编造客户端按钮；关于页与 README 导航不再使用原项目产品入口。

客户端本次未运行测试，待用户验收。回归入口：`tests/services/huangguaMediaUpload.test.ts`、`uploadServiceMemory.test.ts`、`studioExecution.test.ts`，以及 `runtime/studio/test_conversation.py`、`test_media_staging.py`、`test_bridge.py`、`test_creative_profile.py`。Python 集成测试需按现有运行时测试流程配置隔离引擎；不能使用真实账号目录。
