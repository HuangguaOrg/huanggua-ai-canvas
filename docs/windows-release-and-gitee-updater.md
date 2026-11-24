# Windows 打包、增量更新与 Gitee 在线热更新指南

本文档记录 Windows 客户端全量安装包编译、NSIS LZMA 增量更新包制作，以及基于 Gitee Release 的国内直连在线自动更新完整链路。

---

## 1. 全量包与增量包双轨设计

由于客户端内置了完整的离线 Python 3.12 短剧运行时（`huanggua-studio.zip`）与离线 3D 导演台（`director-desk.tar.gz`），Windows 全量安装包体积约为 `400+ MiB`，超过 Gitee 普通 Release 单附件 `100 MiB` 上限。为此采用**全量首发 + 增量热更**双轨方案：

1. **全量安装包（`黄瓜 AI 画布_<version>_x64-setup.exe`）**
   - 适用于新用户首次安装或大底座升级（当离线运行时自身发生变化时更新基线）。
   - 编译产物归档至同级目录 `../AI-Canvas-tauri-release/<version>-windows-x64/`，可通过网盘、官网或 GitHub Releases 分发。
2. **签名增量更新包（`HuangGuaAI-<version>-windows-x64-update.exe`）**
   - 由 `scripts/build-incremental-update.py` 基于当前全量包与基线版本对比生成。
   - 当 `huanggua-studio.zip` 与 `director-desk.tar.gz` 未变化时，增量安装器直接校验并复用用户本机已安装资源，仅写入新版主程序 `HuangGuaAI.exe`、前端资源与变更文件。
   - 采用 NSIS `/SOLID lzma` 固实压缩，包体约 `40 MiB`，可直接托管于 Gitee Release 附件并由客户端内置更新器高速拉取。

---

## 2. 基线连续性校验（`huangguaDelta`）

`latest.json` 除了标准 Tauri Updater 字段（`version`、`notes`、`pub_date`、`platforms.windows-x86_64.{url, signature}`）外，额外维护 `huangguaDelta` 元数据：

- `baseVersion`：当前增量链所依赖的全量基线版本号（例如 `0.11.7`）。
- `baseSha256`：基线大体积资源集合的顺序无关规范化摘要（由 `canonical_id()` 计算）。
- `carriedResources`：自基线以来发生过变更、必须随增量包一并携带的资源列表（一旦某资源在中间版本变更过，后续增量包会持续携带它，确保从基线之后任意中间版本升级均不会缺失文件）。

> [!IMPORTANT]
> 发布首个全量基线版本（如 `v0.11.7`）时，即使全量包由外部渠道分发，也必须向 Gitee 仓库提交一次该基线版本的 `latest.json`（`--manifest-only`），使后续版本（`v0.11.8+`）构建增量包时能够读取并验证同一条基线链。

---

## 3. 标准构建与发布流程

### 3.1 同步版本号

修改 `package.json` 中的 `version` 后运行：

```bash
npm run sync-version
```

确认 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 版本号一致。

### 3.2 编译签名版全量安装包

预先准备环境变量（切勿硬编码或写入仓库）：
- `TAURI_SIGNING_PRIVATE_KEY`：Minisign 私钥内容（或从本地受控密钥文件读取注入进程环境）。
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：私钥密码；**注意在 Windows PowerShell 中直接赋空字符串可能删除环境变量**，无密码私钥应在构建封装脚本中显式向子进程 `env` 传入 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""` 并在调用 `tauri.js signer sign` 时显式传 `-p ""`，避免命令行阻塞等待交互输入。

执行发布预检与构建：

```bash
npm run release:pack
npm run release:preflight
npm run tauri build
```

Windows 平台构建时，Tauri 会自动合并 `src-tauri/tauri.conf.json` 与 `src-tauri/tauri.windows.conf.json`（自动执行 `scripts/prepare-windows-runtime.ps1` 并打包 VC++ 运行时 DLL）。

### 3.3 生成签名增量更新包

```bash
python scripts/build-incremental-update.py \
  --installer-script src-tauri/target/release/nsis/x64/installer.nsi \
  --full-installer "src-tauri/target/release/bundle/nsis/黄瓜 AI 画布_<version>_x64-setup.exe" \
  --out "src-tauri/target/release/bundle/gitee-update-<version>"
```

输出目录包含：
- `HuangGuaAI-<version>-windows-x64-update.exe`
- `HuangGuaAI-<version>-windows-x64-update.exe.sig`
- `latest.json`

### 3.4 发布到 Gitee 在线更新通道

客户端更新检查端点固定配置在 `src-tauri/tauri.conf.json`：
- `https://gitee.com/xiang834740239/huanggua-aiagent/raw/master/latest.json`
- `https://gitee.com/xiang834740239/huanggua-aiagent/raw/main/latest.json`

通过 `GITEE_TOKEN` 环境变量（或工作区外受控的本地 `.secrets` 令牌文件）执行自动发布：

```bash
python scripts/publish-gitee-update.py \
  --dir "src-tauri/target/release/bundle/gitee-update-<version>"
```

**关键实现细节（`scripts/publish-gitee-update.py`）**：
- 使用官方 Gitee OpenAPI v5 创建或复用 `v<version>` Release，清理同名旧附件后重新上传。
- Gitee 附件上传接口对客户端连接较敏感：脚本内部使用临时配置文件调用 `curl --config`（`http1.1`、`max-time = 2400`、令牌不出现在进程命令行参数中），拿到返回的真实 `browser_download_url` 回写进 `latest.json` 后，再原子更新默认分支上的 `latest.json`。

### 3.5 导出本地归档并清理历史旧 `.exe`

```bash
npm run release:export
```

`scripts/export-local-release.py` 会将最新全量安装包、签名文件及增量通道产物统一复制到 `../AI-Canvas-tauri-release/<version>-windows-x64/` 并生成 `SHA256SUMS.txt`，同时自动删除旧版本的历史 `.exe` / `.sig` 产物（严格保留 `runtime-*` 备份目录不动）。
