# 黄瓜 AI 画布 — 关键工程记忆与跨平台发版指南

本目录汇总桌面客户端（无限画布 + 离线短剧 Agent + 离线 3D 导演台）在跨平台适配、云端编译、国内在线增量热更新及核心交互演进中的关键架构决策与标准操作流程（SOP）。

## 文档索引

1. [Windows 打包、增量更新与 Gitee 在线热更新指南](./windows-release-and-gitee-updater.md)
   - 全量安装包与 LZMA 固实增量包双轨机制、`huangguaDelta` 基线校验、Gitee API 自动发布与本地归档清理。
2. [macOS 跨平台适配与 GitHub Actions 云端发布指南](./macos-cloud-build-and-release.md)
   - 平台配置拆分、Python 3.12 独立离线短剧运行时组装、Rust Unix 权限恢复、无头 `hdiutil` `.dmg` 打包与首次打开指引。
3. [短剧 Agent 对话流降噪与全局关于弹窗规范](./studio-ui-and-about-dialog.md)
   - 子智能体与续写噪音过滤、对话轮次聚合展示、左上角品牌 Logo 全局唤起关于与检查更新窗口。
4. [Bug 清单](./bug-list.md)

---

## 核心仓库与分发矩阵

| 用途 | 平台 / 仓库 | 说明 |
|---|---|---|
| 主源码与 macOS 云端构建 | GitHub `HuangguaOrg/huanggua-ai-canvas` | 公开仓库（Public），使用免费 GitHub Actions `macos-latest` 编译并向 GitHub Releases 发布 `.dmg` 安装包 |
| 短剧引擎源码种子 | GitHub Release `runtime-engine-*` | 托管经审计的纯 Python 引擎源码与跨平台依赖约束 `constraints.txt`，供云端组装各平台离线运行时 |
| 离线 3D 导演台组件 | `scripts/director-desk-release.json` | 固定版本与 SHA-256 摘要校验，随客户端安装包离线内置 |
| 国内 Windows 在线热更新 | Gitee `xiang834740239/huanggua-aiagent` | 托管签名更新清单 `latest.json`（`master`/`main` 双分支兜底）与 `< 100 MiB` 签名增量更新包 |
| 本地安装包归档目录 | 仓库同级 `../AI-Canvas-tauri-release/` | 仅保留最新版本的 Windows `.exe`、macOS `.dmg` 与校验清单，保留 `runtime-*` 运行时备份目录 |

---

## 全局安全与工程红线

1. **凭据零入库**：
   - Tauri Minisign 更新签名私钥（`*.key`）、Gitee 访问令牌（`*.token`）、`.secrets/`、`.env*` 均被 `.gitignore` 严格排除，严禁提交至 Git 或打印到构建日志。
   - `src-tauri/tauri.conf.json` 中仅保留 Minisign **公钥**（`plugins.updater.pubkey`）用于客户端验签。
2. **离线运行时单包分发与防篡改绑定**：
   - `src-tauri/resources/huanggua-studio/` 及其打包产物 `huanggua-studio.zip`、`huanggua-studio.json`、`director-desk.tar.gz` 不进入 Git 树。
   - 构建期由 `src-tauri/build.rs` 将 `huanggua-studio.zip` 与 `manifest.json` 的 SHA-256 摘要编译进原生二进制，运行时在应用私有目录逐文件校验摘要后方可执行。
3. **Python 运行时字节码卫生**：
   - 在已暂存的 `src-tauri/resources/huanggua-studio` 目录上调用内置 Python 执行检查或测试时，必须携带 `PYTHONDONTWRITEBYTECODE=1` 与 `-B -s` 参数，防止生成未登记在 `manifest.json` 中的 `.pyc` 文件导致 `npm run release:preflight` 预检阻断。
4. **发版清理原则**：
   - 每次生成新版安装包后，通过 `npm run release:export` 将最新产物归档至 `../AI-Canvas-tauri-release/<version>-<platform>/` 并自动清理过期的历史 `.exe` 安装包，避免磁盘堆积与误发旧包。
