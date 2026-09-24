//! 对话内媒体预览（图片 / 视频 / 音频）。
//!
//! 解决什么问题：Agent 在回复里给出本地文件路径（`![图](D:\a\x.png)`、
//! `` `D:\a\out.mp4` ``、或直接写一段裸路径）时，用户以前只能看到一个路径字符串。
//! 这里把这些引用渲染成可直接查看/播放的内联卡片：
//! - 图片：asset 协议直出，取不到时用 `fs_read_media` 转 data URL 兜底；
//! - 视频/音频：`<video>/<audio controls>`，asset 协议支持 Range，可拖动进度；
//! - 点击图片/放大按钮 → 全屏浮层（Esc 或点背景关闭）。
//!
//! 只在文件**真实存在**时才替换（渲染前用 `fs_probe_media` 批量探测），
//! 路径写错时保持原文不变，不会出现一堆坏图。

import { convertFileSrc } from "@tauri-apps/api/core";
import * as codex from "./codexClient";

export type MediaKind = "image" | "video" | "audio";

const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg", "ico"];
const VIDEO_EXT = ["mp4", "webm", "mov", "m4v", "ogv", "mkv"];
const AUDIO_EXT = ["mp3", "wav", "m4a", "ogg", "flac", "aac"];
const EXT_ALT = [...IMAGE_EXT, ...VIDEO_EXT, ...AUDIO_EXT].join("|");

/** 裸文本里自动识别的 POSIX 前缀白名单（避免把 /api/v1/x.png 这类当成本地文件）。 */
const POSIX_PREFIX = /^\/(?:home|Users|tmp|mnt|media|var|data|workspace|root|opt|srv|Volumes|private)\//;

/**
 * 裸文本里的媒体路径 token：Windows 盘符 / UNC / POSIX 绝对路径 + 媒体扩展名。
 * 允许路径里带空格（`D:\a b\out.mp4`）——匹配到的路径都会先探测是否存在，
 * 所以即使误判到一段普通文字也不会渲染出东西。
 */
const MEDIA_TOKEN_RE = new RegExp(
  String.raw`(?:[A-Za-z]:[\\/]|\\\\)[^"'<>|*?\n]*?\.(?:${EXT_ALT})\b|\/[^"'<>|*?\n]*?\.(?:${EXT_ALT})\b`,
  "gi"
);

