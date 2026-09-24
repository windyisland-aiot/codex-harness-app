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

/// 可直接内联预览的媒体扩展名（两条命令共用的白名单）。
const MEDIA_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg", "ico",
    "mp4", "webm", "mov", "m4v", "ogv", "mkv",
    "mp3", "wav", "m4a", "ogg", "flac", "aac",
];

fn media_ext_of(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    if MEDIA_EXTS.contains(&ext.as_str()) {
        Some(ext)
    } else {
        None
    }
}

fn mime_of(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "m4v" => "video/x-m4v",
        "ogv" => "video/ogg",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "aac" => "audio/aac",
        _ => "application/octet-stream",
    }
}

/// 批量探测媒体文件：按输入顺序返回字节数，不存在 / 非媒体扩展名返回 0。
///
/// 前端在渲染一条回复前先探测，只把真实存在的媒体渲染成内联预览，
/// 避免路径写错时出现一堆坏图。
#[tauri::command]
pub fn fs_probe_media(paths: Vec<String>) -> Vec<u64> {
    paths
        .iter()
        .map(|raw| {
            let p = PathBuf::from(raw.trim().trim_matches('"'));
            if media_ext_of(&p).is_none() {
                return 0;
            }
            std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0)
        })
        .collect()
}

/// 以 data URL 读取媒体文件，供 `<img src>` 在 asset 协议取不到时兜底
/// （例如文件落在 `$CODEX_HOME` 之外、不在协议白名单里）。
///
/// 只放行媒体扩展名 + 体积上限，不作为任意文件读取接口使用。
#[tauri::command]
pub fn fs_read_media(path: String, max_bytes: Option<u64>) -> Result<String, String> {
    use base64::Engine;
    let p = PathBuf::from(path.trim().trim_matches('"'));
    let ext = media_ext_of(&p).ok_or_else(|| format!("不是可预览的媒体文件：{}", p.display()))?;
    if !p.is_file() {
        return Err(format!("文件不存在：{}", p.display()));
    }
    let limit = max_bytes.unwrap_or(24 * 1024 * 1024);
    let len = std::fs::metadata(&p).map_err(|e| e.to_string())?.len();
    if len > limit {
        return Err(format!(
            "文件过大（{:.1} MB > {:.1} MB），已跳过内联预览",
            len as f64 / 1048576.0,
            limit as f64 / 1048576.0
        ));
    }
    let raw = std::fs::read(&p).map_err(|e| format!("读取失败：{e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(raw);
    Ok(format!("data:{};base64,{}", mime_of(&ext), b64))
}

/// 写入二进制文件（base64 内容）。用于把用户在对话中附加的 PDF/文档等
/// 落到 workspace 内，再由本地 codex 直接读取（图片走多模态 data URL，不经此）。
#[tauri::command]
pub fn fs_write_file_b64(root: &str, rel_path: &str, b64: String) -> Result<String, String> {
    use base64::Engine;
    let target = safe_join(Path::new(root), rel_path)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {:?}: {e}", parent))?;
    }
    let raw = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    std::fs::write(&target, raw).map_err(|e| format!("write {:?}: {e}", target))?;
    Ok(target.to_string_lossy().to_string())
}
