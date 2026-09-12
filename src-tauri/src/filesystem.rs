use serde::Serialize;
use std::{fs, path::{Path, PathBuf}};

#[derive(Serialize)]
pub struct Entry { name: String, path: String, directory: bool }
#[derive(Serialize)]
pub struct Listing { path: String, parent: Option<String>, entries: Vec<Entry>, locations: Vec<Entry>, file: Option<String>, truncated: bool }
#[derive(Serialize)]
pub struct SaveTarget { path: String, exists: bool }

fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from).unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "C:\\" } else { "/" }))
}
fn resolve(value: &str) -> PathBuf {
    let value = value.trim().trim_matches('"');
    if value.is_empty() || value == "~" { home() }
    else if value.starts_with("~/") || value.starts_with("~\\") { home().join(&value[2..]) }
    else { PathBuf::from(value) }
}
fn display(path: &Path) -> String { path.to_string_lossy().to_string() }
fn entry(path: PathBuf, name: String, directory: bool) -> Entry { Entry { name, path: display(&path), directory } }
fn locations() -> Vec<Entry> {
    let base = home();
    let mut result = vec![entry(base.clone(), "~ 主目录".into(), true)];
    for name in ["Desktop", "Documents", "Downloads"] {
        let path = base.join(name);
        if path.is_dir() { result.push(entry(path, name.into(), true)); }
    }
    if cfg!(windows) {
        for letter in b'A'..=b'Z' {
            let name = format!("{}:\\", letter as char);
            let path = PathBuf::from(&name);
            if path.is_dir() { result.push(entry(path, name, true)); }
        }
    } else { result.push(entry(PathBuf::from("/"), "/".into(), true)); }
    result
}
fn list(value: &str, mode: &str) -> Result<Listing, String> {
    let requested = resolve(value);
    if !requested.is_absolute() { return Err("请输入完整路径，或以 ~ 表示主目录".into()); }
    let metadata = fs::metadata(&requested).map_err(|e| format!("无法访问路径：{e}"))?;
    let file = if metadata.is_file() {
        if !allowed(&requested, mode) { return Err("此文件格式不适用于当前操作".into()); }
        Some(display(&requested))
    } else { None };
    let path = if file.is_some() { requested.parent().ok_or("没有上级目录")?.to_path_buf() } else { requested };
    let mut entries = Vec::new();
    let mut truncated = false;
    for (index, item) in fs::read_dir(&path).map_err(|e| format!("无法读取目录：{e}"))?.enumerate() {
        if index >= 20_000 { truncated = true; break; }
        let Ok(item) = item else { continue };
        let Ok(kind) = item.file_type() else { continue };
        let directory = kind.is_dir() || (kind.is_symlink() && item.path().is_dir());
        if directory || ((kind.is_file() || kind.is_symlink()) && allowed(&item.path(), mode)) {
            entries.push(entry(item.path(), item.file_name().to_string_lossy().into(), directory));
        }
    }
    entries.sort_by(|a,b| b.directory.cmp(&a.directory).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(Listing { parent: path.parent().map(display), path: display(&path), entries, locations: locations(), file, truncated })
}
fn allowed(path: &Path, mode: &str) -> bool {
    match mode { "books" => super::supported(path), "restore" | "save" => path.extension().is_some_and(|e| e.eq_ignore_ascii_case("json")), _ => false }
}
#[tauri::command]
pub async fn browse_directory(path: String, mode: String) -> Result<Listing, String> {
    tauri::async_runtime::spawn_blocking(move || list(&path, &mode)).await.map_err(|e| e.to_string())?
}
fn target(directory: &str, name: &str) -> Result<SaveTarget, String> {
    if name.trim().is_empty() { return Err("请输入备份文件名".into()); }
    let mut path = PathBuf::from(directory).join(name.trim());
    if !path.is_absolute() { return Err("需要完整保存路径".into()); }
    if path.extension().is_none() { path.set_extension("json"); }
    if !allowed(&path, "save") { return Err("备份文件名须以 .json 结尾".into()); }
    if !path.parent().is_some_and(Path::is_dir) { return Err("保存目录不存在".into()); }
    if path.is_dir() { return Err("目标是文件夹，请换一个文件名".into()); }
    Ok(SaveTarget { exists: path.try_exists().map_err(|e| e.to_string())?, path: display(&path) })
}
#[tauri::command]
pub async fn backup_target(directory: String, name: String) -> Result<SaveTarget, String> {
    tauri::async_runtime::spawn_blocking(move || target(&directory, &name)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn filters_lists_and_checks_save_destinations() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("folder")).unwrap();
        for name in ["book.TXT", "ebook.epub", "backup.json", "app.exe"] { fs::write(dir.path().join(name), "data").unwrap(); }
        let path = display(dir.path());
        let books = list(&path, "books").unwrap();
        assert_eq!(books.entries.len(), 3);
        assert!(books.entries[0].directory);
        assert_eq!(list(&path, "folder").unwrap().entries.len(), 1);
        assert_eq!(list(&path, "restore").unwrap().entries.len(), 2);
        assert!(list(&display(&dir.path().join("app.exe")), "books").is_err());
        assert!(list(&display(&dir.path().join("book.TXT")), "books").unwrap().file.is_some());
        assert!(target(&path, "backup.json").unwrap().exists);
        assert!(target(&path, "new").unwrap().path.ends_with("new.json"));
        assert!(target(&path, "app.exe").is_err());
        assert!(target(&path, "missing/new.json").is_err());
        assert!(target(&path, "").is_err());
    }
}
