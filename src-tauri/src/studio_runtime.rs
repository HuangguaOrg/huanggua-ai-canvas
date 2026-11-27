//! HuangGuaAI local studio service. Renderer cannot select an executable, URL or argv.
use std::{collections::{BTreeMap, HashSet}, fs::{self, File}, io::{BufRead, BufReader, BufWriter, Read, Write}, path::{Path, PathBuf}, process::{Command, Stdio}, sync::{mpsc, Mutex, Arc, atomic::{AtomicBool, Ordering}}, time::Duration};
use tauri::{Manager, Runtime, Webview};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

// The installer ships one verified archive instead of ~13k loose files; it is
// unpacked on first use into an app-private directory that Renderer path
// commands cannot reach (see path_policy::is_private_app_path).
const BUNDLE_SIDECAR: &str = "huanggua-studio.json";
const BUNDLE_ARCHIVE: &str = "huanggua-studio.zip";
const RUNTIME_DIRECTORY: &str = "huanggua-studio-runtime";
const COMPLETE_MARKER: &str = ".huanggua-runtime-complete";
#[cfg(windows)]
const EXPECTED_PLATFORM: &str = "windows-x86_64";
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const EXPECTED_PLATFORM: &str = "darwin-aarch64";
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const EXPECTED_PLATFORM: &str = "darwin-x86_64";
#[cfg(not(any(windows, target_os = "macos")))]
const EXPECTED_PLATFORM: &str = "linux-x86_64";

#[cfg(windows)]
const REQUIRED_FILES: &[&str] = &["manifest.json", "engine/server/app.py", "python/python.exe", "git/usr/bin/bash.exe"];
#[cfg(not(windows))]
const REQUIRED_FILES: &[&str] = &["manifest.json", "engine/server/app.py", "python/bin/python3"];
const MAX_ARCHIVE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_RUNTIME_FILES: usize = 150_000;
const MAX_MANIFEST_BYTES: u64 = 32 * 1024 * 1024;
const MAX_SIDECAR_BYTES: u64 = 64 * 1024;
const FREE_SPACE_RESERVE: u64 = 256 * 1024 * 1024;
static PREPARING: Mutex<()> = Mutex::new(());

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundleSidecar { schema_version: u32, archive: String, sha256: String, size: u64, manifest_sha256: String, files: usize, expanded_bytes: u64 }

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeManifest { schema_version: u32, platform: String, files: BTreeMap<String, String> }

fn is_sha256(value: &str) -> bool { value.len() == 64 && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) }

/// Archive entry names must be plain relative paths; mirrors restore-desktop-runtime.py.
fn valid_entry_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 400 && !name.starts_with('/')
        && !name.chars().any(|c| c == '\\' || c == ':' || c.is_control())
        && name.split('/').all(|part| !part.is_empty() && part != "." && part != ".." && !part.ends_with('.') && !part.ends_with(' '))
}

/// Compile-time binding: the signed executable only trusts the archive it was built with.
fn expected_digests() -> Option<(&'static str, &'static str)> {
    match (option_env!("HUANGGUA_STUDIO_ARCHIVE_SHA256"), option_env!("HUANGGUA_STUDIO_MANIFEST_SHA256")) {
        (Some(archive), Some(manifest)) if is_sha256(archive) && is_sha256(manifest) => Some((archive, manifest)),
        _ => None,
    }
}

fn runtime_root<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    app.path().app_local_data_dir().map(|directory| directory.join(RUNTIME_DIRECTORY)).map_err(|_| "studio_storage_unavailable".into())
}

fn normalized(path: &Path) -> PathBuf {
    path.canonicalize().map(crate::path_policy::simplify_verbatim).unwrap_or_else(|_| path.components().collect())
}

pub(crate) fn is_private_path<R: Runtime>(app: &tauri::AppHandle<R>, path: &Path) -> bool {
    runtime_root(app).map(|root| normalized(path).starts_with(normalized(&root))).unwrap_or(false)
}

pub(crate) fn overlaps_private_path<R: Runtime>(app: &tauri::AppHandle<R>, path: &Path) -> bool {
    runtime_root(app).map(|root| {
        let (private, target) = (normalized(&root), normalized(path));
        target.starts_with(&private) || private.starts_with(&target)
    }).unwrap_or(false)
}

