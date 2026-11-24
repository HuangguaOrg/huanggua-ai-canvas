# macOS 跨平台适配与 GitHub Actions 云端发布指南

本文档说明如何在无本地 Mac 设备的情况下，基于 GitHub Actions Apple Silicon 真机运行器（`macos-latest`）编译包含完整离线短剧 Agent 与 3D 导演台的 macOS `.dmg` 客户端，并发布至 GitHub Releases。

---

## 1. 平台配置解耦架构

为保证同一套源码同时支持本地 Windows 打包与云端 macOS 打包，Tauri 配置拆分为三层：

1. **基础公共配置 `src-tauri/tauri.conf.json`**
   - 仅保留全平台通用的产品元数据、安全策略（CSP / `assetProtocol`）与四项跨平台打包资源：
     - `resources/ai-canvas-mcp.mjs`
     - `resources/huanggua-studio.zip`
     - `resources/huanggua-studio.json`
     - `resources/director-desk.tar.gz`
2. **Windows 平台叠加配置 `src-tauri/tauri.windows.conf.json`**
   - Tauri v2 在 Windows 构建时自动识别并深度合并该文件。
   - 承载 Windows 专属的 `powershell.exe -File scripts/prepare-windows-runtime.ps1` 构建钩子与 `msvcp140*.dll` / `vcruntime140*.dll` 资源，避免 macOS 构建器尝试调用 `powershell.exe`。
3. **macOS 发布覆盖配置 `scripts/tauri-release-macos.config.json`**
   - 构建时通过 `--config scripts/tauri-release-macos.config.json` 传入。
   - 设置 `bundle.targets: ["app"]`、`createUpdaterArtifacts: false` 并清空 Windows 专属 Gitee 更新端点。

---

## 2. macOS 离线短剧运行时（Studio Runtime）构建机制

macOS 客户端与 Windows 一样采用**零外部依赖、开箱即用**策略，安装后首次打开短剧工作台时自动将 `huanggua-studio.zip` 解压校验至应用私有目录 `~/Library/Application Support/com.huanggua.canvas/huanggua-studio-runtime/<hash>/`。

### 2.1 引擎源码种子与版本锁定（`runtime/studio/engine-distribution.json`）

- 短剧引擎纯 Python 源码包与跨平台依赖约束 `constraints.txt` 托管于本仓库 Release 标签 `runtime-engine-*`，并由 `runtime/studio/engine-distribution.json` 固定资产名与 SHA-256。
- `constraints.txt` 锁定了与 Windows 端一致的 PyPI 依赖版本（如 `claude-agent-sdk`、`fastapi`、`pillow`、`pydantic`、`pdf_oxide`、`pyjianyingdraft`、`imageio-ffmpeg` 等），同时剔除了 `pywin32`、`comtypes`、`uiautomation` 等 Windows 专属传递依赖，交由 `uv` 按目标 macOS 架构解析对应原生 Wheel。

### 2.2 云端运行时自动组装（`scripts/prepare-macos-studio-runtime.py`）

云端工作流执行 `python3 -B scripts/prepare-macos-studio-runtime.py --platform darwin-aarch64 --clean` 完成以下步骤：

1. **校验下载导演台组件**：按 `scripts/director-desk-release.json` 下载并验证 `director-desk.tar.gz` 的 SHA-256。
2. **校验解压引擎种子包**：校验 SHA-256 并拦截任何包含路径穿越或软链的异常归档条目。
3. **安装独立 CPython 3.12 与锁定依赖**：
   - 调用 `uv python install cpython-3.12-macos-aarch64-none`（Intel 为 `x86_64`）获取免系统依赖的便携 Python。
   - 使用 `uv pip install --python <py_bin> --python-platform <arch>-apple-darwin --system --break-system-packages -c constraints.txt ...` 安装本地子包（`arcreel-catalog-core`、`arcreel-market-core`）及全部第三方依赖。
   - 仅在 `site-packages/arcreel-<version>.dist-info/` 写入轻量包元数据以满足 `importlib.metadata.version("arcreel")` 查询，不重复拷贝 `engine/lib` 与 `engine/server` 源码。
4. **体积裁剪与符号链接实体化**：
   - 移除 `config-3.12-darwin`（约 40 MB 静态库 `.a`）、`tkinter`/`tcl`/`tk`、`idlelib`、`test` 及非 Ark 火山引擎服务包（`scripts/package-studio-runtime.py` 同时支持 Windows `python/Lib/site-packages` 与 POSIX `python/lib/python3.*/site-packages` 裁剪）。
   - 将 `bin/python3` 实体化为独立可执行文件并开启 `--dereference-links`，确保最终运行时目录不含任何符号链接，通过 `scripts/check-desktop-release.mjs` 严格清单核验。
