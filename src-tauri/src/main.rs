#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use std::sync::Mutex;


mod epub;
mod filesystem;
mod updates;

const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 128 * 1024 * 1024;
const MAX_FILES: usize = 1000;
const MAX_BACKUP_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Serialize)]
struct ImportedFile {
    id: String,
    name: String,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    blocks: Option<Vec<epub::Block>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    chapters: Option<Vec<epub::Chapter>>,
}

#[derive(Serialize, Default)]
struct ImportResult {
    files: Vec<ImportedFile>,
    warnings: Vec<String>,
}

#[derive(Clone, Serialize)]
struct ImportProgress {
    processed: usize,
    imported: usize,
    path: String,
}

fn supported(path: &Path) -> bool {
    path.extension().and_then(|s| s.to_str()).is_some_and(|s| {
        matches!(
            s.to_ascii_lowercase().as_str(),
            "txt" | "md" | "markdown" | "epub"
        )
    })
}

fn existing_open_paths(args: impl IntoIterator<Item = PathBuf>, base: &Path) -> Vec<String> {
    let mut seen = HashSet::new();
    args.into_iter()
        .skip(1)
        .filter_map(|argument| {
            let argument =
                if let Some(uri) = argument.to_str().filter(|text| text.starts_with("file:")) {
                    tauri::Url::parse(uri).ok()?.to_file_path().ok()?
                } else {
                    argument
                };
            let path = if argument.is_absolute() {
                argument
            } else {
                base.join(argument)
            };
            if !(path.is_dir() || (path.is_file() && supported(&path))) {
                return None;
            }
            let canonical = fs::canonicalize(path).ok()?;
            seen.insert(canonical.clone())
                .then(|| canonical.to_string_lossy().to_string())
        })
        .collect()
}

#[tauri::command]
fn startup_paths() -> Vec<String> {
    existing_open_paths(
        std::env::args_os().map(PathBuf::from),
        &std::env::current_dir().unwrap_or_default(),
    )
}

fn decode(bytes: &[u8]) -> Result<String, String> {
    let decoded = if let Some((encoding, bom)) = encoding_rs::Encoding::for_bom(bytes) {
        let (text, errors) = encoding.decode_without_bom_handling(&bytes[bom..]);
        if errors {
            return Err("文件编码损坏".into());
        }
        text.into_owned()
    } else if let Ok(text) = std::str::from_utf8(bytes) {
        text.to_owned()
    } else {
        let (text, _, errors) = encoding_rs::GB18030.decode(bytes);
        if errors {
            return Err("无法识别编码，请另存为 UTF-8".into());
        }
        text.into_owned()
    };
    if decoded.contains('\0') {
        return Err("文件包含二进制内容".into());
    }
    Ok(decoded)
}