fn read_sidecar(path: &Path) -> Result<BundleSidecar, String> {
    let file = File::open(path).map_err(|_| "studio_runtime_not_packaged")?;
    let mut text = String::new();
    file.take(MAX_SIDECAR_BYTES + 1).read_to_string(&mut text).map_err(|_| "studio_runtime_damaged")?;
    if text.len() as u64 > MAX_SIDECAR_BYTES { return Err("studio_runtime_damaged".into()); }
    let sidecar: BundleSidecar = serde_json::from_str(&text).map_err(|_| "studio_runtime_damaged")?;
    if sidecar.schema_version != 1 || sidecar.archive != BUNDLE_ARCHIVE || !is_sha256(&sidecar.sha256) || !is_sha256(&sidecar.manifest_sha256)
        || sidecar.size == 0 || sidecar.size > MAX_ARCHIVE_BYTES || sidecar.files == 0 || sidecar.files > MAX_RUNTIME_FILES
        || sidecar.expanded_bytes > MAX_EXPANDED_BYTES {
        return Err("studio_runtime_damaged".into());
    }
    Ok(sidecar)
}

fn is_prepared(directory: &Path, archive_sha: &str) -> bool {
    fs::read_to_string(directory.join(COMPLETE_MARKER)).is_ok_and(|marker| marker.trim() == archive_sha)
        && REQUIRED_FILES.iter().all(|name| directory.join(name).is_file())
}

fn entry_path(root: &Path, name: &str) -> PathBuf {
    let mut path = root.to_path_buf();
    for part in name.split('/') { path.push(part); }
    path
}

fn read_manifest(archive: &mut zip::ZipArchive<BufReader<File>>, manifest_sha: &str) -> Result<(Vec<u8>, RuntimeManifest), String> {
    let mut entry = archive.by_name("manifest.json").map_err(|_| "studio_runtime_damaged")?;
    if entry.size() > MAX_MANIFEST_BYTES { return Err("studio_runtime_damaged".into()); }
    let mut bytes = Vec::new();
    (&mut entry).take(MAX_MANIFEST_BYTES + 1).read_to_end(&mut bytes).map_err(|_| "studio_runtime_damaged")?;
    if format!("{:x}", Sha256::digest(&bytes)) != manifest_sha { return Err("studio_runtime_damaged".into()); }
    let manifest: RuntimeManifest = serde_json::from_slice(&bytes).map_err(|_| "studio_runtime_damaged")?;
    let mut names = HashSet::new();
    if manifest.schema_version != 1 || manifest.platform != EXPECTED_PLATFORM || manifest.files.is_empty() || manifest.files.len() > MAX_RUNTIME_FILES
        || manifest.files.iter().any(|(name, hash)| !valid_entry_name(name) || name == "manifest.json" || !is_sha256(hash) || !names.insert(name.to_lowercase()))
        || REQUIRED_FILES[1..].iter().any(|name| !manifest.files.contains_key(*name)) {
        return Err("studio_runtime_damaged".into());
    }
    Ok((bytes, manifest))
}

#[cfg(unix)]
fn is_unix_executable_entry(name: &str, magic: &[u8]) -> bool {
    name.starts_with("python/bin/")
        || name.contains("/_bundled/claude")
        || name.contains("/binaries/ffmpeg")
        || name.ends_with(".dylib")
        || name.ends_with(".so")
        || magic.starts_with(b"#!")
        || matches!(
            magic,
            [0xcf, 0xfa, 0xed, 0xfe]
                | [0xce, 0xfa, 0xed, 0xfe]
                | [0xfe, 0xed, 0xfa, 0xcf]
                | [0xfe, 0xed, 0xfa, 0xce]
                | [0xca, 0xfe, 0xba, 0xbe]
        )
}