export function mediaKindOf(path: string): MediaKind | null {
  const clean = path.split(/[?#]/)[0];
  const dot = clean.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = clean.slice(dot + 1).toLowerCase();
  if (IMAGE_EXT.includes(ext)) return "image";
  if (VIDEO_EXT.includes(ext)) return "video";
  if (AUDIO_EXT.includes(ext)) return "audio";
  return null;
}

/**
 * 把 markdown/文本里的引用归一成本地绝对路径；远程 URL / data URL 返回 null。
 * `cwd` 给定时，相对路径（`out/a.png`）会按会话工作目录拼成绝对路径。
 */
export function localAbsPath(raw?: string | null, cwd?: string): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s) return null;
  if (/^(https?:|data:|blob:|mailto:|javascript:)/i.test(s)) return null;
  if (/^file:\/\//i.test(s)) {
    try {
      s = decodeURIComponent(s.replace(/^file:\/\//i, ""));
    } catch {
      s = s.replace(/^file:\/\//i, "");
    }
  }
  s = s.replace(/\\([()\[\]])/g, "$1"); // markdown 转义
  if (/^[A-Za-z]:[\\/]/.test(s) || s.startsWith("\\\\") || s.startsWith("/")) {
    return mediaKindOf(s) ? s : null;
  }
  // 相对路径：仅在有 cwd、且不像 URL/协议、不含空格的场景下拼接。
  if (cwd && mediaKindOf(s) && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(s) && !/\s/.test(s)) {
    const base = cwd.replace(/[\\/]+$/, "");
    const windows = /^[A-Za-z]:[\\/]/.test(base) || base.startsWith("\\\\");
    const tail = s.replace(/^[.\\/]+/, "");
    return windows
      ? `${base}\\${tail.replace(/\//g, "\\")}`
      : `${base}/${tail.replace(/\\/g, "/")}`;
  }
  return null;
}

function formatSize(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 全屏媒体浮层（Esc / 点背景关闭）。 */
export function openMediaOverlay(src: string, kind: MediaKind, title?: string): void {
  document.querySelectorAll(".media-overlay").forEach((n) => n.remove());
  const overlay = document.createElement("div");
  overlay.className = "media-overlay";
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  const media =
    kind === "image"
      ? document.createElement("img")
      : document.createElement("video");
  if (kind === "image") {
    (media as HTMLImageElement).src = src;
    (media as HTMLImageElement).alt = title ?? "";
  } else {
    const v = media as HTMLVideoElement;
    v.src = src;
    v.controls = true;
    v.autoplay = true;
  }
  media.className = "media-overlay-body";
  const bar = document.createElement("div");
  bar.className = "media-overlay-bar";
  const label = document.createElement("span");
  label.textContent = title ?? "";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "关闭";
  closeBtn.addEventListener("click", close);
  bar.appendChild(label);
  bar.appendChild(closeBtn);
  overlay.appendChild(bar);
  overlay.appendChild(media);
  document.body.appendChild(overlay);
  document.addEventListener("keydown", onKey);
}

interface CardOpts {
  path: string;
  kind: MediaKind;
  size: number;
  label?: string;
  compact?: boolean;
}

function buildCard(o: CardOpts): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = `md-media md-media-${o.kind}${o.compact ? " compact" : ""}`;
  wrap.dataset.mediaPath = o.path.toLowerCase();

  const asset = convertFileSrc(o.path);
  let node: HTMLImageElement | HTMLVideoElement | HTMLAudioElement;
  if (o.kind === "image") {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.src = asset;
    img.alt = o.label ?? baseName(o.path);
    // asset 协议取不到（路径不在白名单等）→ 退化成 data URL，再失败就显示提示。
    img.addEventListener("error", async () => {
      try {
        img.src = await codex.fsReadMedia(o.path);
      } catch (e) {
        wrap.classList.add("failed");
        wrap.textContent = `无法预览（${String((e as Error)?.message ?? e)}）：${o.path}`;
      }
    });
    node = img;
  } else if (o.kind === "video") {
    const v = document.createElement("video");
    v.src = asset;
    v.controls = true;
    v.preload = "metadata";
    node = v;
  } else {
    const a = document.createElement("audio");
    a.src = asset;
    a.controls = true;
    a.preload = "metadata";
    node = a;
  }
  node.className = "md-media-body";

  const bar = document.createElement("div");
  bar.className = "md-media-bar";
  const name = document.createElement("button");
  name.type = "button";
  name.className = "md-media-name";
  name.title = o.path;
  name.textContent = o.label ?? baseName(o.path);
  name.addEventListener("click", () => openMediaOverlay(asset, o.kind, o.path));
  bar.appendChild(name);
  if (o.size) {
    const size = document.createElement("span");
    size.className = "md-media-size";
    size.textContent = formatSize(o.size);
    bar.appendChild(size);
  }
  if (o.kind !== "audio") {
    const expand = document.createElement("button");
    expand.type = "button";
    expand.className = "md-media-expand";
    expand.title = "放大查看";
    expand.textContent = "⤢";
    expand.addEventListener("click", () => openMediaOverlay(asset, o.kind, o.path));
    bar.appendChild(expand);
  }

  wrap.appendChild(node);
  wrap.appendChild(bar);
  return wrap;
}

/** 收集候选路径：markdown 图片、链接、行内代码、裸文本。 */
interface Candidate {
  path: string;
  refs: Array<{ el: HTMLElement; kind: "img" | "anchor" | "code" | "text" }>;
}

function collectCandidates(root: HTMLElement, cwd?: string): Map<string, Candidate> {
  const map = new Map<string, Candidate>();
  const push = (
    path: string,
    ref: Candidate["refs"][number]
  ) => {
    const hit = map.get(path.toLowerCase());
    if (hit) hit.refs.push(ref);
    else map.set(path.toLowerCase(), { path, refs: [ref] });
  };

  root.querySelectorAll("img").forEach((img) => {
    const p = localAbsPath(img.getAttribute("src"), cwd);
    if (p) push(p, { el: img, kind: "img" });
  });
  root.querySelectorAll("a").forEach((a) => {
    const p = localAbsPath(a.getAttribute("href"), cwd);
    if (p) push(p, { el: a, kind: "anchor" });
  });
  root.querySelectorAll("code").forEach((code) => {
    if (code.closest("pre")) return;
    const p = localAbsPath(code.textContent, cwd);
    if (p) push(p, { el: code, kind: "code" });
  });

  // 裸文本路径（跳过 pre/code/a 内的文本，以及已由上面覆盖的引用）。
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const parent = (n as Text).parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest("pre, code, a, .md-media")) return NodeFilter.FILTER_REJECT;
      if (!(n as Text).data.includes(".")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
  for (const node of textNodes) {
    MEDIA_TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MEDIA_TOKEN_RE.exec(node.data))) {
      const raw = m[0];
      const p = localAbsPath(raw);
      if (!p) continue;
      if (p.startsWith("/") && !POSIX_PREFIX.test(p)) continue;
      push(p, { el: node.parentElement ?? root, kind: "text" });
    }
  }
  return map;
}

/** 插入位置：块级祖先之后，避免打断段落/列表结构。 */
function insertAfterBlock(el: HTMLElement, card: HTMLElement): void {
  const block = el.closest("p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote") ?? el;
  block.parentElement?.insertBefore(card, block.nextSibling);
}

/**
 * 把容器里的本地媒体引用渲染成可查看的卡片。幂等：已处理过的节点会被打标跳过。
 * 必须在 markdown 渲染完成后调用（组件里放在 useEffect 中）。
 */
export async function hydrateMedia(root: HTMLElement, cwd?: string): Promise<void> {
  const candidates = collectCandidates(root, cwd);
  if (candidates.size === 0) return;
  // 已经渲染过的路径不重复插入（流式刷新时 effect 会多次触发）。
  const done = new Set(
    Array.from(root.querySelectorAll<HTMLElement>(".md-media")).map(
      (n) => n.dataset.mediaPath ?? ""
    )
  );
  const paths = [...candidates.values()].map((c) => c.path);
  let sizes: number[] = [];
  try {
    sizes = await codex.fsProbeMedia(paths);
  } catch {
    return; // 探测失败（例如非 Tauri 环境）→ 保持原文
  }
  if (!root.isConnected) return;

  [...candidates.values()].forEach((cand, i) => {
    const size = sizes[i] ?? 0;
    if (!size) return;
    const kind = mediaKindOf(cand.path);
    if (!kind) return;
    const key = cand.path.toLowerCase();
    for (const ref of cand.refs) {
      if (ref.kind === "img" || ref.kind === "anchor") {
        // 图片/链接本身就是引用 → 直接换成卡片（紧凑模式，省空间）。
        const compact = buildCard({
          path: cand.path,
          kind,
          size,
          compact: true,
          label: ref.el.textContent?.trim() || undefined,
        });
        ref.el.replaceWith(compact);
      } else if (!done.has(key)) {
        // 裸路径/行内代码：保留原文，卡片插到所在块之后。
        done.add(key);
        insertAfterBlock(ref.el, buildCard({ path: cand.path, kind, size }));
      }
    }
  });
}