fn import_files(paths: Vec<String>, mut progress: impl FnMut(ImportProgress)) -> ImportResult {
    let mut result = ImportResult::default();
    let mut pending: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    pending.sort();
    pending.reverse();
    let mut seen = HashSet::new();
    let mut total = 0;
    let mut visited = 0;
    let mut processed = 0;
    while let Some(path) = pending.pop() {
        visited += 1;
        if visited > 20_000 || result.files.len() >= MAX_FILES || total >= MAX_TOTAL_BYTES {
            result.warnings.push(
                "已达本轮导入上限（1000 份 / 128 MB / 20000 个目录项），可分批添加子文件夹".into(),
            );
            break;
        }
        let metadata = match fs::symlink_metadata(&path) {
            Ok(value) => value,
            Err(error) => {
                result.warnings.push(format!("{}：{error}", path.display()));
                continue;
            }
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        let canonical = match fs::canonicalize(&path) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if !seen.insert(canonical.clone()) {
            continue;
        }
        if metadata.is_dir() {
            match fs::read_dir(&path) {
                Ok(entries) => {
                    let mut children = Vec::new();
                    for entry in entries {
                        match entry {
                            Ok(entry) => {
                                let name = entry.file_name().to_string_lossy().to_string();
                                if name.starts_with('.')
                                    || matches!(
                                        name.as_str(),
                                        "node_modules" | "target" | "$RECYCLE.BIN"
                                    )
                                {
                                    continue;
                                }
                                if pending.len() + children.len() >= 20_000 {
                                    result
                                        .warnings
                                        .push("目录项过多，部分子目录未扫描；请分批添加".into());
                                    break;
                                }
                                children.push(entry.path());
                            }
                            Err(error) => result.warnings.push(format!("目录读取失败：{error}")),
                        }
                    }
                    children.sort();
                    pending.extend(children.into_iter().rev());
                }
                Err(error) => result.warnings.push(format!("{}：{error}", path.display())),
            }
            continue;
        }
        if !metadata.is_file() || !supported(&path) {
            continue;
        }
        processed += 1;
        progress(ImportProgress {
            processed,
            imported: result.files.len(),
            path: path.to_string_lossy().to_string(),
        });
        let is_epub = path
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.eq_ignore_ascii_case("epub"));
        let limit = if is_epub {
            epub::MAX_EPUB_BYTES
        } else {
            MAX_FILE_BYTES
        };
        if metadata.len() > limit || total + metadata.len() > MAX_TOTAL_BYTES {
            result.warnings.push(format!(
                "{}：超出单文件 {} MB 或本轮 128 MB 限制",
                path.display(),
                limit / 1024 / 1024
            ));
            continue;
        }
        let imported = read_limited(&path, limit).and_then(|data| {
            let mut file = ImportedFile {
                id: canonical.to_string_lossy().to_string(),
                name: path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string(),
                content: String::new(),
                format: None,
                title: None,
                author: None,
                blocks: None,
                chapters: None,
            };
            if is_epub {
                let book = epub::parse(&data)?;
                file.format = Some("epub");
                file.content = book.content;
                file.title = book.title;
                file.author = book.author;
                file.blocks = Some(book.blocks);
                file.chapters = Some(book.chapters);
                result.warnings.extend(
                    book.warnings
                        .into_iter()
                        .map(|warning| format!("{}：{warning}", path.display())),
                );
            } else {
                file.content = decode(&data)?;
            }
            if file.content.trim().is_empty() {
                return Err("空文件".into());
            }
            Ok(file)
        });
        match imported {
            Ok(file) => {
                // EPUB text may be much larger than its compressed source. Count
                // both forms so a batch of small, highly compressed books stays bounded.
                let import_bytes = metadata.len().max(file.content.len() as u64);
                if total + import_bytes > MAX_TOTAL_BYTES {
                    result.warnings.push(format!(
                        "{}：提取正文后超出本轮 128 MB 限制，请分批导入",
                        path.display()
                    ));
                    continue;
                }
                total += import_bytes;
                result.files.push(file);
            }
            Err(error) => result.warnings.push(format!("{}：{error}", path.display())),
        }
        progress(ImportProgress {
            processed,
            imported: result.files.len(),
            path: path.to_string_lossy().to_string(),
        });
    }
    result
}

fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    if file.metadata().map_err(|error| error.to_string())?.len() > limit {
        return Err(format!("文件超过 {} MB 限制", limit / 1024 / 1024));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > limit {
        return Err(format!("文件超过 {} MB 限制", limit / 1024 / 1024));
    }
    Ok(bytes)
}

#[tauri::command]
async fn import_paths(app: tauri::AppHandle, paths: Vec<String>) -> Result<ImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        import_files(paths, |progress| {
            let _ = app.emit("reader-import-progress", progress);
        })
    })
    .await
    .map_err(|e| e.to_string())
}

fn write_backup(path: &Path, json: &str, overwrite: bool) -> Result<(), String> {
    if json.is_empty() || json.len() as u64 > MAX_BACKUP_BYTES {
        return Err("备份为空或超过 128 MB 限制".into());
    }
    let parent = path.parent().ok_or("备份目标目录无效")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("无法创建备份：{error}"))?;
    temporary
        .write_all(json.as_bytes())
        .map_err(|error| format!("无法写入备份：{error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("无法保存备份：{error}"))?;
    if overwrite { temporary.persist(path) } else { temporary.persist_noclobber(path) }
        .map_err(|error| format!("无法完成备份（目标已存在时请重新选择并确认覆盖）：{error}"))?;
    Ok(())
}

#[tauri::command]
async fn export_backup(path: String, contents: String, overwrite: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = Path::new(&path);
        if !target.is_absolute() || !target.extension().is_some_and(|e| e.eq_ignore_ascii_case("json")) {
            return Err("请指定完整的 .json 备份路径".into());
        }
        write_backup(target, &contents, overwrite)?;
        Ok(path)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn import_backup(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = read_limited(Path::new(&path), MAX_BACKUP_BYTES)?;
        let json = String::from_utf8(bytes).map_err(|_| "备份须为 UTF-8 JSON 文件")?;
        Ok(json.trim_start_matches('\u{feff}').to_owned())
    }).await.map_err(|e| e.to_string())?
}

#[derive(Default)]
struct BossShortcut(Mutex<Option<Shortcut>>);

fn reader_is_foreground(app: &tauri::AppHandle) -> bool {
    let Some(window) = app.get_webview_window("main") else { return false; };
    #[cfg(windows)]
    {
        // GetActiveWindow is thread-local and may report no window from a
        // shortcut callback. The foreground HWND also handles WebView focus.
        #[link(name = "user32")]
        extern "system" { fn GetForegroundWindow() -> *mut std::ffi::c_void; }
        window.hwnd().is_ok_and(|handle| unsafe { GetForegroundWindow() == handle.0 })
    }
    #[cfg(not(windows))]
    { window.is_focused().unwrap_or(false) }
}