fn extract_worker(archive_path: &Path, staging: &Path, files: &BTreeMap<String, String>, indices: &[usize], worker: usize, workers: usize, failed: &AtomicBool) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(BufReader::new(File::open(archive_path).map_err(|_| "studio_runtime_not_packaged")?)).map_err(|_| "studio_runtime_damaged")?;
    let mut buffer = vec![0_u8; 256 * 1024];
    for index in indices.iter().skip(worker).step_by(workers) {
        if failed.load(Ordering::Acquire) { return Ok(()); }
        let mut entry = archive.by_index(*index).map_err(|_| "studio_runtime_damaged")?;
        let name = entry.name().to_string();
        let expected = files.get(&name).ok_or("studio_runtime_damaged")?;
        let declared = entry.size();
        let destination = entry_path(staging, &name);
        if let Some(parent) = destination.parent() { fs::create_dir_all(parent).map_err(|_| "studio_runtime_prepare_failed")?; }
        let output = fs::OpenOptions::new().write(true).create_new(true).open(&destination).map_err(|_| "studio_runtime_prepare_failed")?;
        let mut writer = BufWriter::with_capacity(256 * 1024, output);
        let mut hasher = Sha256::new();
        let mut written = 0_u64;
        #[cfg(unix)]
        let mut magic = Vec::with_capacity(4);
        let mut limited = (&mut entry).take(declared + 1);
        loop {
            let read = limited.read(&mut buffer).map_err(|_| "studio_runtime_damaged")?;
            if read == 0 { break; }
            #[cfg(unix)]
            if magic.len() < 4 {
                let need = (4 - magic.len()).min(read);
                magic.extend_from_slice(&buffer[..need]);
            }
            written += read as u64;
            if written > declared { return Err("studio_runtime_damaged".into()); }
            hasher.update(&buffer[..read]);
            writer.write_all(&buffer[..read]).map_err(|_| "studio_runtime_prepare_failed")?;
        }
        writer.flush().map_err(|_| "studio_runtime_prepare_failed")?;
        if written != declared || format!("{:x}", hasher.finalize()) != *expected { return Err("studio_runtime_damaged".into()); }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if is_unix_executable_entry(&name, &magic) {
                fs::set_permissions(&destination, fs::Permissions::from_mode(0o755)).map_err(|_| "studio_runtime_prepare_failed")?;
            }
        }
    }
    Ok(())
}

fn extract(archive_path: &Path, sidecar: &BundleSidecar, manifest_sha: &str, staging: &Path) -> Result<(), String> {
    let file = File::open(archive_path).map_err(|_| "studio_runtime_not_packaged")?;
    if file.metadata().map_err(|_| "studio_runtime_damaged")?.len() != sidecar.size { return Err("studio_runtime_damaged".into()); }
    let mut archive = zip::ZipArchive::new(BufReader::new(file)).map_err(|_| "studio_runtime_damaged")?;
    if archive.len() > MAX_RUNTIME_FILES + 1 { return Err("studio_runtime_damaged".into()); }
    let (manifest_bytes, manifest) = read_manifest(&mut archive, manifest_sha)?;
    let mut indices = Vec::with_capacity(manifest.files.len());
    let mut seen = HashSet::new();
    let mut expanded = 0_u64;
    for index in 0..archive.len() {
        let entry = archive.by_index_raw(index).map_err(|_| "studio_runtime_damaged")?;
        let name = entry.name();
        if name == "manifest.json" { continue; }
        if entry.is_dir() || !valid_entry_name(name) || !manifest.files.contains_key(name) || !seen.insert(name.to_lowercase()) {
            return Err("studio_runtime_damaged".into());
        }
        expanded = expanded.saturating_add(entry.size());
        if expanded > MAX_EXPANDED_BYTES { return Err("studio_runtime_damaged".into()); }
        indices.push(index);
    }
    if indices.len() != manifest.files.len() { return Err("studio_runtime_damaged".into()); }
    // Per-file writes (and antivirus scans) dominate; a few workers overlap them.
    let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(2, 8);
    let failed = AtomicBool::new(false);
    let results = std::thread::scope(|scope| {
        let handles = (0..workers).map(|worker| {
            let (files, indices, failed) = (&manifest.files, &indices, &failed);
            scope.spawn(move || {
                let result = extract_worker(archive_path, staging, files, indices, worker, workers, failed);
                if result.is_err() { failed.store(true, Ordering::Release); }
                result
            })
        }).collect::<Vec<_>>();
        handles.into_iter().map(|handle| handle.join().unwrap_or_else(|_| Err("studio_runtime_prepare_failed".into()))).collect::<Vec<_>>()
    });
    if let Some(error) = results.into_iter().find_map(Result::err) { return Err(error); }
    fs::write(staging.join("manifest.json"), manifest_bytes).map_err(|_| "studio_runtime_prepare_failed")?;
    Ok(())
}

fn rename_with_retry(source: &Path, destination: &Path) -> Result<(), String> {
    for attempt in 0..8 {
        if fs::rename(source, destination).is_ok() { return Ok(()); }
        std::thread::sleep(Duration::from_millis(100 * (attempt + 1)));
    }
    Err("studio_runtime_prepare_failed".into())
}

