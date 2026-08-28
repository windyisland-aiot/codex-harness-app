//! T09 配置面板：读写 codex config.toml（模型 / 模型提供商 / 审批策略 / MCP server）。
//! 改动写入后需重启 app-server 才生效，故给出提示。

import { useState } from "react";
import * as codex from "../codexClient";
import type { AppConfig, ProviderConfig, McpServerConfig } from "../codexClient";

const EMPTY_CFG: AppConfig = {
  model: "",
  model_provider: "",
  approval_policy: "on-request",
  model_providers: [],
  mcp_servers: [],
};

const APPROVAL_POLICIES = ["never", "on-request", "on-failure"];

export default function ConfigPanel({
  open,
  onClose,
  codexHome,
  onSaved,
  onStatus,
}: {
  open: boolean;
  onClose: () => void;
  codexHome: string;
  onSaved: (cfg: AppConfig) => void;
  onStatus: (s: string) => void;
}) {
  const [cfg, setCfg] = useState<AppConfig>(EMPTY_CFG);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  if (!open) return null;

  // 每次打开时重新加载
  if (!loaded) {
    codex
      .configRead(codexHome)
      .then((c) => {
        setCfg(c ?? EMPTY_CFG);
        setLoaded(true);
      })
      .catch((e) => onStatus(`读取配置失败: ${e}`));
    return null;
  }

  function close() {
    if (dirty && !window.confirm("配置有未保存的改动，确定关闭？")) return;
    setLoaded(false);
    setDirty(false);
    onClose();
  }

  async function save() {
    setSaving(true);
    try {
      await codex.configWrite(codexHome, cfg);
      setDirty(false);
      setLoaded(false);
      onSaved(cfg);
      onStatus("配置已保存 · 重启 app-server 后生效");
      onClose();
    } catch (e) {
      onStatus(`保存配置失败: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  function patch(p: Partial<AppConfig>) {
    setCfg((c) => ({ ...c, ...p }));
    setDirty(true);
  }

  function setProvider(i: number, p: Partial<ProviderConfig>) {
    setCfg((c) => {
      const next = c.model_providers.slice();
      next[i] = { ...next[i], ...p };
      return { ...c, model_providers: next };
    });
    setDirty(true);
  }

  function delProvider(i: number) {
    setCfg((c) => {
      const next = c.model_providers.filter((_, k) => k !== i);
      return { ...c, model_providers: next };
    });
    setDirty(true);
  }

  function addProvider() {
    setCfg((c) => ({
      ...c,
      model_providers: [
        ...c.model_providers,
        { id: `provider-${Date.now()}`, name: "", base_url: "", env_key: "", wire_api: "responses" },
      ],
    }));
    setDirty(true);
  }

  function setMcp(i: number, p: Partial<McpServerConfig>) {
    setCfg((c) => {
      const next = c.mcp_servers.slice();
      next[i] = { ...next[i], ...p };
      return { ...c, mcp_servers: next };
    });
    setDirty(true);
  }

  function delMcp(i: number) {
    setCfg((c) => ({ ...c, mcp_servers: c.mcp_servers.filter((_, k) => k !== i) }));
    setDirty(true);
  }

  function addMcp() {
    setCfg((c) => ({
      ...c,
      mcp_servers: [
        ...c.mcp_servers,
        { id: `mcp-${Date.now()}`, command: "", args: [], env: [], env_vars: [], enabled: true },
      ],
    }));
    setDirty(true);
  }

  /** T12：一键注册飞书 MCP server（默认 lark-openapi-mcp，stdio）。 */
  function addFeishu() {
    setCfg((c) => {
      const exists = c.mcp_servers.some((m) => m.id === "feishu");
      if (exists) return c;
      return {
        ...c,
        mcp_servers: [
          ...c.mcp_servers,
          {
            id: "feishu",
            command: "lark-openapi-mcp",
            args: ["--mode=stdio"],
            env: ["FEISHU_APP_ID=", "FEISHU_APP_SECRET="],
            env_vars: ["FEISHU_USER_ACCESS_TOKEN"],
            enabled: true,
          },
        ],
      };
    });
    setDirty(true);
  }

  return (
    <div className="cfg-backdrop" onClick={close}>
      <div className="cfg-panel" onClick={(e) => e.stopPropagation()}>
        <div className="cfg-head">
          <h2>配置面板</h2>
          <button className="cfg-close" onClick={close} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="cfg-body">
          <section className="cfg-field">
            <label>默认模型（model）</label>
            <input
              value={cfg.model}
              onChange={(e) => patch({ model: e.target.value })}
              placeholder="如 gpt-4.1 / deepseek-chat"
            />
          </section>

          <div className="cfg-grid">
            <section className="cfg-field">
              <label>模型提供商（model_provider）</label>
              <select
                value={cfg.model_provider}
                onChange={(e) => patch({ model_provider: e.target.value })}
              >
                <option value="">— 未选择 —</option>
                {cfg.model_providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id}（{p.name || "未命名"}）
                  </option>
                ))}
              </select>
            </section>
            <section className="cfg-field">
              <label>审批策略（approval_policy）</label>
              <select
                value={cfg.approval_policy}
                onChange={(e) => patch({ approval_policy: e.target.value })}
              >
                {APPROVAL_POLICIES.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </section>
          </div>

          <section className="cfg-section">
            <div className="cfg-sec-head">
              <h3>模型提供商</h3>
              <button className="cfg-add" onClick={addProvider}>
                ＋ 添加
              </button>
            </div>
            {cfg.model_providers.length === 0 && <p className="cfg-empty">暂无</p>}
            {cfg.model_providers.map((p, i) => (
              <div key={i} className="cfg-card">
                <div className="cfg-card-head">
                  <input
                    className="cfg-id"
                    value={p.id}
                    onChange={(e) => setProvider(i, { id: e.target.value })}
                    placeholder="id（如 deepseek）"
                  />
                  <button className="cfg-del" onClick={() => delProvider(i)}>
                    删除
                  </button>
                </div>
                <div className="cfg-grid">
                  <input
                    value={p.name}
                    onChange={(e) => setProvider(i, { name: e.target.value })}
                    placeholder="展示名"
                  />
                  <select
                    value={p.wire_api}
                    onChange={(e) => setProvider(i, { wire_api: e.target.value })}
                  >
                    <option value="responses">responses</option>
                    <option value="chat">chat</option>
                  </select>
                </div>
                <input
                  className="cfg-full"
                  value={p.base_url}
                  onChange={(e) => setProvider(i, { base_url: e.target.value })}
                  placeholder="base_url（含 /v1）"
                />
                <input
                  className="cfg-full"
                  value={p.env_key}
                  onChange={(e) => setProvider(i, { env_key: e.target.value })}
                  placeholder="env_key（API key 所在环境变量，如 DEEPSEEK_API_KEY）"
                />
              </div>
            ))}
          </section>

          <section className="cfg-section">
            <div className="cfg-sec-head">
              <h3>MCP Server</h3>
              <div>
                <button className="cfg-add" onClick={addFeishu} title="注册飞书 lark-openapi-mcp">
                  ＋ 飞书
                </button>{" "}
                <button className="cfg-add" onClick={addMcp}>
                  ＋ 添加
                </button>
              </div>
            </div>
            {cfg.mcp_servers.length === 0 && <p className="cfg-empty">暂无</p>}
            {cfg.mcp_servers.map((m, i) => (
              <div key={i} className="cfg-card">
                <div className="cfg-card-head">
                  <input
                    className="cfg-id"
                    value={m.id}
                    onChange={(e) => setMcp(i, { id: e.target.value })}
                    placeholder="id（如 feishu）"
                  />
                  <label className="cfg-check">
                    <input
                      type="checkbox"
                      checked={m.enabled}
                      onChange={(e) => setMcp(i, { enabled: e.target.checked })}
                    />
                    启用
                  </label>
                  <button className="cfg-del" onClick={() => delMcp(i)}>
                    删除
                  </button>
                </div>
                <input
                  className="cfg-full"
                  value={m.command}
                  onChange={(e) => setMcp(i, { command: e.target.value })}
                  placeholder="command（如 lark-openapi-mcp）"
                />
                <input
                  className="cfg-full"
                  value={m.args.join(" ")}
                  onChange={(e) =>
                    setMcp(i, { args: e.target.value.split(/\s+/).filter(Boolean) })
                  }
                  placeholder="args（空格分隔，如 --mode=stdio）"
                />
                <textarea
                  className="cfg-full cfg-env"
                  value={m.env.join("\n")}
                  onChange={(e) =>
                    setMcp(i, {
                      env: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean),
                    })
                  }
                  placeholder={"env（每行 KEY=value，注入到 MCP 进程）：\nFEISHU_APP_ID=\nFEISHU_APP_SECRET="}
                  rows={3}
                />
                <input
                  className="cfg-full"
                  value={m.env_vars.join("\n")}
                  onChange={(e) =>
                    setMcp(i, {
                      env_vars: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean),
                    })
                  }
                  placeholder="env_vars（每行一个透传的环境变量名，如 FEISHU_USER_ACCESS_TOKEN）"
                />
              </div>
            ))}
          </section>
        </div>
        <div className="cfg-foot">
          <span className="cfg-hint">保存后需重启 app-server 生效。</span>
          <button className="cfg-save" onClick={save} disabled={saving}>
            {saving ? "保存中…" : "保存配置"}
          </button>
        </div>
      </div>
    </div>
  );
}