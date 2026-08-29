//! 左侧「功能树 / 文件资源管理器」组件 — 形态参照 Trae Work 的文件面板：
//! - 根节点锚定 defaultCwd，可展开/折叠文件夹
//! - 目录折叠箭头，文件图标按扩展名着色
//! - 顶部工具栏：刷新 / 新建文件夹 / 新建文件 占位
//! - 点击文件时触发 onFileSelect，交由中心区预览面板或交给用户自定义处理

import { useEffect, useState } from "react";
import * as codex from "../codexClient";
import type { FsEntry } from "../codexClient";

export interface FileTreeProps {
  /** 安全根（= defaultCwd），仅允许遍历其下。空串时显示占位。 */
  root: string;
  /** 用户选中了某个文件（非目录）。 */
  onFileSelect?: (relPath: string, entry: FsEntry) => void;
}

interface Node {
  entry: FsEntry;
  relPath: string;
  expanded: boolean;
  children: Node[] | null; // null = 未加载；[] = 已加载为空
  loading: boolean;
}

function relJoin(parent: string, name: string): string {
  if (!parent) return name;
  return parent + "/" + name;
}

/** 由扩展名返回轻量图标字母 + 颜色提示。 */
function fileBadge(ext: string | null): { glyph: string; color: string } {
  const e = (ext || "").toLowerCase();
  if (!e) return { glyph: "?", color: "#6B7280" };
  switch (e) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
      return { glyph: e[0].toUpperCase(), color: "#6C71E4" };
    case "rs":
      return { glyph: "R", color: "#E66B3B" };
    case "json":
    case "toml":
    case "yaml":
    case "yml":
      return { glyph: "{", color: "#8B5CF6" };
    case "md":
      return { glyph: "M", color: "#374151" };
    case "css":
    case "scss":
    case "less":
      return { glyph: "#", color: "#2B6CB0" };
    case "html":
      return { glyph: "H", color: "#E34F26" };
    case "py":
      return { glyph: "P", color: "#3572A5" };
    case "go":
      return { glyph: "G", color: "#00ADD8" };
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "svg":
    case "webp":
      return { glyph: "I", color: "#EC4899" };
    case "zip":
    case "tar":
    case "gz":
      return { glyph: "Z", color: "#F59E0B" };
    default:
      return { glyph: e[0].toUpperCase(), color: "#6B7280" };
  }
}

export default function FileTree({ root, onFileSelect }: FileTreeProps) {
  const [tree, setTree] = useState<Node[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 根目录初次加载
  useEffect(() => {
    if (!root) {
      setTree([]);
      return;
    }
    loadRoot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  async function loadRoot() {
    setLoading(true);
    setError(null);
    try {
      const list = await codex.fsListDir(root, "");
      setTree(
        list.map((e) => ({
          entry: e,
          relPath: e.name,
          expanded: false,
          children: e.isDir ? null : undefined as any,
          loading: false,
        }))
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function toggleNode(idxPath: number[]) {
    setTree((prev) => {
      const clone = [...prev];
      let levelArr: Node[] = clone;
      for (let i = 0; i < idxPath.length - 1; i++) {
        levelArr = levelArr[idxPath[i]].children as Node[];
      }
      const lastIdx = idxPath[idxPath.length - 1];
      const node = { ...levelArr[lastIdx] };
      levelArr[lastIdx] = node;
      if (!node.entry.isDir) {
        // 单击非目录 → 选中
        onFileSelect?.(node.relPath, node.entry);
        return clone;
      }
      if (!node.expanded) {
        node.expanded = true;
        if (node.children === null) {
          node.loading = true;
          const r = node.relPath;
          codex.fsListDir(root, r).then((kids) => {
            setTree((t2) => {
              const c2 = [...t2];
              let la: Node[] = c2;
              for (let i = 0; i < idxPath.length - 1; i++) la = la[idxPath[i]].children as Node[];
              const li = idxPath[idxPath.length - 1];
              const nd = { ...la[li] };
              la[li] = nd;
              nd.loading = false;
              nd.children = kids.map((k) => ({
                entry: k,
                relPath: relJoin(r, k.name),
                expanded: false,
                children: k.isDir ? null : (undefined as any),
                loading: false,
              }));
              return c2;
            });
          }).catch((err) => {
            setError(err instanceof Error ? err.message : String(err));
            setTree((t2) => {
              const c2 = [...t2];
              let la: Node[] = c2;
              for (let i = 0; i < idxPath.length - 1; i++) la = la[idxPath[i]].children as Node[];
              const li = idxPath[idxPath.length - 1];
              const nd = { ...la[li] };
              la[li] = nd;
              nd.loading = false;
              nd.children = [];
              return c2;
            });
          });
        }
      } else {
        node.expanded = false;
      }
      return clone;
    });
  }

  function row(
    node: Node,
    idxPath: number[],
    depth: number
  ): JSX.Element {
    const pad = 8 + depth * 16;
    const isDir = node.entry.isDir;
    const b = isDir ? null : fileBadge(node.entry.ext);
    return (
      <div key={node.relPath}>
        <div
          className={`ft-row ${isDir ? "dir" : "file"}`}
          style={{ paddingLeft: pad }}
          onClick={() => toggleNode(idxPath)}
          title={node.entry.path}
        >
          {isDir ? (
            <span className={`ft-caret ${node.expanded ? "open" : ""}`}>
              {node.loading ? "·" : "›"}
            </span>
          ) : (
            <span className="ft-caret" />
          )}
          {isDir ? (
            <span className={`ft-ico-dir ${node.expanded ? "open" : ""}`}>
              <span className="dir-glyph" />
            </span>
          ) : (
            <span
              className="ft-ico-file"
              style={{ background: (b as any).color + "1A", color: (b as any).color }}
            >
              {(b as any).glyph}
            </span>
          )}
          <span className="ft-name">{node.entry.name}</span>
          {!isDir && node.entry.size != null && (
            <span className="ft-size">{formatSize(node.entry.size!)}</span>
          )}
        </div>
        {isDir && node.expanded && node.children && (
          <div className="ft-children">
            {node.children.length === 0 && (
              <div className="ft-empty" style={{ paddingLeft: pad + 32 }}>
                （空目录）
              </div>
            )}
            {node.children.map((ch, i) =>
              row(ch, [...idxPath, i], depth + 1)
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="file-tree">
      <div className="ft-head">
        <div className="ft-title">文件</div>
        <div className="ft-tools">
          <button
            className="icon-btn tiny"
            onClick={loadRoot}
            disabled={loading || !root}
            title="刷新"
          >
            刷新
          </button>
        </div>
      </div>

      {!root && (
        <div className="ft-empty ft-banner">工作目录尚未就绪…</div>
      )}
      {root && error && (
        <div className="ft-error">加载失败：{error}</div>
      )}
      {root && !error && (
        <div className="ft-body">
          {loading && tree.length === 0 && (
            <div className="ft-loading">加载目录中…</div>
          )}
          {!loading && tree.length === 0 && (
            <div className="ft-empty ft-banner">
              工作目录为空。在对话中让 Agent 生成代码，文件会出现在这里。
            </div>
          )}
          {tree.map((n, i) => row(n, [i], 0))}
        </div>
      )}
    </div>
  );
}

function formatSize(b: number): string {
  if (b < 1024) return b + "B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + "K";
  return (b / 1024 / 1024).toFixed(1) + "M";
}