/// Returns the verified runtime directory, unpacking the bundled archive on first use.
pub fn prepare_runtime<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let (archive_sha, manifest_sha) = expected_digests().ok_or("studio_runtime_not_packaged")?;
    let resources = app.path().resource_dir().map_err(|_| "studio_runtime_not_packaged")?;
    let sidecar = read_sidecar(&resources.join(BUNDLE_SIDECAR))?;
    if sidecar.sha256 != archive_sha || sidecar.manifest_sha256 != manifest_sha { return Err("studio_runtime_damaged".into()); }
    let root = runtime_root(app)?;
    let target = root.join(&archive_sha[..16]);
    let _guard = PREPARING.lock().map_err(|_| "studio_runtime_prepare_failed")?;
    if is_prepared(&target, archive_sha) { return Ok(target); }
    fs::create_dir_all(&root).map_err(|_| "studio_storage_unavailable")?;
    let metadata = fs::symlink_metadata(&root).map_err(|_| "studio_storage_unavailable")?;
    if !metadata.is_dir() || crate::path_policy::is_link_or_reparse(&metadata) { return Err("studio_storage_unavailable".into()); }
    let available = fs2::available_space(&root).map_err(|_| "studio_storage_unavailable")?;
    if available < sidecar.expanded_bytes.saturating_add(FREE_SPACE_RESERVE) { return Err("studio_runtime_disk_full".into()); }
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(".staging-") { let _ = fs::remove_dir_all(entry.path()); }
        }
    }
    let suffix = crate::secure_random::random_bytes::<8>().map_err(|_| "studio_random_failed")?.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let staging = root.join(format!(".staging-{suffix}"));
    fs::create_dir(&staging).map_err(|_| "studio_runtime_prepare_failed")?;
    let result = extract(&resources.join(BUNDLE_ARCHIVE), &sidecar, manifest_sha, &staging)
        .and_then(|_| fs::write(staging.join(COMPLETE_MARKER), archive_sha).map_err(|_| "studio_runtime_prepare_failed".to_string()))
        .and_then(|_| {
            if target.exists() { fs::remove_dir_all(&target).map_err(|_| "studio_runtime_prepare_failed".to_string())?; }
            rename_with_retry(&staging, &target)
        });
    if let Err(error) = result { let _ = fs::remove_dir_all(&staging); return Err(error); }
    // Older runtime versions are no longer referenced by this executable.
    let (root, current) = (root.clone(), target.file_name().map(|name| name.to_os_string()));
    std::thread::spawn(move || {
        for entry in fs::read_dir(&root).into_iter().flatten().flatten() {
            let name = entry.file_name();
            if Some(&name) != current.as_ref() && !name.to_string_lossy().starts_with('.') && entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    });
    Ok(target)
}

/// Unpacks in the background after launch so the studio is usually ready when opened.
pub fn prepare_in_background(app: &tauri::AppHandle) {
    if cfg!(debug_assertions) { return; }
    let app = app.clone();
    std::thread::spawn(move || { let _ = prepare_runtime(&app); });
}