#[tauri::command]
async fn reader_has_focus(app: tauri::AppHandle) -> bool {
    reader_is_foreground(&app)
}

#[tauri::command]
async fn register_boss_key(app: tauri::AppHandle, state: tauri::State<'_, BossShortcut>, key: String) -> Result<(), String> {
    let next: Shortcut = key.parse().map_err(|e| format!("无效快捷键：{e}"))?;
    let mut current = state.0.lock().map_err(|_| "快捷键状态不可用")?;
    if current.as_ref() == Some(&next) { return Ok(()); }
    app.global_shortcut().register(next).map_err(|e| format!("快捷键被占用或系统不支持全局热键：{e}"))?;
    if let Some(old) = *current {
        if let Err(error) = app.global_shortcut().unregister(old) {
            let _ = app.global_shortcut().unregister(next);
            return Err(error.to_string());
        }
    }
    *current = Some(next); Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(BossShortcut::default())
        .manage(updates::UpdateState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app, _, event| {
            if event.state == ShortcutState::Pressed {
                let _ = app.emit("reader-boss-key", !reader_is_foreground(app));
            }
        }).build())
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            let paths = existing_open_paths(args.into_iter().map(PathBuf::from), Path::new(&cwd));
            if !paths.is_empty() {
                let _ = app.emit("reader-open-paths", paths);
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            updates::check_release_update,
            updates::open_release_download,
            updates::supports_auto_update,
            updates::download_release_update,
            updates::install_release_update,
            reader_has_focus,
            register_boss_key,
            import_paths,
            export_backup,
            import_backup,
            startup_paths,
            filesystem::browse_directory,
            filesystem::backup_target
        ])
        .run(tauri::generate_context!())
        .expect("无法启动 Terminal Reader");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_chinese_and_rejects_binary() {
        assert_eq!(decode("夜里的书店".as_bytes()).unwrap(), "夜里的书店");
        assert_eq!(decode(&[0xff, 0xfe, 0x66, 0x4e]).unwrap(), "书");
        let (gbk, _, _) = encoding_rs::GBK.encode("夜里的书店");
        assert_eq!(decode(&gbk).unwrap(), "夜里的书店");
        assert!(decode(b"abc\0def").is_err());
    }

    #[test]
    fn imports_nested_readable_files_once() {
        let dir = std::env::temp_dir().join(format!("terminal-reader-test-{}", std::process::id()));
        fs::create_dir_all(dir.join("chapter")).unwrap();
        fs::write(dir.join("chapter/02.MD"), "# hello\n\n正文").unwrap();
        fs::write(dir.join("01.txt"), "第一章").unwrap();
        fs::write(dir.join("ignored.exe"), "not a book").unwrap();
        fs::write(dir.join("empty.txt"), " ").unwrap();
        let mut progress = Vec::new();
        let result = import_files(
            vec![
                dir.to_string_lossy().to_string(),
                dir.join("01.txt").to_string_lossy().to_string(),
            ],
            |event| progress.push(event),
        );
        assert_eq!(result.files.len(), 2);
        assert_eq!(result.warnings.len(), 1);
        assert_eq!(progress.last().unwrap().imported, 2);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn backup_writes_atomically_and_bounded_reads_reject_oversize() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("backup.json");
        write_backup(&path, r#"{"version":1}"#, false).unwrap();
        assert!(write_backup(&path, "must not replace", false).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), r#"{"version":1}"#);
        write_backup(&path, r#"{"version":2}"#, true).unwrap();
        assert_eq!(
            String::from_utf8(read_limited(&path, MAX_BACKUP_BYTES).unwrap()).unwrap(),
            r#"{"version":2}"#
        );
        assert!(read_limited(&path, 2).is_err());
        assert!(write_backup(&path, "", true).is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn resolves_file_association_paths_from_launch_directory() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("book.EPUB"), b"fixture").unwrap();
        fs::write(dir.path().join("ignore.exe"), b"fixture").unwrap();
        let paths = existing_open_paths(
            [
                "app.exe",
                "book.EPUB",
                "ignore.exe",
                "missing.txt",
                "book.EPUB",
            ]
            .into_iter()
            .map(PathBuf::from),
            dir.path(),
        );
        assert_eq!(paths.len(), 1);
        assert!(paths[0].ends_with("book.EPUB"));
        let uri = tauri::Url::from_file_path(dir.path().join("book.EPUB"))
            .unwrap()
            .to_string();
        let paths = existing_open_paths(
            ["app.exe", uri.as_str(), "https://example.com/book.epub"]
                .into_iter()
                .map(PathBuf::from),
            dir.path(),
        );
        assert_eq!(paths.len(), 1);
        assert!(paths[0].ends_with("book.EPUB"));
    }
}
