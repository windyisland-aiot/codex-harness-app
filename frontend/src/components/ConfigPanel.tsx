//! T09 配置面板：读写 codex config.toml（模型 / 模型提供商 / 审批策略 / MCP server）。
//! 改动写入后需重启 app-server 才生效，故给出提示。

import { useState } from "react";
import * as codex from "../codexClient";
import type { AppConfig, ProviderConfig, McpServerConfig } from "../codexClient";

const EMPTY_CFG: AppConfig = {
  model: "",
  modelProvider: "",
  approvalPolicy: "on-request",
  modelProviders: [],
  mcpServers: [],
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
    setLoaded(false);
    onClose();
  }

  function patch(delta: Partial<AppConfig>) {
    setCfg((c) => ({ ...c, ...delta }));
    setDirty(true);
  }

  function setProvider(i: number, p: Partial<ProviderConfig>) {
    setCfg((c) => {
      const next = c.modelProviders.slice();
      next[i] = { ...next[i], ...p };
      return { ...c, modelProviders: next };
    });
    setDirty(true);
  }

  function delProvider(i: number) {
    setCfg((c) => {
      const next = c.modelProviders.filter((_, k) => k !== i);
      return { ...c, modelProviders: next };
    });
    setDirty(true);
  }

  function addProvider() {
    setCfg((c) => ({
      ...c,
      modelProviders: [
        ...c.modelProviders,
        { id: `provider-${Date.now()}`, name: "", type: "Custom", baseUrl: "", envKey: "", wireApi: "responses" },
      ],
    }));
    setDirty(true);
  }

  function setMcp(i: number, p: Partial<McpServerConfig>) {
    setCfg((c) => {
      const next = c.mcpServers.slice();
      next[i] = { ...next[i], ...p };
      return { ...c, mcpServers: next };
    });
    setDirty(true);
  }

  function delMcp(i: number) {
    setCfg((c) => ({ ...c, mcpServers: c.mcpServers.filter((_, k) => k !== i) }));
    setDirty(true);
  }

  function addMcp() {
    setCfg((c) => ({
      ...c,
      mcpServers: [
        ...c.mcpServers,
        { id: `mcp-${Date.now()}`, command: "", args: [], env: [], envVars: [], enabled: true },
      ],
    }));
    setDirty(true);
  }

  /** T12：一键注册飞书 MCP server（默认 lark-openapi-mcp，stdio）。 */
  function addFeishu() {
    setCfg((c) => {
      const exists = c.mcpServers.some((m) => m.id === "feishu");
      if (exists) return c;
      return {
        ...c,
        mcpServers: [
          ...c.mcpServers,
          {
            id: "feishu",
            command: "lark-openapi-mcp",
            args: ["--mode=stdio"],
            env: ["FEISHU_APP_ID=", "FEISHU_APP_SECRET="],
            envVars: ["FEISHU_USER_ACCESS_TOKEN"],
            enabled: true,
          },
        ],
      };
    });
    setDirty(true);
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>配置面板</h3>
          <button onClick={close}>×</button>
        </header>

        <div className="cfg-grid">
          <section>
            <label>默认模型（model）</label>
            <input
              value={cfg.model}
              onChange={(e) => patch({ model: e.target.value })}
              placeholder="gpt-4.1 / deepseek-chat / …"
            />
          </section>
          <section>
            <label>模型提供商（modelProvider）</label>
            <input
              list="providers"
              value={cfg.modelProvider}
              onChange={(e) => patch({ modelProvider: e.target.value })}
              placeholder="openai / 自定义 id"
            />
            <datalist id="providers">
              {cfg.modelProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </datalist>
          </section>
          <section>
            <label>审批策略（approvalPolicy）</label>
            <select
              value={cfg.approvalPolicy}
              onChange={(e) => patch({ approvalPolicy: e.target.value })}
            >
              {APPROVAL_POLICIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </section>
        </div>

        <div className="cfg-section">
          <div className="cfg-section-header">
            <h4>模型提供商列表</h4>
            <button className="cfg-btn" onClick={addProvider}>
              ＋ 新增
            </button>
          </div>
          {cfg.modelProviders.length === 0 && <p className="cfg-empty">暂无</p>}
          {cfg.modelProviders.map((p, i) => (
            <div key={p.id} className="cfg-card">
              <div className="cfg-row">
                <input
                  value={p.id}
                  className="cfg-col-id"
                  onChange={(e) => setProvider(i, { id: e.target.value })}
                  placeholder="provider id（唯一，对应 config.toml [model_providers.<id>]）"
                />
                <input
                  value={p.name}
                  className="cfg-col-name"
                  onChange={(e) => setProvider(i, { name: e.target.value })}
                  placeholder="显示名（如 DeepSeek）"
                />
                <select
                  value={p.wireApi}
                  className="cfg-col-wire"
                  onChange={(e) => setProvider(i, { wireApi: e.target.value })}
                >
                  <option value="responses">responses</option>
                  <option value="chat">chat_completions</option>
                </select>
                <button className="cfg-btn danger" onClick={() => delProvider(i)}>
                  删
                </button>
              </div>
              <div className="cfg-row">
                <input
                  className="cfg-col-3"
                  value={p.baseUrl}
                  onChange={(e) => setProvider(i, { baseUrl: e.target.value })}
                  placeholder="baseUrl（含 /v1）"
                />
                <input
                  className="cfg-col-3"
                  value={p.envKey}
                  onChange={(e) => setProvider(i, { envKey: e.target.value })}
                  placeholder="envKey（API key 所在环境变量，如 DEEPSEEK_API_KEY）"
                />
              </div>
            </div>
          ))}
        </div>

        <div className="cfg-section">
          <div className="cfg-section-header">
            <h4>MCP Server 列表</h4>
            <button className="cfg-btn" onClick={addMcp}>
              ＋ 新增
            </button>
            <button className="cfg-btn" onClick={addFeishu}>
              加飞书 MCP
            </button>
          </div>
          {cfg.mcpServers.length === 0 && <p className="cfg-empty">暂无</p>}
          {cfg.mcpServers.map((m, i) => (
            <div key={m.id} className="cfg-card">
              <div className="cfg-row">
                <input
                  value={m.id}
                  className="cfg-col-id"
                  onChange={(e) => setMcp(i, { id: e.target.value })}
                  placeholder="mcp id（唯一）"
                />
                <input
                  value={m.command}
                  className="cfg-col-name"
                  onChange={(e) => setMcp(i, { command: e.target.value })}
                  placeholder="可执行文件（如 lark-openapi-mcp）"
                />
                <label className="cfg-col-wire">
                  <input
                    type="checkbox"
                    checked={m.enabled}
                    onChange={(e) => setMcp(i, { enabled: e.target.checked })}
                  />
                  &nbsp;enabled
                </label>
                <button className="cfg-btn danger" onClick={() => delMcp(i)}>
                  删
                </button>
              </div>
              <div className="cfg-row">
                <textarea
                  className="cfg-col-3"
                  value={m.args.join("\n")}
                  onChange={(e) =>
                    setMcp(i, {
                      args: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean),
                    })
                  }
                  rows={2}
                  placeholder="args（每行一个）"
                />
                <textarea
                  className="cfg-col-3"
                  value={m.env.join("\n")}
                  onChange={(e) =>
                    setMcp(i, {
                      env: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean),
                    })
                  }
                  rows={2}
                  placeholder="env（每行一个 KEY=value，直接注入）"
                />
              </div>
              <div className="cfg-row">
                <textarea
                  className="cfg-col-full"
                  value={m.envVars.join("\n")}
                  onChange={(e) =>
                    setMcp(i, {
                      envVars: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean),
                    })
                  }
                  rows={2}
                  placeholder="envVars（每行一个透传的环境变量名，如 FEISHU_USER_ACCESS_TOKEN）"
                />
              </div>
            </div>
          ))}
        </div>

        <footer className="cfg-footer">
          <span>
            {dirty ? "[待保存] 有未保存的修改" : "[已同步] 配置已同步"}（保存后需重启 app-server 生效）
          </span>
          <button
            className="cfg-btn primary"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              try {
                await codex.configWrite(codexHome, cfg);
                onSaved(cfg);
                setDirty(false);
                onStatus("[成功] 配置已写入 config.toml，重启 app-server 生效");
              } catch (e) {
                onStatus(`保存配置失败: ${e}`);
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </footer>
      </div>
    </div>
  );
}
