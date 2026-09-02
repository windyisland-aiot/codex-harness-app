//! v0.3.0 统一设置面板 — Trae Work 风格左侧 nav + 右侧内容。
//! 覆盖：账号 | 通用 | MCP | 会话 | 搜索 | 关于
//! （插件/Skill 管理已移至独立的 PluginsPanel，v0.5.3）
//! （模型板块已移除，v0.7.0 — URL/API Key 在后台硬编码注入）
//! 全部改动实时写 config.toml，保存后提示重启 codex 生效。

import { useEffect, useState } from "react";
import * as codex from "../codexClient";
import type { AppConfig, McpServerConfig, SessionMeta } from "../codexClient";

type NavKey = "account" | "general" | "mcp" | "sessions" | "search" | "about";

interface NavItem {
  key: NavKey;
  label: string;
  icon: JSX.Element;
}

const I = (path: JSX.Element) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{path}</svg>
);

const NAV: NavItem[] = [
  { key: "account",  label: "账号",   icon: I(<><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a8 8 0 0 1 16 0v1"/></>) },
  { key: "general",  label: "通用",   icon: I(<><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></>) },
  { key: "search",   label: "搜索",   icon: I(<><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></>) },
  { key: "sessions", label: "会话流", icon: I(<><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></>) },
  { key: "about",    label: "关于",   icon: I(<><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></>) },
];

export default function SettingsPanel({
  open, onClose, codexHome, codexBin,
  onStatus, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  codexHome: string;
  codexBin: string;
  onStatus: (s: string) => void;
  onSaved: () => void;
}) {
  const [nav, setNav] = useState<NavKey>("general");
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !codexHome) return;
    (async () => {
      try {
        const c = await codex.configRead(codexHome).catch(() => null as AppConfig | null);
        setCfg(c ?? null);
        setDirty(false);
      } catch (e) {
        onStatus(`读取设置失败：${e}`);
      }
    })();
  }, [open, codexHome]);

  if (!open) return null;

  // ---------- helpers ----------
  const defaultCfg = (): AppConfig => ({
    model: "", modelProvider: "", approvalPolicy: "on-request",
    modelProviders: [], mcpServers: [],
  });

  const saveAll = async () => {
    if (!cfg) return;
    setSaving(true);
    try {
      await codex.configWrite(codexHome, cfg);
      setDirty(false);
      try {
        await codex.restart({ codexBin, codexHome });
        onStatus("设置已保存，codex 已重启 ✅");
      } catch (e) {
        onStatus(`保存成功但重启 codex 失败：${e}（请手动重启应用）`);
      }
      onSaved();
    } catch (e) {
      onStatus(`保存失败：${e}`);
    } finally {
      setSaving(false);
    }
  };

  const patchCfg = (p: Partial<AppConfig>) => {
    setCfg((c) => ({ ...(c ?? defaultCfg()), ...p }));
    setDirty(true);
  };

  const updateMcp = (i: number, patch: Partial<McpServerConfig>) => {
    setCfg((c) => {
      const cur = c ?? defaultCfg();
      const next = cur.mcpServers.slice();
      next[i] = { ...next[i], ...patch };
      return { ...cur, mcpServers: next };
    });
    setDirty(true);
  };

  const addFeishu = () => {
    setCfg((c) => {
      const cur = c ?? defaultCfg();
      if (cur.mcpServers.some((m) => m.id === "feishu")) return cur;
      return {
        ...cur,
        mcpServers: [...cur.mcpServers, {
          id: "feishu", command: "lark-mcp",
          args: ["mcp", "-t", "preset.default,approval_v4", "-m", "stdio"],
          env: [], envVars: ["FEISHU_APP_ID", "FEISHU_APP_SECRET"], enabled: true,
        }],
      };
    });
    setDirty(true);
  };

  const addRag = () => {
    // 先在内存 cfg 里塞一个默认占位；保存后会走 rag_register 统一写（确保 args 结构与默认值与后端一致）。
    setCfg((c) => {
      const cur = c ?? defaultCfg();
      if (cur.mcpServers.some((m) => m.id === "rag")) return cur;
      return {
        ...cur,
        mcpServers: [...cur.mcpServers, {
          id: "rag",
          command: "./harness-rag-mcp",
          args: ["--base-url", "http://127.0.0.1:18763", "--default-collection", "harness_default", "--log-level", "info"],
          env: [],
          envVars: ["CHROMA_SERVER_AUTHN_CREDENTIALS", "CHROMA_SERVER_AUTHN_PROVIDER"],
          enabled: true,
        }],
      };
    });
    setDirty(true);
  };

  const addRagViaTauri = async () => {
    // 通过 tauri 端写入 config.toml，然后刷新内存 cfg；优点：与 RagMcpConfig 默认值保持一致
    try {
      const s = await codex.ragRegister({ codexHome });
      const fresh = await codex.configRead(codexHome);
      setCfg(fresh);
      setDirty(false);
      onStatus(`知识库 RAG 已注册：${s.baseUrl || "(默认)"} / collection=${s.collection || "harness_default"}`);
    } catch (e) {
      onStatus(`启用 RAG 失败：${e}`);
    }
  };

  const addBaseViaTauri = async () => {
    try {
      const s = await codex.baseRegisterMcp({ codexHome });
      const fresh = await codex.configRead(codexHome);
      setCfg(fresh);
      setDirty(false);
      onStatus(`飞书多维表格 MCP 已注册：${s.registered ? "已启用" : "未启用"} command=${s.command || "lark-mcp"}`);
    } catch (e) {
      onStatus(`启用 Base MCP 失败：${e}`);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => dirty ? null : onClose()}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        {/* 左侧 nav */}
        <aside className="sp-nav">
          <div className="sp-user">
            <div className="sp-avatar">H</div>
            <div>
              <div className="sp-user-name">Harness 用户</div>
              <div className="sp-user-sub">本地实例 · v0.5.4</div>
            </div>
          </div>
          <nav className="sp-nav-list">
            {NAV.map((n) => (
              <button
                key={n.key}
                className={`sp-nav-item ${nav === n.key ? "active" : ""}`}
                onClick={() => setNav(n.key)}
              >
                <span className="sp-nav-icon">{n.icon}</span>
                <span>{n.label}</span>
              </button>
            ))}
          </nav>
          <div className="sp-footer">
            {dirty && (
              <>
                <button className="sp-btn sp-btn-ghost" onClick={onClose}>取消</button>
                <button
                  className="sp-btn sp-btn-primary"
                  disabled={saving || !cfg}
                  onClick={saveAll}
                >{saving ? "保存中…" : "保存并重启"}</button>
              </>
            )}
            {!dirty && <button className="sp-btn sp-btn-ghost" onClick={onClose}>关闭</button>}
          </div>
        </aside>

        {/* 右侧内容 */}
        <section className="sp-content">
          <button className="sp-close" onClick={onClose}>×</button>
          {!cfg && <div className="sp-loading">加载中…</div>}
          {cfg && nav === "account" && <SectionAccount />}
          {cfg && nav === "general" && <SectionGeneral cfg={cfg} patch={patchCfg} />}
          {cfg && nav === "mcp" && (
            <SectionMcp
              cfg={cfg} patch={patchCfg} updateMcp={updateMcp}
              addFeishu={addFeishu}
              addRag={addRag}
              addRagViaTauri={addRagViaTauri}
              addBaseViaTauri={addBaseViaTauri}
              codexHome={codexHome}
              onStatus={onStatus}
            />
          )}
          {cfg && nav === "sessions" && <SectionSessions codexHome={codexHome} onStatus={onStatus} />}
          {cfg && nav === "search" && <SectionSearch cfg={cfg} patch={patchCfg} />}
          {cfg && nav === "about" && <SectionAbout codexHome={codexHome} codexBin={codexBin} />}
        </section>
      </div>
    </div>
  );
}

