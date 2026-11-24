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
