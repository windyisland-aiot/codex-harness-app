//! 简易文件系统浏览器命令（用于左侧「功能树 / 文件资源管理器」面板）。
//!
//! 安全策略：仅允许遍历 `default_cwd`（AppData 下 workspace）及其子目录，
//! 禁止访问上级或系统目录，避免越权。前端传 `root: defaultCwd` 作为锚点。

use std::path::{Path, PathBuf};

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub path: PathBuf,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub ext: Option<String>,
}

fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(|e| format!("canonicalize root: {e}"))?;
    let rel = rel.trim_start_matches('/').trim_start_matches('\\');
    let target = if rel.is_empty() {
        root.clone()
    } else {
        root.join(rel)
    };
    let canon = target
        .canonicalize()
        .or_else(|_| -> Result<PathBuf, String> { Ok(target.clone()) })?;
    if !canon.starts_with(&root) {
        return Err(format!("拒绝访问 {:?}（越出工作目录）", canon));
    }
    Ok(canon)
}

#[tauri::command]
pub fn fs_list_dir(root: &str, rel_path: &str) -> Result<Vec<FsEntry>, String> {
    let target = safe_join(Path::new(root), rel_path)?;
    if !target.is_dir() {
        return Err(format!("{:?} 不是目录", target));
    }
    let mut out: Vec<FsEntry> = Vec::new();
    let rd = std::fs::read_dir(&target).map_err(|e| format!("read_dir {:?}: {e}", target))?;
    for entry in rd.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let meta = entry.metadata().ok();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = if is_dir { None } else { meta.as_ref().map(|m| m.len()) };
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_string().to_lowercase());
        out.push(FsEntry {
            name,
            path,
            is_dir,
            size,
            ext,
        });
    }
    // 排序：目录在前，然后按字母序
    out.sort_by(|a, b| {
        let ord = b.is_dir.cmp(&a.is_dir);
        if ord != std::cmp::Ordering::Equal {
            return ord;
        }
        a.name.to_lowercase().cmp(&b.name.to_lowercase())
    });
    Ok(out)
}

#[tauri::command]
pub fn fs_read_file(root: &str, rel_path: &str, max_bytes: Option<u64>) -> Result<String, String> {
    let target = safe_join(Path::new(root), rel_path)?;
    if !target.is_file() {
        return Err(format!("{:?} 不是文件", target));
    }
    let mut bytes = std::fs::read(&target).map_err(|e| format!("read {:?}: {e}", target))?;
    if let Some(m) = max_bytes {
        let m = m as usize;
        if bytes.len() > m {
            bytes.truncate(m);
        }
    }
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("文件超过 4MB，仅支持预览小型文本文件".into());
    }
    // 优先 UTF-8，失败时回退为 lossy（不丢失展示）
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub fn fs_write_file(root: &str, rel_path: &str, content: &str) -> Result<(), String> {
    let target = safe_join(Path::new(root), rel_path)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {:?}: {e}", parent))?;
    }
    std::fs::write(&target, content).map_err(|e| format!("write {:?}: {e}", target))?;
    Ok(())
}
