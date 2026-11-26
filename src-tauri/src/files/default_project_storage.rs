//! Automatic local storage, shared by the frontend and native media commands.
use std::{fs, io::Write, path::{Path, PathBuf}, sync::Mutex};
use tauri::{Manager, Runtime, Webview};
use tauri_plugin_fs::FsExt;

#[derive(Default)]
pub struct DefaultProjectStorage(Mutex<Option<PathBuf>>);

fn has_contents(path: &Path) -> Result<bool, String> {
    match fs::read_dir(path) {
        Ok(mut entries) => entries.next().transpose().map(|entry| entry.is_some())
            .map_err(|_| "无法读取已有项目目录".into()),
        Err(error) if matches!(error.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => Ok(false),
        Err(_) => Err("无法读取已有项目目录".into()),
    }
}

fn prepare_directory(path: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(path).map_err(|_| "无法创建项目存储目录")?;
    crate::path_policy::ensure_plain_skill_directory_chain(path).map_err(|_| "项目存储目录不可访问")?;
    let path = crate::path_policy::canonicalize_simplified(path)
        .map_err(|_| "无法解析项目存储目录")?;
    Ok(path)
}

fn prepare_writable_directory(path: &Path) -> Result<PathBuf, String> {
    let path = prepare_directory(path)?;
    let name = crate::comfyui::media_source::new_id()?;
    let probe = path.join(format!(".storage-probe-{name}"));
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&probe)
        .map_err(|_| "项目存储目录不可写")?;
    let result = file.write_all(b"local storage").and_then(|_| file.sync_all());
    drop(file);
    let cleanup = fs::remove_file(&probe);
    result.and(cleanup).map_err(|_| "项目存储目录不可写")?;
    Ok(path)
}

fn select_directory(legacy: &Path, installed: Option<&Path>) -> Result<PathBuf, String> {
    // Never hide old projects by switching their root during an upgrade.
    if has_contents(legacy)? { return prepare_directory(legacy); }
    if let Some(installed) = installed {
        // Once populated, retain this root even if a later permission problem occurs.
        if has_contents(installed)? { return prepare_directory(installed); }
        if let Ok(path) = prepare_writable_directory(installed) { return Ok(path); }
    }
    prepare_writable_directory(legacy)
}

fn installation_data_dir(executable: &Path) -> Option<PathBuf> {
    // Keep user files outside the signed macOS application bundle.
    #[cfg(target_os = "macos")]
    if let Some(bundle) = executable.ancestors().find(|path| path.extension().is_some_and(|ext| ext == "app")) {
        return bundle.parent().map(|parent| parent.join("HuangGuaAI-data"));
    }
    executable.parent().map(|parent| parent.join("data"))
}

pub fn default_project_data_root<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let state = app.state::<DefaultProjectStorage>();
    let mut cached = state.0.lock().map_err(|_| "项目存储初始化失败")?;
    if let Some(path) = cached.as_ref() { return Ok(path.clone()); }
    let legacy = app.path().app_data_dir().map_err(|_| "无法定位项目存储目录")?.join("data");
    let installed = std::env::current_exe().ok().and_then(|exe| installation_data_dir(&exe));
    let path = select_directory(&legacy, installed.as_deref())?;
    // Grant only the chosen data directory, never the whole installation directory.
    app.fs_scope().allow_directory(&path, true).map_err(|_| "无法准备项目文件访问")?;
    app.state::<tauri::scope::Scopes>().allow_directory(&path, true).map_err(|_| "无法准备项目素材访问")?;
    *cached = Some(path.clone());
    Ok(path)
}

#[tauri::command]
pub fn get_default_project_data_root<R: Runtime>(webview: Webview<R>) -> Result<String, String> {
    crate::path_policy::ensure_local_frontend_caller(&webview)?;
    default_project_data_root(webview.app_handle())?.to_str().map(str::to_owned)
        .ok_or_else(|| "无法解析项目存储目录".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_storage_prefers_installation_and_preserves_old_projects() {
        let root = std::env::temp_dir().join(format!("canvas-storage-{}", crate::comfyui::media_source::new_id().unwrap()));
        let legacy = root.join("legacy"); let installed = root.join("installed");
        let selected = select_directory(&legacy, Some(&installed)).unwrap();
        assert_eq!(selected, crate::path_policy::canonicalize_simplified(&installed).unwrap());
        assert_eq!(fs::read_dir(&installed).unwrap().count(), 0);
        fs::create_dir_all(legacy.join("existing-project")).unwrap();
        assert_eq!(select_directory(&legacy, Some(&installed)).unwrap(), crate::path_policy::canonicalize_simplified(&legacy).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unavailable_installation_parent_falls_back_without_user_configuration() {
        let root = std::env::temp_dir().join(format!("canvas-storage-{}", crate::comfyui::media_source::new_id().unwrap()));
        fs::create_dir_all(&root).unwrap();
        let parent = root.join("not-a-directory"); fs::write(&parent, b"preserve").unwrap();
        let legacy = root.join("legacy");
        assert_eq!(select_directory(&legacy, Some(&parent.join("data"))).unwrap(), crate::path_policy::canonicalize_simplified(&legacy).unwrap());
        assert_eq!(fs::read(parent).unwrap(), b"preserve");
        fs::remove_dir_all(root).unwrap();
    }
}
