//! T16 会话持久化面板：浏览 / 搜索 / 重命名 / 删除 / 恢复历史会话。
//!
//! 历史会话存于 `<codex_home>/sessions.sqlite`（SQLite）。面板提供：
//! - 列出全部会话（最近更新倒序）；
//! - 关键词搜索（命中标题或消息内容）；
//! - 恢复：把某会话的完整消息载入对话界面（回调 `onLoad`）；
//! - 重命名 / 删除。

import { useState } from "react";
import * as codex from "../codexClient";

export default function SessionsPanel({
  open,
  onClose,
  codexHome,
  onLoad,
  onStatus,
}: {
  open: boolean;
  onClose: () => void;
  codexHome: string;
  onLoad: (d: codex.SessionDetail) => void;
  onStatus: (s: string) => void;
}) {
  const [list, setList] = useState<codex.SessionMeta[] | null>(null);
  const [keyword, setKeyword] = useState("");
  const [searching, setSearching] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [titleBuf, setTitleBuf] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  if (!open) return null;

  if (!loaded) {
    codex
      .sessionList(codexHome)
      .then((l) => {
        setList(l);
      })
      .catch((e) => {
        onStatus(`读取历史会话失败: ${e}（已切换到本地空列表）`);
        setList([]);
      })
      .finally(() => {
        setLoaded(true);
      });
    return null;
  }
  if (!list) return null;

  async function refresh() {
    setBusy(true);
    try {
      setList(await codex.sessionList(codexHome));
    } catch (e) {
      onStatus(`刷新失败: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  /** 搜索模式：命中标题或内容。 */
  async function doSearch() {
    const q = keyword.trim();
    setSearching(true);
    setBusy(true);
    try {
      setList(q ? await codex.sessionSearch(codexHome, q) : await codex.sessionList(codexHome));
    } catch (e) {
      onStatus(`搜索失败: ${e}`);
    } finally {
      setBusy(false);
      setSearching(false);
    }
  }

  async function load(s: codex.SessionMeta) {
    setBusy(true);
    try {
      const d = await codex.sessionGet(codexHome, s.id);
      onLoad(d);
      onClose();
      onStatus(`已恢复会话「${d.meta.title}」`);
    } catch (e) {
      onStatus(`恢复失败: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function rename(s: codex.SessionMeta) {
    const t = titleBuf.trim();
    if (!t) return;
    setBusy(true);
    try {
      await codex.sessionRename(codexHome, s.id, t);
      setEditing(null);
      await refresh();
      onStatus(`已重命名为「${t}」`);
    } catch (e) {
      onStatus(`重命名失败: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(s: codex.SessionMeta) {
    setBusy(true);
    try {
      await codex.sessionDelete(codexHome, s.id);
      await refresh();
      onStatus(`已删除会话 ${s.id}`);
    } catch (e) {
      onStatus(`删除失败: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cfg-backdrop" onClick={onClose}>
      <div className="cfg-panel sessions-panel" onClick={(e) => e.stopPropagation()}>
        <div className="cfg-head">
          <h2>历史会话</h2>
          <button className="cfg-close" onClick={onClose} title="关闭">
            ×
          </button>
        </div>

        <div className="cfg-body">
          <section className="cfg-section">
            <div className="cfg-sec-head">
              <h3>搜索（标题/内容）</h3>
              <button className="cfg-add" onClick={doSearch} disabled={busy}>
                {searching ? "搜索…" : "搜索"}
              </button>
            </div>
            <input
              className="cfg-full"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doSearch()}
              placeholder="关键词（留空列出全部）"
            />
          </section>

          <section className="cfg-section">
            <div className="cfg-sec-head">
              <h3>会话（{list.length}）</h3>
              <button className="cfg-add" onClick={refresh} disabled={busy}>
                刷新
              </button>
            </div>
            {list.length === 0 && <div className="cfg-hint">暂无历史会话。</div>}
            {list.map((s) => (
              <div key={s.id} className="cfg-card">
                {editing === s.id ? (
                  <div className="cfg-row">
                    <input
                      className="cfg-full"
                      value={titleBuf}
                      autoFocus
                      onChange={(e) => setTitleBuf(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && rename(s)}
                      placeholder="新标题"
                    />
                    <button className="cfg-add" onClick={() => rename(s)} disabled={busy}>
                      保存
                    </button>
                    <button className="cfg-add" onClick={() => setEditing(null)}>
                      取消
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="cfg-card-head">
                      <span className="cfg-id" onDoubleClick={() => { setEditing(s.id); setTitleBuf(s.title); }}>
                        {s.title || s.id}
                      </span>
                      <span className="cfg-mono">
                        {new Date(s.updatedAt * 1000).toLocaleString()} · {s.provider}/{s.model}
                      </span>
                    </div>
                    <div className="cfg-item-actions">
                      <button className="cfg-add" onClick={() => load(s)} disabled={busy}>
                        恢复
                      </button>
                      <button
                        className="cfg-add"
                        onClick={() => { setEditing(s.id); setTitleBuf(s.title); }}
                      >
                        重命名
                      </button>
                      <button className="cfg-add cfg-del" onClick={() => remove(s)} disabled={busy}>
                        删除
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}