5. **无污染原生冒烟测试**：
   - 以 `PYTHONDONTWRITEBYTECODE=1` 与 `-B -s` 在 Apple Silicon 真机上直接运行暂存目录中的 `python/bin/python3`，验证 `server.app`、`claude_agent_sdk`、`PIL`、`pydantic_core`、`pdf_oxide`、`imageio_ffmpeg` 导入及内置 `claude`、`ffmpeg` 二进制可执行性。

### 2.3 Rust 运行时管理与权限恢复（`src-tauri/src/studio_runtime.rs`）

- 按编译目标自动匹配清单平台标识：`windows-x86_64`、`darwin-aarch64`、`darwin-x86_64`。
- ZIP 归档不保留 Unix 模式位时，`extract_worker` 在 Unix 平台解压并校验完每个文件的 SHA-256 后，自动对 `python/bin/*`、`/_bundled/claude`、`/binaries/ffmpeg`、`.dylib`、`.so`、`#!` 脚本及 Mach-O 魔数文件恢复 `0o755` 权限。
- macOS 下无需 Windows Git Bash（`git/usr/bin/bash.exe`），启动子进程时自动注入 `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` 系统工具路径。

---

## 3. GitHub Actions 云端工作流（`.github/workflows/release-macos.yml`）

### 3.1 触发方式

在 GitHub 仓库页面进入 **Actions → Release macOS → Run workflow**：
- `tag`：填写与 `src-tauri/tauri.conf.json` 版本一致的标签（如 `v0.11.8`）。
- `include_intel`：默认 `false`（仅编译主流 Apple Silicon `arm64` 安装包）；勾选 `true` 时会额外并行编译 Intel `x86_64` 安装包。

> [!NOTE]
> `HuangguaOrg/huanggua-ai-canvas` 设为公开仓库（Public）后，GitHub Actions 的 `ubuntu-latest` 与 `macos-latest` 均享有免费不限时构建额度。普通 `main` 分支推送不会自动触发重型打包流水线，仅在手动触发或正式版本标签发布时运行。

### 3.2 关键构建优化与防坑要点

1. **前后端分阶段构建**：先在 `ubuntu-latest` 完成 `npm ci`、`npm run lint` 与 `npm run build` 并上传 `dist/` 产物，减少 `macos-latest` 运行时长。
2. **仅编译桌面可执行文件（`--bins`）与编译缓存**：
   - `src-tauri/Cargo.toml` 中 `[lib]` 同时声明了 `staticlib`、`cdylib`、`rlib`；直接全量构建会额外链接移动端库。先执行 `cargo build --release --target <rust_target> --bins` 并配合 `Swatinem/rust-cache` 持久化 `src-tauri/target`，首次冷编译后后续发版可大幅提速。
3. **无头 `hdiutil` 制作 `.dmg`（规避 Finder AppleScript 挂起）**：
   - 在 macOS 15+ 无头 CI 环境中，传统 `create-dmg` / `bundle_dmg.sh` 调用 `osascript` 控制 Finder 排列图标时可能触发系统自动化权限弹窗而无限阻塞。
   - 工作流改为先用 `tauri build --bundles app` 生成完成 Ad-hoc 签名（`APPLE_SIGNING_IDENTITY="-"`）的 `黄瓜 AI 画布.app`，经 `codesign --verify --deep --strict` 验签通过后，创建临时目录放入 `.app` 与 `/Applications` 软链接，直接调用系统原生 `hdiutil create -volname "黄瓜 AI 画布" -srcfolder ... -ov -format UDZO` 生成标准 `.dmg` 镜像。
4. **ASCII 标准文件名防转义**：
   - GitHub Releases 上传含中文与空格的资产文件名时会自动将其替换为点号。因此发布资产统一命名为 `HuangGuaAI-<version>-macos-arm64.dmg`（及同名 `.sha256`），镜像挂载后内部的应用程序仍保持中文名 `黄瓜 AI 画布.app`。

---

## 4. macOS 用户首次安装打开说明

由于当前构建使用免费 Ad-hoc 签名（未配置 \$99/年的 Apple Developer ID 证书与 Notarization 公证），macOS 用户从浏览器下载 `.dmg` 并拖入 `Applications` 后，首次双击可能看到系统 Gatekeeper 提示“无法验证开发者”或“已损坏”。可通过以下任一方式放行（仅首次需要）：

1. **终端一键移除下载隔离属性（推荐）**：
   ```bash
   xattr -cr "/Applications/黄瓜 AI 画布.app"
   ```
2. **系统设置放行**：打开 **系统设置 → 隐私与安全性**，在底部安全性提示处点击 **仍要打开**。