// ======================== section components ========================

function SectionAccount() {
  return (
    <div className="sp-section">
      <h2 className="sp-h">账号</h2>
      <p className="sp-desc">Harness 本地实例暂未接入账号体系。后续可在此接入飞书/企业 SSO 登录。</p>
      <div className="sp-card">
        <div>
          <div className="sp-label">当前身份</div>
          <div>本地用户（未认证）</div>
        </div>
        <div>
          <div className="sp-label">版本</div>
          <div>0.3.0</div>
        </div>
      </div>
    </div>
  );
}

function SectionGeneral({ cfg, patch }: { cfg: AppConfig; patch: (p: Partial<AppConfig>) => void }) {
  const policies = ["never", "on-request", "on-failure"];
  return (
    <div className="sp-section">
      <h2 className="sp-h">通用</h2>
      <p className="sp-desc">审批策略控制 codex 执行命令/写文件前是否弹窗确认。</p>
      <div className="sp-card">
        <div className="sp-row">
          <label className="sp-label">审批策略</label>
          <select
            className="sp-input"
            value={cfg.approvalPolicy}
            onChange={(e) => patch({ approvalPolicy: e.target.value })}
          >
            {policies.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <span className="sp-hint">on-request: 每次审批</span>
        </div>
      </div>
    </div>
  );
}

function SectionMcp({
  cfg, patch, updateMcp, addFeishu, addRag, addRagViaTauri, addBaseViaTauri, codexHome, onStatus,
}: {
  cfg: AppConfig;
  patch: (p: Partial<AppConfig>) => void;
  updateMcp: (i: number, p: Partial<McpServerConfig>) => void;
  addFeishu: () => void;
  addRag: () => void;
  addRagViaTauri: () => void;
  addBaseViaTauri: () => void;
  codexHome: string;
  onStatus: (s: string) => void;
}) {
  const rag = cfg.mcpServers.find((m) => m.id === "rag");
  const ragBase = rag
    ? (rag.args[rag.args.findIndex((a) => a === "--base-url") + 1] || undefined)
    : undefined;
  const base = cfg.mcpServers.find((m) => m.id === "base");

  const [ragHealth, setRagHealth] = useState<{ ok: boolean; message: string; hint?: string; checking: boolean } | null>(null);
  const [baseHealth, setBaseHealth] = useState<{ ok: boolean; message: string; hint?: string; checking: boolean } | null>(null);
  const checkRagHealth = async (base?: string) => {
    setRagHealth({ checking: true, ok: false, message: "检查中…" });
    try {
      const r = await codex.ragHealth(base);
      setRagHealth({ checking: false, ok: r.ok, message: r.message, hint: r.hint });
    } catch (e) {
      setRagHealth({ checking: false, ok: false, message: `健康检查调用失败：${e}` });
    }
  };
  const checkBaseHealth = async () => {
    setBaseHealth({ checking: true, ok: false, message: "检查中…" });
    try {
      const r = await codex.baseHealth();
      setBaseHealth({ checking: false, ok: r.ok, message: r.message, hint: r.hint });
    } catch (e) {
      setBaseHealth({ checking: false, ok: false, message: `健康检查调用失败：${e}` });
    }
  };

  return (
    <div className="sp-section">
      <h2 className="sp-h">MCP Server</h2>
      <p className="sp-desc">Codex 启动时会自动拉起已启用的 MCP server（stdio 模式）。</p>
      <div className="sp-actions">
        <button className="sp-btn sp-btn-ghost" onClick={addFeishu}>+ 注册飞书 MCP（lark-mcp）</button>
        <button className="sp-btn sp-btn-primary" onClick={async () => { await addBaseViaTauri(); checkBaseHealth(); }}>
          ✓ 启用飞书多维表格 Base（推荐）
        </button>
        <button className="sp-btn sp-btn-ghost" onClick={() => { addRag(); checkRagHealth(ragBase); }}>
          + 启用知识库 RAG（Chroma 18763，内存配置）
        </button>
        <button className="sp-btn sp-btn-primary" onClick={async () => { await addRagViaTauri(); checkRagHealth(); }}>
          ✓ 立即写入配置并启用 RAG（推荐）
        </button>
      </div>

      {base && (
        <div className={`sp-mcp-health-card ${baseHealth?.ok ? "ok" : baseHealth?.ok === false && !baseHealth?.checking ? "bad" : ""}`}>
          <div className="sp-h-label">
            <strong>飞书多维表格 Base 健康</strong>
            <span style={{ color: "#6B7280", fontSize: 12, marginLeft: 10 }}>
              command = {base.command || "lark-mcp"}
            </span>
          </div>
          <div className="sp-mcp-health-line">
            {!baseHealth || baseHealth.checking ? (
              <span style={{ color: "#6B7280" }}>未检查 · </span>
            ) : (
              <span style={{ color: baseHealth.ok ? "#10B981" : "#DC2626", fontWeight: 600 }}>
                {baseHealth.ok ? "● 凭据可联通" : "● 凭据未配置"}
              </span>
            )}
            <span>{baseHealth?.message || ""}</span>
          </div>
          {baseHealth?.hint && (
            <pre className="sp-code" style={{ marginTop: 6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {baseHealth.hint}
            </pre>
          )}
          <div className="sp-mcp-health-actions">
            <button className="sp-btn sp-btn-ghost" onClick={checkBaseHealth}>
              {baseHealth?.checking ? "检查中…" : "重新检查"}
            </button>
          </div>
        </div>
      )}

      {rag && (
        <div className={`sp-mcp-health-card ${ragHealth?.ok ? "ok" : ragHealth?.ok === false && !ragHealth?.checking ? "bad" : ""}`}>
          <div className="sp-h-label">
            <strong>Chroma 健康</strong>
            <span style={{ color: "#6B7280", fontSize: 12, marginLeft: 10 }}>
              base = {ragBase || "http://127.0.0.1:18763"}
            </span>
          </div>
          <div className="sp-mcp-health-line">
            {!ragHealth || ragHealth.checking ? (
              <span style={{ color: "#6B7280" }}>未检查 · </span>
            ) : (
              <span style={{ color: ragHealth.ok ? "#10B981" : "#DC2626", fontWeight: 600 }}>
                {ragHealth.ok ? "● Chroma 正常" : "● 未启动"}
              </span>
            )}
            <span>{ragHealth?.message || ""}</span>
          </div>
          {ragHealth?.hint && (
            <pre className="sp-code" style={{ marginTop: 6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {ragHealth.hint}
            </pre>
          )}
          <div className="sp-mcp-health-actions">
            <button className="sp-btn sp-btn-ghost" onClick={() => checkRagHealth(ragBase)}>
              {ragHealth?.checking ? "检查中…" : "重新检查"}
            </button>
          </div>
        </div>
      )}

      {/* T5 知识库入库 + 检索测试（当 rag 已注册时显示） */}
      {rag && (
        <div className="sp-card">
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: "#111827", margin: 0 }}>
              📚 知识库入库 & 检索测试
            </h3>
            <span style={{ fontSize: 12, color: "#6B7280" }}>
              collection = {rag.args[rag.args.findIndex((a) => a === "--default-collection") + 1] || "harness_default"}
            </span>
          </div>

          <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 8 }}>
            粘贴 Markdown 文本 → 预览分块；真实入库需在终端跑 <code style={{ background: "#F3F4F6", padding: "1px 5px", borderRadius: 4 }}>harness-rag-mcp ingest --file ...md</code>（避免前端持有 embedding API key）。
          </div>

          <RagIngestTest
            codexHome={codexHome}
            baseUrl={ragBase}
            collection={rag.args[rag.args.findIndex((a) => a === "--default-collection") + 1]}
            onStatus={onStatus}
          />
        </div>
      )}

      <div className="sp-card">
        {cfg.mcpServers.length === 0 ? (
          <div className="sp-empty">还没有 MCP server。</div>
        ) : cfg.mcpServers.map((m, i) => (
          <div key={m.id} className="sp-mcp-row">
            <div>
              <input className="sp-input sp-input-sm" value={m.id} onChange={(e) => updateMcp(i, { id: e.target.value })} />
              <input className="sp-input sp-input-sm" value={m.command} onChange={(e) => updateMcp(i, { command: e.target.value })} placeholder="可执行文件" />
              <input className="sp-input sp-input-sm" value={m.args.join(" ")} onChange={(e) => updateMcp(i, { args: e.target.value.split(/\s+/).filter(Boolean) })} placeholder="参数" />
            </div>
            <label className="sp-switch">
              <input type="checkbox" checked={m.enabled} onChange={(e) => updateMcp(i, { enabled: e.target.checked })} />
              <span>{m.enabled ? "启用" : "停用"}</span>
            </label>
            <button className="sp-link sp-link-danger" onClick={() => patch({ mcpServers: cfg.mcpServers.filter((_, k) => k !== i) })}>删除</button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** T5 · 知识库入库预览 + rag_search 检索测试面板。
 *  说明：
 *  - 「真实入库」（分块→embed→upsert 到 Chroma）需要 embedding API key，
 *    为避免前端持有密钥，该步骤交给 harness-rag-mcp CLI 在本地终端执行；
 *    前端这里只做「分块预览」（纯 JS）和「检索结果显示」（通过 tauri rag_search）。
 *  - 为了与 Rust `chunk_markdown` 语义对齐，前端按「字符数」简单做带 overlap 的切块。
 */
function RagIngestTest({
  codexHome,
  baseUrl,
  collection,
  onStatus,
}: {
  codexHome: string;
  baseUrl?: string;
  collection?: string;
  onStatus: (s: string) => void;
}) {
  const [sampleMd, setSampleMd] = useState(
    "# 品牌话术示例\n\n" +
    "本品牌主打 0-3 岁婴儿辅食，强调「非转基因、零添加、工厂直供、48h 发货」。\n\n" +
    "## 竞品分析\n\n" +
    "A 竞品：主打有机，但价格高 20%；\n" +
    "B 竞品：主打进口，但物流慢；\n" +
    "C 竞品：价格更低，但评论反馈包装易损坏。\n\n" +
    "## 历史脚本案例 2024Q3\n\n" +
    "【Hook】你还在为宝宝吃什么发愁吗？3 秒告诉你一个妈妈的小秘密。\n" +
    "【卖点】0 添加、48h 发货、19.9 起。\n" +
    "【CTA】左下角小黄车直接带走。\n"
  );
  const [chunkChars, setChunkChars] = useState(600);
  const [overlap, setOverlap] = useState(60);
  const [chunks, setChunks] = useState<string[]>([]);

  const chunkMd = (src: string, n: number, ov: number) => {
    if (!src.trim() || n <= 0) return [] as string[];
    const chars = Array.from(src);
    if (chars.length <= n) return [src];
    const step = Math.max(1, n - Math.min(ov, n - 1));
    const out: string[] = [];
    let s = 0;
    while (s < chars.length) {
      const e = Math.min(s + n, chars.length);
      out.push(chars.slice(s, e).join(""));
      if (e >= chars.length) break;
      s += step;
    }
    return out;
  };

  useEffect(() => {
    setChunks(chunkMd(sampleMd, chunkChars, overlap));
  }, [sampleMd, chunkChars, overlap]);

  const [query, setQuery] = useState("品牌 卖点 历史脚本");
  const [topK, setTopK] = useState(5);
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<codex.RagSearchResult | { err: string } | null>(null);

  const runSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setSearchResult(null);
    try {
      const r = await codex.ragSearch({ codexHome, baseUrl, collection, query, topK });
      setSearchResult(r);
      onStatus(`RAG 检索完成：${r.hits.length} 条命中（collection=${r.collection}）`);
    } catch (e) {
      setSearchResult({ err: `检索失败：${e}` });
    } finally {
      setSearching(false);
    }
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 2 }}>
      {/* 左：入库 / 分块预览 */}
      <div>
        <label className="sp-label">Markdown 文本（粘贴或编辑）</label>
        <textarea
          className="sp-input"
          style={{ minHeight: 150, resize: "vertical", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }}
          value={sampleMd}
          onChange={(e) => setSampleMd(e.target.value)}
        />
        <div style={{ display: "flex", gap: 10, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span className="sp-label" style={{ margin: 0 }}>分块字符数</span>
            <input className="sp-input sp-input-sm" type="number" min={50} step={50}
              value={chunkChars}
              onChange={(e) => setChunkChars(Math.max(50, parseInt(e.target.value || "0", 10)))}
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span className="sp-label" style={{ margin: 0 }}>重叠</span>
            <input className="sp-input sp-input-sm" type="number" min={0} step={20}
              value={overlap}
              onChange={(e) => setOverlap(Math.max(0, parseInt(e.target.value || "0", 10)))}
            />
          </div>
          <span style={{ fontSize: 12, color: "#6B7280", marginLeft: "auto" }}>
            共 {chunks.length} 块 · 总字符 {Array.from(sampleMd).length}
          </span>
        </div>
        <div className="sp-code" style={{
          marginTop: 10,
          background: "#fff",
          maxHeight: 200,
          overflow: "auto",
          padding: 10,
        }}>
          {chunks.length === 0 ? <div style={{ color: "#9CA3AF" }}>（无内容）</div> : chunks.map((c, i) => (
            <div key={i} style={{
              borderTop: i === 0 ? "none" : "1px dashed #E5E7EB",
              paddingTop: i === 0 ? 0 : 6,
              marginTop: i === 0 ? 0 : 6,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontSize: 11,
              color: "#374151",
              lineHeight: 1.5,
            }}>
              <strong style={{ color: "#111827" }}>【块 {i + 1}】 len={Array.from(c).length}</strong>{"\n"}
              {c.length > 180 ? `${c.slice(0, 180)}…` : c}
            </div>
          ))}
        </div>
      </div>

      {/* 右：rag_search 检索测试 */}
      <div>
        <label className="sp-label">检索 Query（Chroma top-k 相似度）</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input className="sp-input sp-input-sm" value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="品牌话术 / 竞品 / 卖点..."
          />
          <input className="sp-input sp-input-sm" style={{ width: 70 }} type="number" min={1} max={30}
            value={topK}
            onChange={(e) => setTopK(Math.max(1, parseInt(e.target.value || "5", 10)))}
          />
          <button className="sp-btn sp-btn-primary" onClick={runSearch} disabled={searching}>
            {searching ? "检索中…" : "🔎 检索"}
          </button>
        </div>
        <div className="sp-code" style={{
          marginTop: 10,
          background: "#fff",
          maxHeight: 280,
          overflow: "auto",
          padding: 10,
          minHeight: 150,
        }}>
          {searching && <div style={{ color: "#2563EB" }}>正在通过 tauri::rag_search 调用 Chroma…</div>}
          {!searching && searchResult && ("err" in searchResult) && (
            <div style={{ color: "#B91C1C" }}>{searchResult.err}</div>
          )}
          {!searching && searchResult && ("hits" in searchResult) && (
            searchResult.hits.length === 0 ? (
              <div style={{ color: "#9CA3AF" }}>未命中。请先跑 ingest 入库（见上方命令）。</div>
            ) : searchResult.hits.map((h, i) => (
              <div key={h.id || String(i)} style={{
                padding: "6px 0",
                borderTop: i === 0 ? "none" : "1px dashed #E5E7EB",
              }}>
                <div style={{ fontSize: 11, color: "#6B7280" }}>
                  #{i + 1} distance={(h.distance ?? 0).toFixed(4)} · id=<code>{h.id}</code>
                </div>
                <div style={{
                  marginTop: 3,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontSize: 12,
                  lineHeight: 1.55,
                  color: "#111827",
                }}>{h.document}</div>
              </div>
            ))
          )}
          {!searching && !searchResult && (
            <div style={{ color: "#9CA3AF" }}>点击「检索」查看 Chroma 返回结果。</div>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionSessions({ codexHome, onStatus }: { codexHome: string; onStatus: (s: string) => void }) {
  const [list, setList] = useState<SessionMeta[]>([]);
  useEffect(() => {
    codex.sessionList(codexHome).then(setList).catch((e) => onStatus(`会话列表失败：${e}`));
  }, [codexHome]);
  return (
    <div className="sp-section">
      <h2 className="sp-h">历史会话</h2>
      <div className="sp-card">
        {list.length === 0 ? <div className="sp-empty">暂无历史。</div> : list.map((s) => (
          <div key={s.id} className="sp-row sp-row-line">
            <div>
              <div>{s.title}</div>
              <div className="sp-sub">{s.id} · {s.provider ?? ""} · {s.model ?? ""}</div>
            </div>
            <div className="sp-sub">{s.updatedAt ? new Date(s.updatedAt).toLocaleString() : ""}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SectionSearch({ cfg, patch: _patch }: { cfg: AppConfig; patch: (p: Partial<AppConfig>) => void }) {
  return (
    <div className="sp-section">
      <h2 className="sp-h">搜索</h2>
      <p className="sp-desc">搜索 provider 的 API key 目前由全局 `TAVILY_API_KEY` / `SERPER_API_KEY` 环境变量提供，不在本面板直接管理。</p>
      <pre className="sp-code">{JSON.stringify(cfg, null, 2)}</pre>
    </div>
  );
}

function SectionAbout({ codexHome, codexBin }: { codexHome: string; codexBin: string }) {
  return (
    <div className="sp-section">
      <h2 className="sp-h">关于 Harness</h2>
      <p className="sp-desc">基于 OpenAI Codex 的企业内部 Agent 桌面应用。v0.5.4</p>
      <div className="sp-card">
        <div className="sp-row"><div className="sp-label">codexHome</div><div className="sp-code">{codexHome}</div></div>
        <div className="sp-row"><div className="sp-label">codexBin</div><div className="sp-code">{codexBin}</div></div>
      </div>
    </div>
  );
}
