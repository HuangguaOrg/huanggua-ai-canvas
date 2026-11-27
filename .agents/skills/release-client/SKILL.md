---
name: release-client
description: "黄瓜 AI 画布桌面客户端（Windows + macOS Apple Silicon）跨平台自动打包、GitHub Release 双端正式发版与 Gitee 签名热更新推送技能。当用户要求「生成双端测试包」「发双端正式版」「发布客户端新版本」「补推 Gitee 热更」或「核验线上客户端版本」时使用。"
---

# 客户端双端打包与正式发版（release-client）

本技能封装 `HuangguaOrg/huanggua-ai-canvas` 的跨平台（macOS / Windows 开发机通用）云端双端编译、GitHub Release 完整安装包发布与 Gitee 应用内签名热更新全自动闭环。

## 触发边界与红线

1. **严禁擅自触发**：日常开发、修 Bug、本地测试、普通提交与 PR **绝不自动打包或发版**。仅在用户明确要求以下两类操作之一时执行：
   - **「给我双端测试包」**：走 `mode=test`，仅生成未签名 Windows + macOS 测试安装包 Artifact，**不创建 GitHub Release、不修改 Gitee `latest.json`**。
   - **「验证后发双端正式版」**：走 `mode=release`，完成版本元数据同步、合入 `main`、推送 `vX.Y.Z` 标签、云端三路编译签名、公开 GitHub Release、自动上传 Gitee 热更与更新 `latest.json`，并返回核验回执。
2. **本机零敏感密钥**：`TAURI_SIGNING_PRIVATE_KEY` 与 `GITEE_TOKEN` 均保存在 GitHub Actions Secrets 中。无论你在 macOS 还是同伴在 Windows 操作，本机只需具备 **Node.js 22+**、**`git`** 与已登录的 **`gh` CLI**（具备 `repo`、`workflow` 权限），严禁把任何私钥或令牌写入代码、命令行参数、提交说明或聊天记录。
3. **已公开版本不可变**：一旦 `gh release view vX.Y.Z` 显示已公开（`isDraft: false`），**严禁删除、覆盖该 Release 或强推移动同名 Tag**。若发版后发现代码或文案问题，必须递增下一个修订号（如 `0.11.15`）重新发版。
4. **不动 README 正文**：除 `release:prepare` 自动更新四语种 `README*.md` 的版本号徽章外，未经用户明确授权不改动 `README.md` 正文。

## 跨平台统一命令（macOS zsh/bash 与 Windows PowerShell 一致）

```bash
# 1. 触发云端双端测试包（不污染 Release 与 Gitee）
npm run release:test -- --ref <分支名或SHA> --watch

# 2. 同步 5 份版本文件 + 4 份 README 徽章 + 发布标题并校验元数据
npm run release:prepare -- <X.Y.Z> --title "<简明版本主题>"

# 3. 推送正式标签并全程监控云端编译、GitHub Release 与 Gitee 热更闭环
npm run release:ship -- <X.Y.Z>

# 4. 免编译补推 Gitee 热更（默认云端执行，本机无需 GITEE_TOKEN）
npm run release:gitee -- v<X.Y.Z>

# 5. 独立核验线上 GitHub Release 7 份资产与 Gitee latest.json 双端可达性
npm run release:verify -- v<X.Y.Z>
```

---

## 流程一：生成双端测试包（「给我双端测试包」）

1. 确认待测代码已推送到远端分支（如 `feat/xxx`）：
   ```bash
   git status -sb
   git push -u origin HEAD
   ```
2. 触发云端双端测试包并等待构建完成（约 15–22 分钟）：
   ```bash
   npm run release:test -- --ref <远端分支名> --watch
   ```
3. 从脚本输出的 JSON 回执中复制 `downloadCommand` 下载双端测试安装包，或将 Actions 运行链接与下载命令发给用户验收。

---

## 流程二：发布双端正式版（「验证后发双端正式版」）

### 第 1 步：核实变更范围与目标版本号

在最新 `origin/main` 上查看自上一个正式 Tag 以来的真实已合并提交，不得编造未合并功能：

```bash
git fetch origin main --tags
git tag --sort=-v:refname | head -n 5
git log --oneline v<上一版本>..origin/main
```

若用户未指定具体版本号，默认将最新正式版的补丁号 `+1`（如 `0.11.14` → `0.11.15`）。

### 第 2 步：准备 `.release-notes.md` 与同步全部版本元数据

1. 从 `origin/main` 创建发版准备分支（如 `release/vX.Y.Z`）。
2. 更新根目录 `.release-notes.md`（UTF-8 LF 编码）：
   - 首行标题必须包含 `黄瓜 AI 画布 vX.Y.Z`（`release-workflow.mjs` 强制校验）；
   - 条目简洁陈述面向用户的真实改动，保留底部「下载与升级」说明。
3. 运行一键准备命令：
   ```bash
   npm run release:prepare -- <X.Y.Z> --title "<简明版本主题>"
   ```
   该命令会自动同步并校验：
   - `package.json`、`package-lock.json`（根 `version` 与 `packages[""].version`）
   - `src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`（`huanggua-ai` 包版本）
   - `README.md`、`README.en.md`、`README.ja.md`、`README.ko.md` 版本徽章
   - `.github/release-title.txt`（格式固定为 `黄瓜 AI 画布 vX.Y.Z - <版本主题>`）

