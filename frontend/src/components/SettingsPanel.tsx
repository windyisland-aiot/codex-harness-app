//! v0.3.0 统一设置面板 — Trae Work 风格左侧 nav + 右侧内容。
//! 覆盖：账号 | 通用 | 模型 | MCP | 会话 | 搜索 | 插件&Skill | 关于
//! 全部改动实时写 config.toml + .env-provider，保存后提示重启 codex 生效。

import { useEffect, useState } from "react";
import * as codex from "../codexClient";
import type { AppConfig, ProviderConfig, McpServerConfig, SessionMeta, PluginsList, SkillInfo } from "../codexClient";

type NavKey = "account" | "general" | "models" | "mcp" | "sessions" | "search" | "plugins" | "about";

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
  { key: "models",   label: "模型",   icon: I(<><path d="M4 7h16M4 12h16M4 17h10"/></>) },
  { key: "search",   label: "搜索",   icon: I(<><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></>) },
  { key: "plugins",  label: "插件/Skill", icon: I(<><path d="M12 2 2 7v10l10 5 10-5V7z"/><path d="M2 7l10 5 10-5"/><path d="M12 22V12"/></>) },
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
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!open || !codexHome) return;
    (async () => {
      try {
        const [c, k] = await Promise.all([
          codex.configRead(codexHome).catch(() => null as AppConfig | null),
          codex.credsRead(codexHome).catch(() => ({} as Record<string, string>)),
        ]);
        setCfg(c ?? null);
        setCreds(k);
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
      await codex.credsWrite(codexHome, creds);
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

  const updateProvider = (i: number, patch: Partial<ProviderConfig>) => {
    setCfg((c) => {
      const cur = c ?? defaultCfg();
      const next = cur.modelProviders.slice();
      next[i] = { ...next[i], ...patch };
      return { ...cur, modelProviders: next };
    });
    setDirty(true);
  };

  const addProvider = () => {
    setCfg((c) => {
      const cur = c ?? defaultCfg();
      const next = cur.modelProviders.slice();
      const isFirst = next.length === 0;
      // 生成唯一的 envKey（避免冲突）
      let envKey = "ARK_API_KEY";
      let counter = 1;
      while (next.some((p) => p.envKey === envKey)) {
        envKey = `ARK_API_KEY_${counter++}`;
      }
      const newProvider: ProviderConfig = {
        id: `p-${Date.now()}`,
        name: "新模型",
        type: "Custom",
        baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
        envKey,
        wireApi: "responses",
      };
      next.push(newProvider);
      // 如果是第一个 provider，自动设为默认
      return {
        ...cur,
        modelProviders: next,
        modelProvider: isFirst ? newProvider.id : cur.modelProvider || newProvider.id,
        model: cur.model || "ark-code-latest",
      };
    });
    setDirty(true);
  };

  const delProvider = (i: number) => {
    setCfg((c) => {
      const cur = c ?? defaultCfg();
      const removed = cur.modelProviders[i];
      const next = cur.modelProviders.filter((_, k) => k !== i);
      // 如果删除的是当前默认 provider，自动切到第一个剩余的
      let newDefaultProvider = cur.modelProvider;
      if (removed && cur.modelProvider === removed.id && next.length > 0) {
        newDefaultProvider = next[0].id;
      }
      return {
        ...cur,
        modelProviders: next,
        modelProvider: newDefaultProvider,
      };
    });
    setDirty(true);
  };

  const selectAsDefault = (i: number) => {
    setCfg((c) => {
      const cur = c ?? defaultCfg();
      const p = cur.modelProviders[i];
      if (!p) return cur;
      return { ...cur, modelProvider: p.id };
    });
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
              <div className="sp-user-sub">本地实例 · v0.5.1</div>
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
          {cfg && nav === "models" && (
            <SectionModels
              cfg={cfg} creds={creds} setCreds={(k) => { setCreds(k); setDirty(true); }}
              showKey={showKey} setShowKey={setShowKey}
              updateProvider={updateProvider} addProvider={addProvider}
              delProvider={delProvider} selectAsDefault={selectAsDefault}
            />
          )}
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
          {nav === "plugins" && (
            <SectionPlugins
              codexHome={codexHome}
              onStatus={onStatus}
              onSaved={onSaved}
            />
          )}
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
      <p className="sp-desc">默认模型名用于与默认供应商配合调用 LLM。审批策略控制 codex 执行命令/写文件前是否弹窗确认。</p>
      <div className="sp-card">
        <div className="sp-row">
          <label className="sp-label">默认模型名</label>
          <input
            className="sp-input"
            value={cfg.model}
            onChange={(e) => patch({ model: e.target.value })}
            placeholder="ark-code-latest"
          />
          <span className="sp-hint">当前默认供应商: <code>{cfg.modelProvider || "(未设置)"}</code></span>
        </div>
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

function SectionModels({
  cfg, creds, setCreds, showKey, setShowKey,
  updateProvider, addProvider, delProvider, selectAsDefault,
}: {
  cfg: AppConfig;
  creds: Record<string, string>;
  setCreds: (k: Record<string, string>) => void;
  showKey: Record<string, boolean>;
  setShowKey: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  updateProvider: (i: number, p: Partial<ProviderConfig>) => void;
  addProvider: () => void;
  delProvider: (i: number) => void;
  selectAsDefault: (i: number) => void;
}) {
  const hasProviders = cfg.modelProviders.length > 0;
  const currentProvider = cfg.modelProviders.find((p) => p.id === cfg.modelProvider);

  // ---------- 编辑弹窗：null = 关闭，数字 = 正在编辑的 provider index ----------
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const isNew = editIdx === -1;

  // 点击 + 添加模型：先创建一个空 provider 模板，然后打开编辑
  function handleAddAndEdit() {
    addProvider(); // 创建并推入 modelProviders
    // 下一个 tick 时最后一个元素就是新的
    setTimeout(() => setEditIdx(cfg.modelProviders.length), 0);
  }

  // ---------- SVG 图标 helpers（inline 无依赖） ----------
  const IcPencil = (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
    </svg>
  );
  const IcTrash = (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>
    </svg>
  );
  const IcCheck = (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );

  function displayName(p: ProviderConfig) {
    return p.name && p.name.trim() ? p.name : p.id || "(未命名)";
  }
  function avatarLetter(p: ProviderConfig) {
    const n = displayName(p).trim();
    return n ? n.charAt(0).toUpperCase() : "?";
  }

  const editing = (editIdx !== null && editIdx >= 0) ? cfg.modelProviders[editIdx] : null;
  const editingCredsKey = editing?.envKey ?? "";

  return (
    <div className="sp-section">
      <h2 className="sp-h">模型</h2>
      <p className="sp-desc">
        模型管理 · 配置 API Key 添加更多可用模型，预置模型默认使用稳定版本。
      </p>

      <div className="sp-current-hint" style={{
        background: "transparent",
        padding: "0 0 12px",
        border: "none",
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}>
        <div style={{ fontSize: 12, color: "#6B7280" }}>
          当前默认模型：<strong style={{ color: "#111827", fontWeight: 600 }}>{cfg.model || "ark-code-latest"}</strong>
          <span style={{ margin: "0 6px" }}>·</span>
          供应商：<strong style={{ color: "#111827", fontWeight: 600 }}>{currentProvider ? `${currentProvider.name} (${currentProvider.id})` : "(未设置)"}</strong>
        </div>
      </div>

      <button className="sp-btn sp-btn-ghost sp-add-btn" onClick={handleAddAndEdit}>+ 添加模型</button>

      <table className="tw-model-table">
        <thead>
          <tr>
            <th>模型</th>
            <th>服务商</th>
            <th style={{ width: 150, textAlign: "right" }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {!hasProviders && (
            <tr className="tw-empty-row">
              <td colSpan={3}>还没有模型，点上方「+ 添加模型」开始。</td>
            </tr>
          )}
          {cfg.modelProviders.map((p, i) => {
            const isDefault = cfg.modelProvider === p.id;
            return (
              <tr key={p.id} className={isDefault ? "is-default" : ""}>
                <td>
                  <div className="tw-model-cell">
                    <div className={`tw-model-icon ${isDefault ? "" : "off"}`} title={isDefault ? "默认供应商" : "非默认"}>
                      {avatarLetter(p)}
                    </div>
                    <div className="tw-model-main">
                      <span className="tw-model-name">
                        {isDefault && (
                          <span title="默认供应商" style={{
                            display: "inline-block",
                            marginRight: 6,
                            color: "#10B981",
                            verticalAlign: "middle",
                          }}>{IcCheck}</span>
                        )}
                        {cfg.model || "ark-code-latest"}
                      </span>
                      <span className="tw-model-id">{p.id} · {p.baseUrl.replace(/^https?:\/\//, "")}</span>
                    </div>
                  </div>
                </td>
                <td>
                  <span className="tw-provider-name">
                    {displayName(p)}
                  </span>
                </td>
                <td>
                  <div className="tw-model-actions">
                    <button
                      className="tw-icon-btn"
                      title="编辑"
                      onClick={() => setEditIdx(i)}
                    >{IcPencil}</button>
                    <button
                      className="tw-icon-btn danger"
                      title="删除"
                      onClick={() => {
                        if (!confirm(`确认删除供应商「${displayName(p)}」？`)) return;
                        delProvider(i);
                      }}
                    >{IcTrash}</button>
                    {/* 默认开关：toggle */}
                    <button
                      type="button"
                      className={`tw-toggle ${isDefault ? "on" : ""}`}
                      title={isDefault ? "当前为默认供应商" : "设为默认供应商"}
                      onClick={() => !isDefault && selectAsDefault(i)}
                      aria-label="toggle default"
                    >
                      <span className="tw-toggle-track" />
                      <span className="tw-toggle-thumb" />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* ---------- 编辑弹窗 ---------- */}
      {editing && (
        <div className="modal-backdrop" onClick={() => setEditIdx(null)}>
          <div
            className="modal-card modal-dialog edit-model-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <h3>{isNew ? "添加模型" : `编辑模型 · ${displayName(editing)}`}</h3>
              <button className="modal-close" onClick={() => setEditIdx(null)}>×</button>
            </div>
            <div className="modal-body edit-model-form">
              <div className="two-col">
                <div className="form-block">
                  <label>名称（显示用）</label>
                  <input
                    className="sp-input sp-input-sm"
                    value={editing.name}
                    onChange={(e) => updateProvider(editIdx!, { name: e.target.value })}
                    placeholder="火山方舟 Ark Code"
                  />
                </div>
                <div className="form-block">
                  <label>Provider ID</label>
                  <input
                    className="sp-input sp-input-sm sp-input-code"
                    value={editing.id}
                    onChange={(e) => updateProvider(editIdx!, { id: e.target.value })}
                    placeholder="volcengine-ark"
                  />
                  <div className="sp-hint">唯一标识，Codex 配置里引用这个 ID。</div>
                </div>
              </div>

              <div className="form-block">
                <label>Base URL</label>
                <input
                  className="sp-input sp-input-sm sp-input-code"
                  value={editing.baseUrl}
                  onChange={(e) => updateProvider(editIdx!, { baseUrl: e.target.value })}
                  placeholder="https://ark.cn-beijing.volces.com/api/coding/v3"
                />
                <div className="sp-hint">
                  Coding Plan 企业版 Responses 协议：<code>https://ark.cn-beijing.volces.com/api/coding/v3</code>
                </div>
              </div>

              <div className="two-col">
                <div className="form-block">
                  <label>wire_api</label>
                  <select
                    className="sp-input sp-input-sm"
                    value={editing.wireApi}
                    onChange={(e) => updateProvider(editIdx!, { wireApi: e.target.value })}
                  >
                    <option value="responses">responses（推荐）</option>
                    <option value="chat">chat（兼容）</option>
                  </select>
                </div>
                <div className="form-block">
                  <label>env_key（API Key 变量名）</label>
                  <input
                    className="sp-input sp-input-sm sp-input-code"
                    value={editing.envKey}
                    onChange={(e) => updateProvider(editIdx!, { envKey: e.target.value })}
                    placeholder="VOLCENGINE_ARK_API_KEY"
                  />
                </div>
              </div>

              <div className="form-block">
                <label>API Key</label>
                <div className="sp-key-wrap" style={{ maxWidth: "none" }}>
                  <input
                    className="sp-input sp-input-sm"
                    type={showKey[editingCredsKey] ? "text" : "password"}
                    placeholder={creds[editingCredsKey] ? "•••••• 已填" : "粘贴 Coding Plan 控制台生成的专属 API Key"}
                    value={creds[editingCredsKey] ?? ""}
                    onChange={(e) => setCreds({ ...creds, [editingCredsKey]: e.target.value })}
                  />
                  <button
                    type="button"
                    className="sp-key-toggle"
                    onClick={() => setShowKey((s) => ({ ...s, [editingCredsKey]: !s[editingCredsKey] }))}
                  >{showKey[editingCredsKey] ? "隐藏" : "显示"}</button>
                </div>
              </div>

              <div className="modal-footer">
                <button className="sp-btn sp-btn-ghost" onClick={() => setEditIdx(null)}>取消</button>
                <button
                  className="sp-btn sp-btn-primary"
                  onClick={() => setEditIdx(null)}
                >完成</button>
              </div>
            </div>
          </div>
        </div>
      )}
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
              <strong style={{ color: "#4F46E5" }}>【块 {i + 1}】 len={Array.from(c).length}</strong>{"\n"}
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
      <p className="sp-desc">基于 OpenAI Codex 的企业内部 Agent 桌面应用。v0.5.1</p>
      <div className="sp-card">
        <div className="sp-row"><div className="sp-label">codexHome</div><div className="sp-code">{codexHome}</div></div>
        <div className="sp-row"><div className="sp-label">codexBin</div><div className="sp-code">{codexBin}</div></div>
      </div>
    </div>
  );
}

/**
 * 插件 & Skill 管理（设置面板内容区，风格与其它 sp- section 一致）。
 * 与现有 PluginsPanel.tsx 等价，但去掉了模态背景/关闭按钮，改为设置面板内嵌。
 *
 * 功能：
 *  - 自动扫描 Harness 工作区 `.codex/skills`（包含 feishu-bot 等内置 Skill）
 *  - 分组显示「内置 / 工作区 / 自定义」，checkbox 切换启用 → 即时写回 config.toml
 *  - 自添加 skill：粘贴一个"包含 SKILL.md 的目录"路径 → 注册到 skill 搜索路径
 *  - 全局开关：启用内置 skills；刷新扫描
 */
function SectionPlugins({
  codexHome,
  onStatus,
  onSaved,
}: {
  codexHome: string;
  onStatus: (s: string) => void;
  onSaved?: () => void;
}) {
  const [list, setList] = useState<PluginsList | null>(null);
  const [busy, setBusy] = useState(false);
  const [skillRootsText, setSkillRootsText] = useState("");
  const [pluginRootsText, setPluginRootsText] = useState("");
  const [customSkillDir, setCustomSkillDir] = useState("");

  // 每次 codexHome 就绪自动拉一次；也允许手动刷新
  useEffect(() => {
    if (!codexHome) return;
    // 默认扫描：当前仓库的 .codex/skills（含 feishu-bot）、codex 工作区、用户 HOME/.codex/skills。
    // 这里用相对 / 绝对路径组合，远端 (Tauri) 对不存在的目录会静默跳过。
    const defaults = [
      // Harness 仓库内置 skill（包含 feishu-bot）：相对仓库根目录下的 .codex/skills
      ".codex/skills",
      // Harness 仓库根目录（Windows/Linux 安装后 resources/ 下会放一份）
      "/workspace/codex-harness-app/.codex/skills",
      // 用户级 codex 工作区
      `${codexHome}/.codex/skills`,
      // codex-rs 内置 skills 目录（fork 仓库里的标准位置）
      "/workspace/codex/codex-rs/skills",
    ];
    // 回填 UI 中的 skill roots 文本
    setSkillRootsText(defaults.filter(Boolean).join("\n"));
    setPluginRootsText(`${codexHome}/.codex/plugins`);

    codex
      .pluginsList({
        codexHome,
        skillRoots: defaults.filter(Boolean),
        pluginRoots: [`${codexHome}/.codex/plugins`],
      })
      .then((l) => {
        // 对 feishu / 飞书相关 skill 默认启用（用户要求"把飞书 Skill 加进插件管理界面"）
        const skills = l.skills.map((s) => {
          const hit = /feishu|飞书|lark/i.test(s.name) || /feishu|feishu-bot|lark/i.test(s.dir);
          return hit ? { ...s, enabled: true } : s;
        });
        setList({ ...l, skills });
      })
      .catch((e) => {
        onStatus(`扫描 skills 失败：${e}（本地用占位数据展示）`);
        setList({
          skills: [
            {
              name: "feishu-bot",
              description: "飞书消息 / 文档 / 审批（Harness 内置）",
              dir: `${codexHome}/.codex/skills/feishu-bot`,
              enabled: true,
            },
          ],
          plugins: [],
          bundledSkillsEnabled: true,
          skillsIncludeInstructions: null,
        });
      });
  }, [codexHome]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!list) return <div className="sp-loading">扫描 skills / 插件…</div>;

  const parseRoots = (s: string) =>
    s
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);

  async function refresh() {
    setBusy(true);
    try {
      const l = await codex.pluginsList({
        codexHome,
        skillRoots: parseRoots(skillRootsText),
        pluginRoots: parseRoots(pluginRootsText),
      });
      // 刷新时同样确保飞书类默认启用
      const skills = l.skills.map((s) => {
        const hit = /feishu|飞书|lark/i.test(s.name) || /feishu|feishu-bot|lark/i.test(s.dir);
        return hit && !s.enabled ? { ...s, enabled: true } : s;
      });
      setList({ ...l, skills });
      onStatus("已刷新 skills / 插件列表");
    } catch (e) {
      onStatus(`刷新失败：${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function save(l: PluginsList) {
    setBusy(true);
    try {
      const plugins: Record<string, boolean> = {};
      for (const p of l.plugins) plugins[p.id] = p.enabled;
      await codex.pluginsApply({
        codexHome,
        skills: l.skills.map((s) => ({ name: s.name, path: s.dir, enabled: s.enabled })),
        plugins,
        bundledSkillsEnabled: l.bundledSkillsEnabled,
        skillsIncludeInstructions: l.skillsIncludeInstructions,
      });
      onStatus("已写回 config.toml（需重启 codex 生效）");
      onSaved?.();
    } catch (e) {
      onStatus(`保存失败：${e}`);
    } finally {
      setBusy(false);
    }
  }

  function toggleSkill(i: number, enabled: boolean) {
    if (!list) return;
    const next = {
      ...list,
      skills: list.skills.map((s, k) => (k === i ? { ...s, enabled } : s)),
    };
    setList(next);
    save(next);
  }
  function togglePlugin(i: number, enabled: boolean) {
    if (!list) return;
    const next = {
      ...list,
      plugins: list.plugins.map((p, k) => (k === i ? { ...p, enabled } : p)),
    };
    setList(next);
    save(next);
  }

  async function addCustomSkill() {
    const dir = customSkillDir.trim();
    if (!dir) return;
    setBusy(true);
    try {
      await codex.pluginsAddSkillDir(codexHome, dir, true);
      setCustomSkillDir("");
      await refresh();
      onStatus(`已注册自定义 skill 目录：${dir}`);
    } catch (e) {
      onStatus(`添加失败：${e}`);
    } finally {
      setBusy(false);
    }
  }

  const grouped: Record<string, SkillInfo[]> = { "内置 Skills": [], "工作区 Skills": [], "自定义 Skills": [] };
  for (const s of list.skills) {
    let key: keyof typeof grouped = "自定义 Skills";
    if (/codex-rs\/skills/.test(s.dir)) key = "内置 Skills";
    else if (/\.codex\/skills/.test(s.dir)) key = "工作区 Skills";
    (grouped[key] ||= []).push(s);
  }
  // 把空分组折叠
  for (const k of Object.keys(grouped)) {
    if (!grouped[k].length) delete grouped[k];
  }

  const totalEnabled = list.skills.filter((s) => s.enabled).length;
  const feishuEnabled = list.skills.some(
    (s) => s.enabled && (/feishu|飞书|lark/i.test(s.name) || /feishu-bot/i.test(s.dir))
  );

  return (
    <div className="sp-section">
      <h2 className="sp-h">插件 / Skill</h2>
      <p className="sp-desc">
        扫描并管理 codex 的 Skills（含 SKILL.md 的目录）与插件。飞书相关 Skill 默认启用，
        变更会写回 <code>config.toml</code>，重启 app-server 后 codex 侧生效。
      </p>

      {/* 状态条 */}
      <div className="sp-card" style={{ marginBottom: 16 }}>
        <div className="sp-row">
          <div className="sp-label">已启用 / 总数</div>
          <div className="sp-code">{totalEnabled} / {list.skills.length}</div>
        </div>
        <div className="sp-row">
          <div className="sp-label">飞书 Skill</div>
          <div style={{ color: feishuEnabled ? "#059669" : "#B91C1C", fontWeight: 600 }}>
            {feishuEnabled ? "● 已启用" : "○ 未检测到"}
          </div>
        </div>
        <div className="sp-row">
          <div className="sp-label">插件</div>
          <div className="sp-code">{list.plugins.length}</div>
        </div>
      </div>

      {/* 扫描根目录 + 刷新 */}
      <h3 className="sp-h2">扫描根目录（每行一个）</h3>
      <textarea
        className="sp-input"
        style={{ minHeight: 72, fontFamily: "var(--mono, ui-monospace, monospace)", fontSize: 12 }}
        value={skillRootsText}
        onChange={(e) => setSkillRootsText(e.target.value)}
        placeholder="Skill 目录（每行一个，例如 C:\Users\xx\.codex\skills 或 /workspace/xxx/.codex/skills）"
        rows={3}
      />
      <textarea
        className="sp-input"
        style={{ minHeight: 44, fontFamily: "var(--mono, ui-monospace, monospace)", fontSize: 12, marginTop: 8 }}
        value={pluginRootsText}
        onChange={(e) => setPluginRootsText(e.target.value)}
        placeholder="插件目录（每行一个，含 plugin.toml）"
        rows={1}
      />
      <div style={{ display: "flex", justifyContent: "flex-end", margin: "10px 0 18px" }}>
        <button className="sp-btn" onClick={refresh} disabled={busy}>
          {busy ? "刷新中…" : "⟳ 按上述目录刷新"}
        </button>
      </div>

      {/* 全局开关 */}
      <h3 className="sp-h2">全局</h3>
      <label
        className="sp-row sp-clickable"
        style={{ padding: "10px 12px", background: "var(--sp-card,#fff)", borderRadius: 10, marginBottom: 8 }}
      >
        <input
          type="checkbox"
          checked={list.bundledSkillsEnabled}
          onChange={(e) => {
            const next = { ...list, bundledSkillsEnabled: e.target.checked };
            setList(next);
            save(next);
          }}
          style={{ marginRight: 8 }}
        />
        <div>
          <div className="sp-label" style={{ fontSize: 13, color: "#111827" }}>
            启用内置 skills
          </div>
          <div className="sp-desc" style={{ fontSize: 12 }}>
            对应 <code>config.toml</code> 的 <code>[skills.bundled] enabled = true</code>
          </div>
        </div>
      </label>

      {/* Skills 列表 + 自添加 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 18 }}>
        <h3 className="sp-h2" style={{ margin: 0 }}>
          Skills（{list.skills.length}）
        </h3>
        <button className="sp-btn sp-btn-primary" onClick={addCustomSkill} disabled={busy || !customSkillDir.trim()}>
          + 添加自定义 Skill
        </button>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <input
          className="sp-input"
          value={customSkillDir}
          onChange={(e) => setCustomSkillDir(e.target.value)}
          placeholder='自定义 Skill 目录，例如 "C:\MyRepos\my-skill\my-skill-name"（含 SKILL.md 的目录本身）'
          onKeyDown={(e) => { if (e.key === "Enter") addCustomSkill(); }}
        />
      </div>
      <p className="sp-desc" style={{ marginTop: 6, fontSize: 12 }}>
        提示：添加的是 skill <b>目录本身</b>（含 SKILL.md），不是 skill 根目录。
      </p>

      {Object.entries(grouped).map(([group, items]) => (
        <div className="sp-card" key={group} style={{ marginTop: 16 }}>
          <div className="sp-row" style={{ borderBottom: "1px solid var(--border,#F3F4F6)", paddingBottom: 8, marginBottom: 6 }}>
            <div className="sp-label" style={{ fontWeight: 600, color: "#374151" }}>{group}</div>
            <div className="sp-code">{items.length} 项</div>
          </div>
          {items.map((s) => {
            const gi = list.skills.findIndex((x) => x.dir === s.dir);
            const isFeishu = /feishu|飞书|lark/i.test(s.name) || /feishu-bot/i.test(s.dir);
            return (
              <label
                key={s.dir}
                className="sp-row sp-clickable"
                style={{ padding: "10px 0", borderBottom: "1px dashed var(--border,#EEF2F7)" }}
              >
                <input
                  type="checkbox"
                  checked={s.enabled}
                  onChange={(e) => toggleSkill(gi, e.target.checked)}
                  style={{ marginRight: 10 }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <b style={{ color: "#111827" }}>{s.name}</b>
                    {isFeishu && (
                      <span className="sp-tag" style={{ background: "#EEF2FF", color: "#4338CA" }}>
                        飞书
                      </span>
                    )}
                    {s.enabled && (
                      <span className="sp-tag" style={{ background: "#ECFDF5", color: "#047857" }}>启用</span>
                    )}
                  </div>
                  {s.description && (
                    <div style={{ color: "#4B5563", fontSize: 12, marginTop: 2 }}>{s.description}</div>
                  )}
                  <div style={{ color: "#6B7280", fontSize: 11.5, marginTop: 2, fontFamily: "var(--mono, ui-monospace, monospace)", wordBreak: "break-all" }}>
                    {s.dir}
                  </div>
                </div>
              </label>
            );
          })}
        </div>
      ))}

      {list.skills.length === 0 && (
        <div className="sp-card" style={{ marginTop: 12 }}>
          <p className="sp-desc">未发现任何 skill。先在上方点「按上述目录刷新」，或把你的 SKILL.md 所在目录粘贴到"自定义 Skill"输入框里。</p>
        </div>
      )}

      {/* 插件列表 */}
      <h3 className="sp-h2" style={{ marginTop: 22 }}>插件（{list.plugins.length}）</h3>
      {list.plugins.length === 0 ? (
        <div className="sp-card">
          <p className="sp-desc">未发现任何插件（含 <code>plugin.toml</code> 的目录）。</p>
        </div>
      ) : (
        list.plugins.map((p, i) => (
          <label
            key={p.id}
            className="sp-card sp-row sp-clickable"
            style={{ marginTop: 10 }}
          >
            <input
              type="checkbox"
              checked={p.enabled}
              onChange={(e) => togglePlugin(i, e.target.checked)}
              style={{ marginRight: 10 }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div>
                <b>{p.name}</b> <span className="sp-code">@ {p.id}</span>
              </div>
              {p.description && <p className="sp-desc" style={{ marginTop: 2 }}>{p.description}</p>}
              <div style={{ color: "#6B7280", fontSize: 11.5, wordBreak: "break-all", fontFamily: "var(--mono, ui-monospace, monospace)" }}>{p.dir}</div>
            </div>
          </label>
        ))
      )}

      <p className="sp-desc" style={{ marginTop: 18, fontSize: 12, color: "#6B7280" }}>
        提示：飞书 Skill 启用后，对话里直接说"给张三发条消息"、"写到多维表格 xxx 里"，codex 会走 `feishu-bot` Skill + lark MCP 组合执行。
      </p>
    </div>
  );
}

