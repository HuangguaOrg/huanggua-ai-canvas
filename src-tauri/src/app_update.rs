//! 更新资源仅来自 updater 的原生资源表；下载可切源，验签及安装仍由原更新器完成。
use std::{sync::Mutex, time::{Duration, Instant}};
use tauri::{ipc::Channel, Manager, Webview};
use tauri_plugin_updater::Update;

#[derive(Clone, Copy, PartialEq)]
enum ProgressMode { Standard, #[cfg(target_os = "macos")] Silent, #[cfg(target_os = "macos")] Part }

static UPDATING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn download(update: &Update, events: &Channel<serde_json::Value>, progress: ProgressMode) -> Result<Vec<u8>, crate::github_fallback::Failure> {
    use crate::github_fallback::{policy, Failure};
    let last_chunk = Mutex::new((Instant::now(), false));
    let mut started = false;
    let request = update.download(|chunk, total| {
        if let Ok(mut last) = last_chunk.lock() { *last = (Instant::now(), true); }
        if !started && progress == ProgressMode::Standard {
            started = true;
            let _ = events.send(serde_json::json!({ "event": "Started", "data": { "contentLength": total } }));
        }
        #[cfg(target_os = "macos")]
        if progress == ProgressMode::Silent { return; }
        let _ = events.send(serde_json::json!({ "event": "Progress", "data": { "chunkLength": chunk } }));
    }, || {});
    tokio::pin!(request);
    loop {
        tokio::select! {
            result = &mut request => return result.map_err(|error| match error {
                tauri_plugin_updater::Error::Reqwest(error) => Failure {
                    retryable: error.is_timeout() || error.is_connect() || error.is_body(),
                    message: "更新包连接或读取失败".into(),
                },
                tauri_plugin_updater::Error::Network(message) => {
                    let status = message.strip_prefix("Download request failed with status: ")
                        .and_then(|value| value.split_whitespace().next()).and_then(|value| value.parse::<u16>().ok());
                    Failure { message: "更新包下载请求失败".into(), retryable: status.is_some_and(crate::github_fallback::transient_status) }
                }
                other => Failure::terminal(format!("更新下载或签名校验失败：{other}")),
            }),
            _ = tokio::time::sleep(Duration::from_millis(250)) => {
                let state = last_chunk.lock().map_err(|_| Failure::terminal("更新计时器不可用"))?;
                let timeout = if state.1 { policy().read_timeout_ms } else { policy().connect_timeout_ms };
                if state.0.elapsed() >= Duration::from_millis(timeout) {
                    return Err(Failure { message: "更新包连接或读取超时".into(), retryable: true });
                }
            }
        }
    }
}

#[cfg(target_os = "macos")]
async fn download_multipart(update: &Update, events: &Channel<serde_json::Value>) -> Result<Vec<u8>, String> {
    use crate::app_update_multipart::{descriptor_url, Manifest};
    let target = format!("darwin-{}", std::env::consts::ARCH);
    if update.download_url != descriptor_url(&update.version, &target)? {
        return Err("更新清单不属于当前官方发布通道".into());
    }
    // The descriptor and every part are independently verified with the updater's pinned public key.
    let descriptor = download(update, events, ProgressMode::Silent).await.map_err(|error| error.message)?;
    let manifest = Manifest::parse(&descriptor, &update.version, &target)?;
    let mut archive = Vec::new();
    archive.try_reserve_exact(manifest.total_bytes).map_err(|_| "更新包所需内存不足")?;
    let _ = events.send(serde_json::json!({ "event": "Started", "data": { "contentLength": manifest.total_bytes } }));
    for (index, part) in manifest.parts.iter().enumerate() {
        let mut request = update.clone();
        request.download_url = part.url.parse().map_err(|_| "更新分片地址无效")?;
        request.signature = part.signature.clone();
        let bytes = download(&request, events, ProgressMode::Part).await.map_err(|error| error.message)?;
        manifest.append_part(&mut archive, index, &bytes)?;
    }
    // The signed descriptor binds the order, sizes and complete archive hash.
    manifest.verify_archive(&archive)?;
    Ok(archive)
}

#[tauri::command]
pub async fn download_app_update(webview: Webview, rid: tauri::ResourceId, on_event: Channel<serde_json::Value>) -> Result<(), String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    if webview.label() != "main" { return Err("仅主窗口可安装应用更新".into()); }
    let _lease = UPDATING.try_lock().map_err(|_| "已有更新正在下载或安装".to_string())?;
    let resource = webview.resources_table().get::<Update>(rid).map_err(|_| "更新资源已失效，请重新检查更新".to_string())?;
    let mut update = (*resource).clone();
    // check() 的超时也会进入 Update；大包按无进度时长超时，不设整包下载时长限制。
    update.timeout = None;
    // Only the configured Huanggua release channel, no third-party proxy fallback.
    #[cfg(target_os = "macos")]
    let bytes = if update.download_url.path().ends_with(".update.json") {
        download_multipart(&update, &on_event).await?
    } else {
        download(&update, &on_event, ProgressMode::Standard).await.map_err(|error| error.message)?
    };
    #[cfg(not(target_os = "macos"))]
    let bytes = download(&update, &on_event, ProgressMode::Standard).await.map_err(|error| error.message)?;
    // download() 返回前已经验签；校验失败不能切源，安装永远只执行一次。
    let _ = on_event.send(serde_json::json!({ "event": "Finished" }));
    let app = webview.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || crate::studio_runtime::shutdown_for_update(&app))
        .await.map_err(|_| "短剧运行时退出失败，已取消更新安装".to_string())??;
    // updater 在 Windows 直接退出进程，不执行 WorkerSession::drop；安装前必须确认同 exe 的 worker 已退出。
    // guard 在 install 失败时恢复接新任务，成功硬退出时由 OS 关闭非继承的 Job 句柄兜底。
    #[cfg(all(windows, feature = "local-onnx"))]
    let _worker_shutdown_guard = tauri::async_runtime::spawn_blocking(
        crate::onnx::prepare_update_worker_shutdown,
    )
    .await
    .map_err(|_| "本地推理进程退出准备失败，未启动更新安装".to_string())??;
    update.install(bytes).map_err(|error| format!("更新安装失败：{error}"))
}