### 第 3 步：提交发版 PR 并合入 `main`

确认 `git status --short` 仅包含上述发版元数据文件后，使用中文提交说明推送并合入 `main`：

```bash
git add .github/release-title.txt .release-notes.md package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock README*.md
git commit -m "release: 发布 <X.Y.Z> Windows 与 Mac 客户端"
git push -u origin HEAD
gh pr create --base main --title "release: 发布 <X.Y.Z> Windows 与 Mac 客户端" --body "同步 <X.Y.Z> 版本元数据与发布说明。"
gh pr merge --merge --delete-branch
```

随后将本地 `main` 工作区快进对齐最新 `origin/main`：

```bash
git checkout main && git fetch origin main && git merge --ff-only origin/main
```

### 第 4 步：执行 `release:ship` 跑通云端全链路

在干净且 `HEAD === origin/main` 的工作区运行：

```bash
npm run release:ship -- <X.Y.Z>
```

云端 `.github/workflows/release.yml` 自动串行/并行完成以下阶段（总耗时约 **25–35 分钟**）：
1. **源码门禁（`ci.yml` + `Quality gate`）**：仅版本元数据变更自动命中增量快速门禁，构建前端并写入 SHA-256 清单（约 5–9 分钟；重跑已过检标签仅需 ~20 秒）。
2. **三路并行打包签名**：
   - `Build Windows x64`：标准 NSIS 安装包 + `.sig` + `.sha256` + Gitee 签名增量包 `HuangGuaAI-<X.Y.Z>-windows-x64-update.exe`（约 11–14 分钟）；
   - `Build Windows x64 legacy`：兼容无 AVX 老 CPU 的完整安装包 + `.sha256`（约 8–13 分钟）；
   - `Build macOS (arm64)`：Apple Silicon `.app` Ad-hoc 签名与启动冒烟测试 + `.dmg` + `.sha256` + 90 MiB 分片签名 Gitee 更新包（约 20–23 分钟）。
3. **原子公开 GitHub Release（`Publish GitHub Release`）**：集中校验全部 7 份标准化英文文件名资产非空且 `sha256sum` 通过后，使用 `gh release create --verify-tag` 原子上传并公开：
   - `HuangGuaAI-<X.Y.Z>-macos-arm64.dmg` 及 `.sha256`
   - `HuangGuaAI-<X.Y.Z>-windows-x64-setup.exe`、`.sha256` 及 `.sig`
   - `HuangGuaAI-<X.Y.Z>-windows-x64-legacy-setup.exe` 及 `.sha256`
4. **自动推送 Gitee 热更（`Publish Gitee update & latest.json`）**：
   - 启用 `tcp_bbr` 拥塞控制，6 线程分块流式上传至 `xiang834740239/huanggua-aiagent` 并逐个回读校验远端 SHA-256（约 2–3 分钟）；
   - **自动 1 GB 配额治理**：Gitee 免费仓库总附件上限为 1 GB（每版双端热更包约 387 MiB）。脚本在上传前会自动保留当前线上 `latest.json` 指向的生效版本与本次新版本，按从旧到新自动清理更早期已被取代的热更附件（完整历史安装包永久保留在 GitHub Release）；
   - 全部附件校验通过后更新 `master` 分支 `latest.json` 并公开回读核验。

### 第 5 步：核验回执与结果交付

`release:ship` 结束时会自动调用 `verifyPublicRelease` 并输出 JSON 回执（也可随时运行 `npm run release:verify -- v<X.Y.Z>`）。核对 `ok: true` 后向用户汇报：
- 版本号与 GitHub Release 页面链接；
- 7 份完整安装包资产已就绪；
- Gitee `latest.json` 已更新至 `<X.Y.Z>`，且 `windows-x86_64` 与 `darwin-aarch64` 热更地址均可达。

---

## 异常恢复与兜底手册

- **GitHub Release 已公开，但 `Publish Gitee` 因跨境网络波动失败**：
  - **切勿删除或修改已公开的 GitHub Release / Tag**；
  - 直接运行免编译云端补推（使用云端 `GITEE_TOKEN` 与已有构建产物，约 3 分钟完成）：
    ```bash
    npm run release:gitee -- v<X.Y.Z>
    ```
  - 若海外 Runner 到 Gitee 彻底断连，且本机已配置 `GITEE_TOKEN` 环境变量（或 `.secrets/huanggua-desktop/gitee.token`），可加 `--local` 走本机国内网络补传：
    ```bash
    npm run release:gitee -- v<X.Y.Z> --local
    ```
- **本地终端中断，需继续监控正在运行的发版工作流**：
  ```bash
  npm run release:ship -- <X.Y.Z> --resume
  ```
- **标签已推送但 GitHub Release 尚未公开，修复 `main` 上的工作流后需重新调度**：
  ```bash
  npm run release:ship -- <X.Y.Z> --retrigger
  ```
