use semver::Version;
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::{io::Read, sync::OnceLock, time::Duration};
use tauri::Emitter;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

#[derive(Default)]
pub struct UpdateState {
    busy: AtomicBool,
    downloaded: Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>>,
}

struct BusyGuard<'a>(&'a AtomicBool);
impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[derive(Clone, Serialize)]
struct DownloadProgress {
    downloaded: u64,
    total: Option<u64>,
}

#[tauri::command]
pub fn supports_auto_update() -> bool {
    cfg!(windows) || (cfg!(target_os = "linux") && std::env::var_os("APPIMAGE").is_some())
}

#[tauri::command]
pub async fn download_release_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, UpdateState>,
) -> Result<String, String> {
    if !supports_auto_update() {
        return Err("此发行格式请使用手动下载；Linux 自动升级需要运行 AppImage。".into());
    }
    if state.busy.swap(true, Ordering::AcqRel) {
        return Err("更新任务正在进行。".into());
    }
    let _busy = BusyGuard(&state.busy);
    if let Some((update, _)) = state
        .downloaded
        .lock()
        .map_err(|_| "更新状态不可用")?
        .as_ref()
    {
        return Ok(update.version.clone());
    }
    let update = app
        .updater_builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|_| "更新服务暂不可用，请使用手动下载。")?
        .check()
        .await
        .map_err(|_| "无法获取更新包，请稍后重试或手动下载。")?
        .ok_or("目前没有可安装的新版本。")?;
    let version = Version::parse(&update.version).map_err(|_| "更新版本无效")?;
    let current = Version::parse(env!("CARGO_PKG_VERSION")).map_err(|_| "当前版本无效")?;
    let prefix =
        format!("https://github.com/mangfufu/terminal-reader/releases/download/v{version}/");
    if !version.pre.is_empty()
        || version.cmp_precedence(&current).is_le()
        || !update.download_url.as_str().starts_with(&prefix)
    {
        return Err("更新来源或版本不符合要求，请使用手动下载。".into());
    }
    let mut downloaded = 0u64;
    let mut last_event = std::time::Instant::now();
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                if last_event.elapsed() >= Duration::from_millis(150) || total == Some(downloaded) {
                    let _ = app.emit(
                        "reader-update-progress",
                        DownloadProgress { downloaded, total },
                    );
                    last_event = std::time::Instant::now();
                }
            },
            || {},
        )
        .await
        .map_err(|_| "下载失败或签名校验未通过；未安装更新，可重试或手动下载。")?;
    let version = update.version.clone();
    *state.downloaded.lock().map_err(|_| "更新状态不可用")? = Some((update, bytes));
    Ok(version)
}

#[tauri::command]
pub async fn install_release_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, UpdateState>,
) -> Result<(), String> {
    if state.busy.swap(true, Ordering::AcqRel) {
        return Err("更新任务正在进行。".into());
    }
    let _busy = BusyGuard(&state.busy);
    let (update, bytes) = state
        .downloaded
        .lock()
        .map_err(|_| "更新状态不可用")?
        .take()
        .ok_or("请先下载并校验更新包。")?;
    tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|_| "安装未完成，请重新下载或手动安装。")?
        .map_err(|_| "安装未完成，请重新下载或手动安装。")?;
    app.restart();
}

const API: &str = "https://api.github.com/repos/mangfufu/terminal-reader/releases/latest";
const RELEASES: &str = "https://github.com/mangfufu/terminal-reader/releases/latest";
const MAX_RESPONSE: u64 = 512 * 1024;
static CHECK: OnceLock<Option<Update>> = OnceLock::new();

#[derive(Clone, Serialize, Debug, PartialEq)]
pub struct Update {
    version: String,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
}

fn newer_release(bytes: &[u8], current: &str) -> Option<Update> {
    let release: Release = serde_json::from_slice(bytes).ok()?;
    if release.draft || release.prerelease || release.tag_name.len() > 128 {
        return None;
    }
    let version = Version::parse(
        release
            .tag_name
            .strip_prefix('v')
            .unwrap_or(&release.tag_name),
    )
    .ok()?;
    let current = Version::parse(current).ok()?;
    if !version.pre.is_empty() || version.cmp_precedence(&current).is_le() {
        return None;
    }
    Some(Update {
        version: version.to_string(),
    })
}

fn fetch_update() -> Option<Update> {
    // Public endpoint only: no book data, local paths, credentials or cookies.
    let client = reqwest::blocking::Client::builder()
        .user_agent(concat!("TerminalReader/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(8))
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()?;
    let response = client
        .get(API)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .ok()?
        .error_for_status()
        .ok()?;
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE)
    {
        return None;
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_RESPONSE + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_RESPONSE {
        return None;
    }
    newer_release(&bytes, env!("CARGO_PKG_VERSION"))
}

#[tauri::command]
pub async fn check_release_update() -> Option<Update> {
    // Once per process, including failures and concurrent/reloaded webviews.
    tauri::async_runtime::spawn_blocking(|| CHECK.get_or_init(fetch_update).clone())
        .await
        .ok()
        .flatten()
}

#[tauri::command]
pub fn open_release_download(app: tauri::AppHandle) -> Result<(), String> {
    // Fixed destination; neither IPC callers nor release text can open arbitrary URLs.
    app.opener().open_url(RELEASES, None::<&str>).map_err(|_| {
        "无法打开浏览器，请前往 GitHub 的 mangfufu/terminal-reader Releases 下载。".into()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn release(tag: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"tag_name":tag,"draft":false,"prerelease":false}))
            .unwrap()
    }
    #[test]
    fn compares_numeric_versions_without_downgrades_or_build_metadata_updates() {
        assert!(newer_release(&release("v0.10.0"), "0.9.0").is_some());
        assert!(newer_release(&release("1.0.0"), "0.99.0").is_some());
        for tag in [
            "v0.6.1",
            "v0.6.0",
            "v0.6.1+build.2",
            "v0.7.0-beta.1",
            "nightly",
            "<script>",
        ] {
            assert!(newer_release(&release(tag), "0.6.1").is_none(), "{tag}");
        }
    }
    #[test]
    fn ignores_drafts_prereleases_and_invalid_api_responses() {
        for bytes in [
            br#"{"tag_name":"v9.0.0","draft":true,"prerelease":false}"#.as_slice(),
            br#"{"tag_name":"v9.0.0","draft":false,"prerelease":true}"#,
            br#"{"message":"API rate limit exceeded"}"#,
            b"<html>unavailable</html>",
            b"null",
        ] {
            assert!(newer_release(bytes, "0.6.1").is_none());
        }
    }
}
