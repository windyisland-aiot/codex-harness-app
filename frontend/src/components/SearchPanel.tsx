//! T15 联网搜索面板：执行搜索并展示来源；注册 Tavily/Serper MCP。
//!
//! - 搜索区：输入 query，选择 provider（tavily/serper），执行一次搜索并展示
//!   title/url/content（来源列表），也可 `--base-url` 指向内部网关/mock。
//! - MCP 区：填写 provider + 可选 API key，注册 `[mcp_servers.tavily|serper]`
//!   到 config.toml；回读注册状态。

import { useState } from "react";
import * as codex from "../codexClient";

export default function SearchPanel({
  open,
  onClose,
  codexHome,
  onStatus,
}: {
  open: boolean;
  onClose: () => void;
  codexHome: string;
  onStatus: (s: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("tavily");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [maxResults, setMaxResults] = useState(5);
  const [results, setResults] = useState<codex.SearchResult[] | null>(null);
  const [respQuery, setRespQuery] = useState("");
  const [mcpKey, setMcpKey] = useState("");
  const [status, setStatusView] = useState<codex.SearchStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  if (!open) return null;

  // 进入面板时回读一次注册状态。
  if (!loaded) {
    codex
      .searchStatus(codexHome)
      .then((s) => {
        setStatusView(s);
      })
      .catch((e) => {
        onStatus(`读取搜索配置失败: ${e}（已切换到本地空状态）`);
        setStatusView({
          tavily: { registered: false, envKeys: [] },
          serper: { registered: false, envKeys: [] },
        });
      })
      .finally(() => {
        setLoaded(true);
      });
    return null;
  }

  async function runSearch() {
    const q = query.trim();
    if (!q) {
      onStatus("请输入搜索内容");
      return;
    }
    setBusy(true);
    setResults(null);
    try {
      const r = await codex.searchExecute({
        query: q,
        provider,
        apiKey: apiKey.trim() || undefined,
        baseUrl: baseUrl.trim() || undefined,
        maxResults,
      });
      setResults(r.results);
      setRespQuery(r.query);
      onStatus(`搜索完成，命中 ${r.results.length} 条`);
    } catch (e) {
      onStatus(`搜索失败: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function register() {
    setBusy(true);
    try {
      await codex.searchRegisterMcp(codexHome, provider, mcpKey.trim() || undefined);
      const s = await codex.searchStatus(codexHome);
      setStatusView(s);
      onStatus(`已注册 ${provider} MCP（重启 app-server 生效）`);
    } catch (e) {
      onStatus(`注册失败: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  const renderServer = (key: "tavily" | "serper", label: string) => {
    const s = status?.[key];
    if (!s) return null;
    return (
      <div className="cfg-card">
        <div className="cfg-card-head">
          <span className="cfg-id">
            {label} · {s.registered ? "已注册" : "未注册"}
          </span>
        </div>
        {s.registered && s.envKeys && s.envKeys.length > 0 && (
          <div className="cfg-mono">env: {s.envKeys.join(", ")}</div>
        )}
      </div>
    );
  };

  return (
    <div className="cfg-backdrop" onClick={onClose}>
      <div className="cfg-panel search-panel" onClick={(e) => e.stopPropagation()}>
        <div className="cfg-head">
          <h2>联网搜索</h2>
          <button className="cfg-close" onClick={onClose} title="关闭">
            ×
          </button>
        </div>

        <div className="cfg-body">
          {/* 搜索区 */}
          <section className="cfg-section">
            <div className="cfg-sec-head">
              <h3>网页搜索（REST）</h3>
              <button className="cfg-add" onClick={runSearch} disabled={busy}>
                搜索
              </button>
            </div>
            <input
              className="cfg-full"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runSearch()}
              placeholder="搜索内容"
            />
            <div className="cfg-row">
              <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                <option value="tavily">tavily</option>
                <option value="serper">serper</option>
              </select>
              <input
                className="cfg-key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="API Key（留空用环境变量）"
              />
              <input
                className="cfg-key"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="base_url（可选，指向网关/mock）"
              />
              <input
                className="cfg-key cfg-num"
                type="number"
                min={1}
                value={maxResults}
                onChange={(e) => setMaxResults(Number(e.target.value) || 5)}
                title="最多结果数"
              />
            </div>
            <div className="cfg-card">
              <div className="cfg-card-head">
                <span className="cfg-id">结果{respQuery ? `：${respQuery}` : ""}</span>
              </div>
              {results === null && <div className="cfg-hint">未执行搜索。</div>}
              {results !== null && results.length === 0 && (
                <div className="cfg-hint">无结果。</div>
              )}
              {results?.map((r, i) => (
                <div key={i} className="cfg-item">
                  <a href={r.url} target="_blank" rel="noreferrer" className="search-title">
                    {r.title || r.url}
                  </a>
                  <div className="search-url">{r.url}</div>
                  <div className="search-content">{r.content}</div>
                </div>
              ))}
            </div>
          </section>

          {/* MCP 注册区 */}
          <section className="cfg-section">
            <div className="cfg-sec-head">
              <h3>注册搜索 MCP（供 Agent 对话调用）</h3>
              <button className="cfg-add" onClick={register} disabled={busy}>
                注册
              </button>
            </div>
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="tavily">tavily</option>
              <option value="serper">serper</option>
            </select>
            <input
              className="cfg-full"
              value={mcpKey}
              onChange={(e) => setMcpKey(e.target.value)}
              placeholder="API Key（可选，写入 env）"
            />
            {renderServer("tavily", "tavily")}
            {renderServer("serper", "serper")}
            <div className="cfg-hint">
              注册后将写为 <code>[mcp_servers.tavily|serper]</code>，codex 下一个
              app-server 启动时自动拉起 web_search 工具。
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}