#[derive(Clone)]
struct Connection { port: u16, token: String, stop: mpsc::Sender<()>, stopped: Arc<AtomicBool> }
#[derive(Default)]
pub struct StudioRuntime(Mutex<Option<Connection>>);
fn caller(webview: &Webview) -> Result<(), String> {
    if webview.label() != "main" { return Err("studio_main_window_required".into()); }
    crate::path_policy::ensure_local_frontend_caller(webview)
}
pub fn shutdown(app: &tauri::AppHandle) {
    if let Some(connection) = app.state::<StudioRuntime>().0.lock().unwrap().take() { let _ = connection.stop.send(()); }
}
pub fn shutdown_for_update(app: &tauri::AppHandle) -> Result<(), String> {
    let connection = app.state::<StudioRuntime>().0.lock().map_err(|_| "studio_runtime_failed")?.take();
    if let Some(connection) = connection {
        let _ = connection.stop.send(());
        for _ in 0..100 {
            if connection.stopped.load(Ordering::Acquire) { return Ok(()); }
            std::thread::sleep(Duration::from_millis(50));
        }
        return Err("短剧运行时未及时退出，已取消更新安装".into());
    }
    Ok(())
}
fn start(app: &tauri::AppHandle) -> Result<Connection, String> {
    // Release paths are fixed inside the signed installer; never accept renderer
    // input or development environment overrides for executable selection.
    #[cfg(windows)]
    const DEFAULT_PYTHON_REL: &str = "python/python.exe";
    #[cfg(not(windows))]
    const DEFAULT_PYTHON_REL: &str = "python/bin/python3";

    let (root, python, bash) = if cfg!(debug_assertions) {
        let staged = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/huanggua-studio");
        let root = std::env::var("HUANGGUA_STUDIO_ENGINE").map(std::path::PathBuf::from).unwrap_or_else(|_| staged.join("engine"));
        let python = std::env::var("HUANGGUA_STUDIO_PYTHON").map(std::path::PathBuf::from).unwrap_or_else(|_| staged.join(DEFAULT_PYTHON_REL));
        let bash = std::env::var("CLAUDE_CODE_GIT_BASH_PATH").ok().map(std::path::PathBuf::from).or_else(|| {
            let candidate = staged.join("git/usr/bin/bash.exe");
            candidate.is_file().then_some(candidate)
        });
        if !root.join("server/app.py").is_file() || !python.is_file() {
            return Err("studio_runtime_not_installed".into());
        }
        (root, python, bash)
    } else {
        let bundle = prepare_runtime(app)?;
        let root = bundle.join("engine");
        let python = bundle.join(DEFAULT_PYTHON_REL);
        #[cfg(windows)]
        let bash = {
            let b = bundle.join("git/usr/bin/bash.exe");
            if !b.is_file() {
                return Err("studio_runtime_not_packaged".into());
            }
            Some(b)
        };
        #[cfg(not(windows))]
        let bash: Option<PathBuf> = None;
        if !root.join("server/app.py").is_file() || !python.is_file() || !bundle.join("manifest.json").is_file() {
            return Err("studio_runtime_not_packaged".into());
        }
        (root, python, bash)
    };
    let session = crate::secret_store::read_internal_secret_sync(app, "huanggua/session")
        .map_err(|_| "studio_login_required")?.filter(|s| !s.is_empty()).ok_or("studio_login_required")?;
    let data = crate::secret_store::secret_dir(app)?.join("studio-runtime");
    std::fs::create_dir_all(&data).map_err(|_| "studio_storage_unavailable")?;
    let script = data.join("desktop_bridge.py");
    for (name, embedded) in [
        ("shot_media.py", include_str!("../../runtime/studio/shot_media.py")),
        ("media_staging.py", include_str!("../../runtime/studio/media_staging.py")),
        ("creative_profile.py", include_str!("../../runtime/studio/creative_profile.py")),
        ("original_story.md", include_str!("../../runtime/studio/original_story.md")),
        ("write_original_story.md", include_str!("../../runtime/studio/write_original_story.md")),
        ("workspace_api.py", include_str!("../../runtime/studio/workspace_api.py")),
        ("project_scope.py", include_str!("../../runtime/studio/project_scope.py")),
        ("legacy_merge.py", include_str!("../../runtime/studio/legacy_merge.py")),
        ("conversation_api.py", include_str!("../../runtime/studio/conversation_api.py")),
        ("desktop_bridge.py", include_str!("../../runtime/studio/desktop_bridge.py")),
        ("text_gateway.py", include_str!("../../runtime/studio/text_gateway.py")),
        ("windows_compat.py", include_str!("../../runtime/studio/windows_compat.py")),
        ("account_worker.py", include_str!("../../runtime/studio/account_worker.py")),
        ("owned_services.py", include_str!("../../runtime/studio/owned_services.py")),
    ] {
        #[cfg(debug_assertions)]
        let content = std::fs::read_to_string(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../runtime/studio").join(name)).unwrap_or_else(|_| embedded.to_string());
        #[cfg(not(debug_assertions))]
        let content = embedded;
        std::fs::write(data.join(name), content).map_err(|_| "studio_storage_unavailable")?;
    }
    let token = crate::secure_random::random_bytes::<32>().map_err(|_| "studio_random_failed")?.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let mut runtime_path = Vec::new();
    if let Some(directory) = python.parent() {
        runtime_path.push(directory.to_path_buf());
        let scripts = directory.join("Scripts");
        if scripts.is_dir() { runtime_path.push(scripts); }
    }
    if let Some(bash) = &bash {
        // Non-login Bash does not add portable Git to PATH. Tools and Skills
        // must use the bundled executables even on a machine without Git/Python.
        if let Some(git) = bash.parent().and_then(|bin| bin.parent()).and_then(|usr| usr.parent()) {
            for relative in ["cmd", "ucrt64/bin", "mingw64/bin", "usr/bin"] {
                let directory = git.join(relative);
                if directory.is_dir() { runtime_path.push(directory); }
            }
        }
    }
    #[cfg(unix)]
    for sys_dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
        let p = PathBuf::from(sys_dir);
        if p.is_dir() { runtime_path.push(p); }
    }
    if let Some(inherited) = std::env::var_os("PATH") { runtime_path.extend(std::env::split_paths(&inherited)); }
    let mut command = Command::new(&python);
    command.env("PATH", std::env::join_paths(runtime_path).map_err(|_| "studio_runtime_path_invalid")?);
    command.args(["-B", "-s"]).arg(&script).current_dir(&root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    command.env("PYTHONDONTWRITEBYTECODE", "1").env_remove("PYTHONPATH").env_remove("PYTHONHOME");
    if let Some(bash) = bash { command.env("CLAUDE_CODE_GIT_BASH_PATH", bash); }
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let mut child = command.spawn().map_err(|_| "studio_start_failed")?;
    let (stop, receiver) = mpsc::channel();
    let (ready, result) = mpsc::channel();
    let stopped = Arc::new(AtomicBool::new(false));
    let thread_stopped = stopped.clone();
    let input = json!({"root":root,"data":data,"token":token,"session":session});
    std::thread::spawn(move || {
        #[cfg(windows)]
        let _job = match crate::process_job::ProcessJob::attach(&child) { Ok(job) => job, Err(_) => { let _=child.kill(); let _=child.wait(); let _=ready.send(Err("studio_containment_failed")); return; } };
        let init = (|| {
            let mut stdin = child.stdin.take().ok_or("studio_start_failed")?;
            writeln!(stdin, "{input}").map_err(|_| "studio_start_failed")?;
            let stdout = child.stdout.take().ok_or("studio_start_failed")?;
            // The supervisor must remain able to kill a stuck bootstrap process.
            let (line_ready, line_result) = mpsc::channel();
            std::thread::spawn(move || {
                let mut line = String::new();
                let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
                let _ = line_ready.send(result);
            });
            let line = line_result.recv_timeout(Duration::from_secs(25)).map_err(|_| "studio_start_timeout")?
                .map_err(|_| "studio_start_failed")?;
            serde_json::from_str::<Value>(&line).ok().and_then(|v| v["port"].as_u64()).filter(|p| *p > 0 && *p < 65536).map(|p| p as u16).ok_or("studio_start_failed")
        })();
        let failed = init.is_err(); let _ = ready.send(init);
        if !failed { loop { if !matches!(receiver.recv_timeout(Duration::from_millis(250)), Err(mpsc::RecvTimeoutError::Timeout)) || child.try_wait().ok().flatten().is_some() { break; } } }
        let _=child.kill(); let _=child.wait();
        #[cfg(windows)] { drop(_job); }
        thread_stopped.store(true, Ordering::Release);
    });
    let port = result.recv_timeout(Duration::from_secs(30)).map_err(|_| { let _=stop.send(()); "studio_start_timeout" })??;
    Ok(Connection {port, token, stop, stopped})
}
async fn connection(app: &tauri::AppHandle) -> Result<Connection, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<StudioRuntime>();
        let mut guard = state.0.lock().map_err(|_| "studio_runtime_failed")?;
        if guard.as_ref().is_none_or(|c| c.stopped.load(Ordering::Acquire)) {
            let c=start(&app)?;
            let http=reqwest::blocking::Client::builder().no_proxy().timeout(Duration::from_secs(1)).build().map_err(|_| "studio_start_failed")?;
            let mut ready=false;
            let deadline = std::time::Instant::now() + Duration::from_secs(180);
            while std::time::Instant::now() < deadline {
                // Authentication failure is enough to prove ASGI lifespan completed.
                if c.stopped.load(Ordering::Acquire) { return Err("studio_start_failed".into()); }
                if http.post(format!("http://127.0.0.1:{}/desktop/status",c.port)).send().is_ok_and(|response| response.status() == reqwest::StatusCode::FORBIDDEN) {ready=true;break;}
                std::thread::sleep(Duration::from_millis(500));
            }
            if !ready {let _=c.stop.send(());return Err("studio_start_timeout".into());}
            *guard=Some(c);
        }
        Ok(guard.as_ref().unwrap().clone())
    }).await.map_err(|_| "studio_runtime_failed")?
}
fn client() -> Result<reqwest::Client,String> {
    reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).build().map_err(|_| "studio_transport_failed".into())
}
#[tauri::command]
pub async fn studio_request(app: tauri::AppHandle, webview: Webview, operation: String, payload: Value) -> Result<Value,String> {
    caller(&webview)?;
    if operation == "shutdown" { shutdown(&app); return Ok(json!({"stopped":true})); }
    if !["status","run","poll","interrupt","answer","cancel_task","workspace"].contains(&operation.as_str()) { return Err("studio_operation_denied".into()); }
    if payload.to_string().len() > 1_000_000 { return Err("studio_request_too_large".into()); }
    let c=connection(&app).await?;
    let sent=client()?.post(format!("http://127.0.0.1:{}/desktop/{operation}",c.port)).bearer_auth(&c.token)
        .header("Content-Type","application/json").body(payload.to_string()).send().await;
    let mut response=match sent { Ok(response)=>response, Err(_)=>{ if operation=="status" {
        let state = app.state::<StudioRuntime>();
        let mut guard = state.0.lock().map_err(|_| "studio_runtime_failed")?;
        if guard.as_ref().is_some_and(|current| current.token == c.token) {
            if let Some(old) = guard.take() { let _ = old.stop.send(()); }
        }
    } return Err("studio_connection_lost".into()); } };
    let status=response.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "studio_connection_lost")? {
        if chunk.len() > 8 * 1024 * 1024 - bytes.len() { return Err("studio_response_too_large".into()); }
        bytes.extend_from_slice(&chunk);
    }
    let value:Value=serde_json::from_slice(&bytes).map_err(|_| "studio_invalid_response")?;
    if !status.is_success() { return Err(value["error"].as_str().filter(|s| s.starts_with("studio_") && s.len()<100).unwrap_or("studio_execution_failed").to_string()); }
    Ok(value)
}
#[tauri::command]
pub async fn studio_import_artifact(app: tauri::AppHandle, webview: Webview, project: String, artifact: String, directory: String) -> Result<String,String> {
    caller(&webview)?;
    if !project.bytes().all(|b| b.is_ascii_alphanumeric() || b==b'-') || project.len()>80 || artifact.len()!=64 || !artifact.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("studio_invalid_artifact".into()); }
    let directory=crate::path_policy::authorize_existing_plain_directory(&app,&directory)?;
    let c=connection(&app).await?;
    let mut response=client()?.get(format!("http://127.0.0.1:{}/desktop/artifact/{project}/{artifact}",c.port)).bearer_auth(&c.token).send().await.map_err(|_| "studio_import_failed")?;
    if !response.status().is_success() { return Err("studio_import_failed".into()); }
    let extension=response.headers().get("x-studio-extension").and_then(|v|v.to_str().ok()).filter(|v| ["png","jpg","jpeg","webp","mp4","mov","m4v","webm","wav","mp3","m4a","ogg","txt","md","json","zip","srt","vtt","pdf","docx","epub"].contains(v)).ok_or("studio_invalid_artifact")?.to_string();
    let path=directory.join(format!("HuangGuaAI-{artifact}.{extension}"));
    let path=crate::path_policy::authorize_path(&app,&path.to_string_lossy(),crate::path_policy::PathAccess::Write)?;
    use sha2::{Digest,Sha256};
    if path.exists() {
        let mut file=std::fs::File::open(&path).map_err(|_| "studio_import_failed")?;
        let mut hash=Sha256::new(); std::io::copy(&mut file,&mut hash).map_err(|_| "studio_import_failed")?;
        if format!("{:x}",hash.finalize())==artifact {return Ok(path.to_string_lossy().into());}
        return Err("studio_asset_conflict".into());
    }
    let random=crate::secure_random::random_bytes::<16>().map_err(|_| "studio_random_failed")?.iter().map(|b|format!("{b:02x}")).collect::<String>();
    let temporary=directory.join(format!(".studio-{random}.part"));
    let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|_| "studio_import_failed")?;
    let result=async {
        let mut size=0usize; let mut hash=Sha256::new();
        while let Some(chunk)=response.chunk().await.map_err(|_| "studio_import_failed")? {
            size+=chunk.len(); if size>1024*1024*1024 {return Err("studio_artifact_too_large");}
            hash.update(&chunk); file.write_all(&chunk).map_err(|_| "studio_import_failed")?;
        }
        file.sync_all().map_err(|_| "studio_import_failed")?;
        if size==0 || format!("{:x}",hash.finalize())!=artifact {return Err("studio_artifact_changed");}
        crate::path_policy::reauthorize_existing_plain_directory(&app,&directory).map_err(|_| "studio_import_failed")?;
        // Hard link publishes atomically without replacing another file.
        std::fs::hard_link(&temporary,&path).map_err(|_| "studio_import_failed")?;
        Ok(path.to_string_lossy().to_string())
    }.await;
    drop(file); let _=std::fs::remove_file(&temporary); result.map_err(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_plain_runtime_entry_names() {
        assert!(valid_entry_name("python/python.exe"));
        assert!(valid_entry_name("engine/server/app.py"));
        assert!(valid_entry_name("python/Lib/site-packages/numpy.libs/msvcp140-a4c2.dll"));
    }

    #[test]
    fn rejects_unsafe_runtime_entry_names() {
        for name in ["", "/outside", "../escape", "engine/../app.py", "engine/./app.py", "C:/drive", "engine\\app.py",
            "engine//app.py", "engine/file.", "engine/file ", "engine/\u{1}control"] {
            assert!(!valid_entry_name(name), "{name}");
        }
    }

    #[test]
    fn only_lowercase_hex_digests_are_trusted() {
        assert!(is_sha256(&"a".repeat(64)));
        assert!(!is_sha256(&"A".repeat(64)));
        assert!(!is_sha256(&"a".repeat(63)));
        assert!(!is_sha256(&"g".repeat(64)));
    }

    fn sha(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }

    fn scratch(label: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("huanggua-studio-test-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    /// Writes a fixture archive; `tamper` replaces the stored bytes of one file after the manifest is computed.
    fn fixture(directory: &Path, tamper: bool) -> (PathBuf, BundleSidecar, String) {
        #[cfg(windows)]
        let files: Vec<(&str, &[u8])> = vec![
            ("engine/server/app.py", b"print('app')"), ("python/python.exe", b"MZ fixture"),
            ("git/usr/bin/bash.exe", b"MZ bash"), ("engine/lib/data.json", b"{\"ok\":true}"),
        ];
        #[cfg(not(windows))]
        let files: Vec<(&str, &[u8])> = vec![
            ("engine/server/app.py", b"print('app')"), ("python/bin/python3", b"#!/bin/sh\n"),
            ("engine/lib/data.json", b"{\"ok\":true}"),
        ];
        let manifest = json!({ "schemaVersion": 1, "platform": EXPECTED_PLATFORM,
            "files": files.iter().map(|(name, bytes)| (name.to_string(), sha(bytes))).collect::<BTreeMap<_, _>>() });
        let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
        let archive_path = directory.join(BUNDLE_ARCHIVE);
        let mut writer = zip::ZipWriter::new(File::create(&archive_path).unwrap());
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        writer.start_file("manifest.json", options).unwrap();
        writer.write_all(&manifest_bytes).unwrap();
        for (index, (name, bytes)) in files.iter().enumerate() {
            writer.start_file(*name, options).unwrap();
            writer.write_all(if tamper && index == 3 { b"{\"ok\":fals}" } else { bytes }).unwrap();
        }
        writer.finish().unwrap();
        let sidecar = BundleSidecar { schema_version: 1, archive: BUNDLE_ARCHIVE.into(), sha256: sha(&fs::read(&archive_path).unwrap()),
            size: fs::metadata(&archive_path).unwrap().len(), manifest_sha256: sha(&manifest_bytes), files: files.len(), expanded_bytes: 64 };
        let manifest_sha = sidecar.manifest_sha256.clone();
        (archive_path, sidecar, manifest_sha)
    }

    #[test]
    fn extracts_and_verifies_every_runtime_file() {
        let directory = scratch("ok");
        let (archive, sidecar, manifest_sha) = fixture(&directory, false);
        let staging = directory.join("staging");
        fs::create_dir(&staging).unwrap();
        extract(&archive, &sidecar, &manifest_sha, &staging).unwrap();
        assert_eq!(fs::read(staging.join("engine/lib/data.json")).unwrap(), b"{\"ok\":true}");
        assert!(REQUIRED_FILES.iter().all(|name| staging.join(name).is_file()));
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn rejects_tampered_files_and_untrusted_manifests() {
        let directory = scratch("tampered");
        let (archive, sidecar, manifest_sha) = fixture(&directory, true);
        let staging = directory.join("staging");
        fs::create_dir(&staging).unwrap();
        assert_eq!(extract(&archive, &sidecar, &manifest_sha, &staging).unwrap_err(), "studio_runtime_damaged");
        let (archive, sidecar, _) = fixture(&directory, false);
        let other = directory.join("other");
        fs::create_dir(&other).unwrap();
        assert_eq!(extract(&archive, &sidecar, &"0".repeat(64), &other).unwrap_err(), "studio_runtime_damaged");
        let _ = fs::remove_dir_all(&directory);
    }

    /// Manual timing on the real installer resource: set HUANGGUA_STUDIO_ARCHIVE_TEST to resources/huanggua-studio.zip.
    #[test]
    #[ignore]
    fn times_real_runtime_extraction() {
        let Ok(path) = std::env::var("HUANGGUA_STUDIO_ARCHIVE_TEST") else { return; };
        let archive = PathBuf::from(path);
        let sidecar = read_sidecar(&archive.with_file_name(BUNDLE_SIDECAR)).unwrap();
        let directory = scratch("real");
        let started = std::time::Instant::now();
        extract(&archive, &sidecar, &sidecar.manifest_sha256.clone(), &directory).unwrap();
        println!("extracted {} files in {:.1}s", sidecar.files, started.elapsed().as_secs_f64());
        let _ = fs::remove_dir_all(&directory);
    }
}
