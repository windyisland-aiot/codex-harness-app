//! v0.3.0 统一设置面板 — Trae Work 风格左侧 nav + 右侧内容。
//! 覆盖：账号 | 通用 | 模型 | MCP | 会话 | 搜索 | 关于
//! 全部改动实时写 config.toml + .env-provider，保存后提示重启 codex 生效。

import { useEffect, useState } from "react";
import * as codex from "../codexClient";
import type { AppConfig, ProviderConfig, McpServerConfig, SessionMeta } from "../codexClient";

type NavKey = "account" | "general" | "models" | "mcp" | "sessions" | "search" | "about";

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
  { key: "mcp",      label: "MCP",    icon: I(<><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></>) },
  { key: "sessions", label: "会话流", icon: I(<><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></>) },
  { key: "search",   label: "搜索",   icon: I(<><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></>) },
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
  const [nav, setNav] = useState<NavKey>("models");
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
          id: "feishu", command: "lark-openapi-mcp",
          args: ["--mode=stdio"], env: [], envVars: ["FEISHU_USER_ACCESS_TOKEN"], enabled: true,
        }],
      };
    });
    setDirty(true);
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
              <div className="sp-user-sub">本地实例 · v0.3.0</div>
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
            <SectionMcp cfg={cfg} patch={patchCfg} updateMcp={updateMcp} addFeishu={addFeishu} />
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
  return (
    <div className="sp-section">
      <h2 className="sp-h">模型供应商</h2>
      <p className="sp-desc">
        添加模型供应商后，在下方填入 API key 和默认模型名（默认模型名在"通用"tab 设置）。
        保存后 codex 会按各 provider 的 <code>env_key</code> 从 <code>.env-provider</code> 读取凭据注入子进程。
      </p>

      <div className="sp-card sp-current-hint">
        <div><strong>当前默认：</strong> {currentProvider ? `${currentProvider.name} (${currentProvider.id})` : "未设置"}</div>
        <div><strong>默认模型名：</strong> <code>{cfg.model || "ark-code-latest"}</code>（在"通用"tab 修改）</div>
      </div>

      <button className="sp-btn sp-btn-primary sp-add-btn" onClick={addProvider}>+ 添加模型</button>

      <div className="sp-card">
        <table className="sp-table">
          <thead>
            <tr>
              <th style={{ width: 34 }}></th>
              <th>名称</th>
              <th>Provider ID</th>
              <th>Base URL</th>
              <th>env_key</th>
              <th>wire_api</th>
              <th>API Key</th>
              <th style={{ width: 140 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {cfg.modelProviders.map((p, i) => (
              <tr key={p.id}>
                <td>
                  <input
                    type="radio"
                    name="default-provider"
                    checked={cfg.modelProvider === p.id}
                    onChange={() => selectAsDefault(i)}
                    title="设为默认供应商"
                  />
                </td>
                <td><input className="sp-input sp-input-sm" value={p.name} onChange={(e) => updateProvider(i, { name: e.target.value })} /></td>
                <td><input className="sp-input sp-input-sm sp-input-code" value={p.id} onChange={(e) => updateProvider(i, { id: e.target.value })} /></td>
                <td><input className="sp-input sp-input-sm" value={p.baseUrl} onChange={(e) => updateProvider(i, { baseUrl: e.target.value })} placeholder="https://ark.cn-beijing.volces.com/api/coding/v3" /></td>
                <td><input className="sp-input sp-input-sm sp-input-code" value={p.envKey} onChange={(e) => updateProvider(i, { envKey: e.target.value })} placeholder="ARK_API_KEY" /></td>
                <td>
                  <select className="sp-input sp-input-sm" value={p.wireApi} onChange={(e) => updateProvider(i, { wireApi: e.target.value })}>
                    <option value="responses">responses</option>
                    <option value="chat">chat</option>
                  </select>
                </td>
                <td>
                  <div className="sp-key-wrap">
                    <input
                      className="sp-input sp-input-sm"
                      type={showKey[p.envKey] ? "text" : "password"}
                      placeholder={creds[p.envKey] ? "•••••• 已填" : "未设置"}
                      value={creds[p.envKey] ?? ""}
                      onChange={(e) => setCreds({ ...creds, [p.envKey]: e.target.value })}
                    />
                    <button
                      type="button"
                      className="sp-key-toggle"
                      onClick={() => setShowKey((s) => ({ ...s, [p.envKey]: !s[p.envKey] }))}
                    >{showKey[p.envKey] ? "隐藏" : "显示"}</button>
                  </div>
                </td>
                <td>
                  <button className="sp-link" onClick={() => selectAsDefault(i)} title="设为默认供应商">设为默认</button>
                  <span className="sp-sep">·</span>
                  <button className="sp-link sp-link-danger" onClick={() => delProvider(i)}>删除</button>
                </td>
              </tr>
            ))}
            {!hasProviders && (
              <tr><td colSpan={8} className="sp-empty">还没有模型供应商，点上方「+ 添加模型」开始。</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SectionMcp({
  cfg, patch, updateMcp, addFeishu,
}: {
  cfg: AppConfig;
  patch: (p: Partial<AppConfig>) => void;
  updateMcp: (i: number, p: Partial<McpServerConfig>) => void;
  addFeishu: () => void;
}) {
  return (
    <div className="sp-section">
      <h2 className="sp-h">MCP Server</h2>
      <p className="sp-desc">Codex 启动时会自动拉起已启用的 MCP server（stdio 模式）。</p>
      <div className="sp-actions">
        <button className="sp-btn sp-btn-ghost" onClick={addFeishu}>+ 注册飞书 MCP（lark-openapi-mcp）</button>
      </div>
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
      <p className="sp-desc">基于 OpenAI Codex 的企业内部 Agent 桌面应用。v0.3.0</p>
      <div className="sp-card">
        <div className="sp-row"><div className="sp-label">codexHome</div><div className="sp-code">{codexHome}</div></div>
        <div className="sp-row"><div className="sp-label">codexBin</div><div className="sp-code">{codexBin}</div></div>
      </div>
    </div>
  );
}
