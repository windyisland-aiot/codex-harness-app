//! T06 基础对话 UI：指令输入、流式输出（Markdown 渲染）、会话列表。
//! T08 审批面板：命令/文件变更需审批时弹出确认/拒绝。
import { useEffect, useRef, useState } from "react";
import Markdown from "./components/Markdown";
import ApprovalPanel from "./components/ApprovalPanel";
import ConfigPanel from "./components/ConfigPanel";
import ModelSwitcher from "./components/ModelSwitcher";
import RouterPanel from "./components/RouterPanel";
import FeishuOAuthPanel from "./components/FeishuOAuthPanel";
import PluginsPanel from "./components/PluginsPanel";
import SearchPanel from "./components/SearchPanel";
import * as codex from "./codexClient";
import type { ApprovalRequest, AppConfig, ProviderConfig, RouteDecision } from "./codexClient";
import type { ModelPreset } from "./models";

interface Msg {
  role: "user" | "assistant";
  text: string;
}

interface Session {
  id: string;
  title: string;
}

const DEFAULT_CODEX_BIN = "/workspace/codex/codex-rs/target/debug/codex";
const DEFAULT_CODEX_HOME = "/workspace/codex-harness-app/.codex-test";
const codexBin = DEFAULT_CODEX_BIN;
const POLL_MS = 200;

export default function App() {
  // 会话/模型参数：T09 配置面板加载并覆盖 model/provider。
  const codexHome = DEFAULT_CODEX_HOME;
  const [model, setModel] = useState("mock-model");
  const [provider, setProvider] = useState("mock");
  const [cfgOpen, setCfgOpen] = useState(false);
  const [feishuOpen, setFeishuOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const cwd = "/workspace/codex-harness-app";

  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("未连接");

  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);

  // T11 模型路由：自动路由开关 + 敏感标记（路由决策应用到线程）。
  const [autoRoute, setAutoRoute] = useState(true);
  const [sensitive, setSensitive] = useState(false);

  // 发送时记录当前线程所用 provider，用于 T10 判断切换是否需新开线程。
  const threadProviderRef = useRef<string | null>(null);
  const runningRef = useRef(false);
  const activeThreadRef = useRef<string | null>(null);
  const msgsRef = useRef<Msg[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);
  useEffect(() => {
    activeThreadRef.current = activeThread;
  }, [activeThread]);
  useEffect(() => {
    msgsRef.current = messages;
  }, [messages]);

  // 自动连接 app-server
  useEffect(() => {
    codex
      .start({ codexBin, codexHome })
      .then((ua) => {
        setConnected(true);
        setStatus(`已连接 · ${ua}`);
      })
      .catch((e) => setStatus(`连接失败: ${e}`));
    return () => {
      codex.stop().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 轮询流式事件
  useEffect(() => {
    if (!running) return;
    timerRef.current = setInterval(async () => {
      if (!runningRef.current) return;
      try {
        const events = await codex.pollEvents();
        for (const e of events) {
          if (e.method === "turn/completed") {
            setRunning(false);
            continue;
          }
          const d = codex.textDelta(e);
          if (d === null) continue;
          // 追加到最新一条 assistant 消息
          const cur = msgsRef.current;
          if (cur.length > 0 && cur[cur.length - 1].role === "assistant") {
            const list = [...cur];
            list[list.length - 1] = {
              ...list[list.length - 1],
              text: list[list.length - 1].text + d,
            };
            setMessages(list);
          } else {
            setMessages([...cur, { role: "assistant", text: d }]);
          }
        }
      } catch (e) {
        setStatus(`事件推送错误: ${e}`);
        setRunning(false);
      }
    }, POLL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [running]);

  // 轮询审批请求：只在前端持有待审批项为空时继续（避免重复弹窗应由后端缓冲保证）。
  useEffect(() => {
    if (!connected) return;
    const t = setInterval(async () => {
      try {
        const list = await codex.pollApprovals();
        if (list.length > 0) {
          setApprovals((prev) => [...prev, ...list]);
        }
      } catch (e) {
        // 轮询失败静默，避免打断对话状态。
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [connected]);

  async function respondApproval(id: number, decision: string) {
    try {
      await codex.respondApproval(id, decision);
      setApprovals((prev) => prev.filter((a) => a.id !== id));
    } catch (e) {
      setStatus(`审批回复失败: ${e}`);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || pending) return;
    if (!connected) {
      setStatus("请先连接 app-server");
      return;
    }
    setPending(true);
    setInput("");

    // 追加用户消息
    const next = [...msgsRef.current, { role: "user" as const, text }];
    setMessages(next);

    try {
      // T11 模型路由：开启自动路由时，先按指令路由到合适模型，再应用到线程。
      let routeModel = model;
      let routeProvider = provider;
      if (autoRoute) {
        try {
          const d = await codex.route(text, { sensitive });
          routeModel = d.model;
          routeProvider = d.provider;
        } catch (e) {
          setStatus(`路由失败，回退当前模型: ${e}`);
        }
      }
      let threadId = activeThreadRef.current;
      if (!threadId) {
        const nid = await codex.threadStart({ model: routeModel, modelProvider: routeProvider, cwd });
        threadId = nid;
        threadProviderRef.current = routeProvider;
        setActiveThread(nid);
        setSessions((s) => [
          ...s,
          { id: nid, title: text.slice(0, 24) + (text.length > 24 ? "…" : "") },
        ]);
      } else if (autoRoute && routeModel !== model) {
        // 已有线程：把路由到的模型应用到当前线程（下个 turn 生效）。
        try {
          await codex.threadSetModel(threadId, routeModel);
        } catch (e) {
          setStatus(`切换路由模型失败: ${e}`);
        }
      }
      if (routeModel !== model || routeProvider !== provider) {
        setModel(routeModel);
        setProvider(routeProvider);
      }
      const tid = threadId as string;
      await codex.turnStart({ threadId: tid, cwd, text });
      setRunning(true);
    } catch (e) {
      setStatus(`发送失败: ${e}`);
    } finally {
      setPending(false);
    }
  }

  function newChat() {
    setActiveThread(null);
    setMessages([]);
  }

  function onConfigSaved(c: AppConfig) {
    if (c.model) setModel(c.model);
    if (c.model_provider) setProvider(c.model_provider);
  }

  /** T10：把某个内置提供商预设设为当前（持久化到 config.toml），并联动线程。 */
  async function applyProvider(preset: ModelPreset) {
    const nextModel = preset.models.includes(model) ? model : preset.default_model;
    setProvider(preset.id);
    setModel(nextModel);
    // 持久化 provider 预设到 config.toml
    try {
      const cfg = await codex.configRead(codexHome);
      const idx = cfg.model_providers.findIndex((p) => p.id === preset.id);
      const prov: ProviderConfig = {
        id: preset.id,
        name: preset.name,
        base_url: preset.base_url,
        env_key: preset.env_key,
        wire_api: preset.wire_api,
      };
      if (idx >= 0) cfg.model_providers[idx] = prov;
      else cfg.model_providers.push(prov);
      cfg.model = nextModel;
      cfg.model_provider = preset.id;
      await codex.configWrite(codexHome, cfg);
      setStatus(`已切换到 ${preset.name} · ${nextModel}`);
    } catch (e) {
      setStatus(`保存提供商失败: ${e}`);
    }
    // 若当前线程正是该 provider，则在线切换模型（下个 turn 生效）
    const tid = activeThreadRef.current;
    if (tid && threadProviderRef.current === preset.id) {
      try {
        await codex.threadSetModel(tid, nextModel);
      } catch (e) {
        setStatus(`切换线程模型失败: ${e}`);
      }
    }
  }

  /** T10：同 provider 内切换模型。 */
  async function applyModel(nextModel: string) {
    setModel(nextModel);
    const tid = activeThreadRef.current;
    if (tid && threadProviderRef.current === provider) {
      try {
        await codex.threadSetModel(tid, nextModel);
        setStatus(`本会话模型已切换为 ${nextModel}`);
      } catch (e) {
        setStatus(`切换线程模型失败: ${e}`);
      }
    }
  }

  /** T11：手动路由命中后，将推荐模型应用到当前线程（供后续 turn 使用）。 */
  async function handleRouted(d: RouteDecision | null) {
    if (!d || d.model === model) return;
    setModel(d.model);
    setProvider(d.provider);
    const tid = activeThreadRef.current;
    if (tid) {
      try {
        await codex.threadSetModel(tid, d.model);
        setStatus(`已按路由应用 ${d.provider}/${d.model}`);
      } catch (e) {
        setStatus(`应用路由模型失败: ${e}`);
      }
    } else {
      setStatus(`路由推荐 ${d.provider}/${d.model}（新会话将使用）`);
    }
  }

  return (
    <div className="chat">
      <aside className="sidebar">
        <h1>Harness · Agent</h1>
        <button className="new-btn" onClick={newChat}>
          ＋ 新建会话
        </button>
        <ul className="sessions">
          {sessions.map((s) => (
            <li key={s.id} className={s.id === activeThread ? "active" : ""}>
              <span
                className="session-title"
                onClick={() => {
                  setActiveThread(s.id);
                  setMessages([]);
                }}
              >
                {s.title}
              </span>
            </li>
          ))}
        </ul>
        <button className="new-btn" onClick={() => setCfgOpen(true)}>
          ⚙ 配置
        </button>
        <button className="new-btn" onClick={() => setFeishuOpen(true)}>
          ✈ 飞书
        </button>
        <button className="new-btn" onClick={() => setPluginsOpen(true)}>
          ⚇ 技能
        </button>
        <button className="new-btn" onClick={() => setSearchOpen(true)}>
          ⌕ 搜索
        </button>
        <div className="conn">
          <div className={`dot ${connected ? "on" : "off"}`} /> {status}
        </div>
      </aside>

      <main className="main">
        <ApprovalPanel approvals={approvals} onRespond={respondApproval} />
        <section className="msglist">
          {messages.length === 0 && (
            <div className="placeholder">输入指令开始与 Agent 对话</div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              <div className="bubble">
                <Markdown text={m.text} />
              </div>
            </div>
          ))}
          {running && <div className="typing">正在推理…</div>}
        </section>

        <footer className="inputbar">
          <RouterPanel
            prompt={input}
            disabled={pending || running}
            autoRoute={autoRoute}
            onAutoRouteChange={setAutoRoute}
            sensitive={sensitive}
            onSensitiveChange={setSensitive}
            onRouted={handleRouted}
          />
          <ModelSwitcher
            provider={provider}
            model={model}
            onProvider={applyProvider}
            onModel={applyModel}
          />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="输入指令（Enter 发送）"
            disabled={pending || running}
          />
          <button onClick={send} disabled={pending || running}>
            发送
          </button>
          <span className="cfg">
            model={model} provider={provider} · {cwd}
          </span>
        </footer>
      </main>

      <ConfigPanel
        open={cfgOpen}
        onClose={() => setCfgOpen(false)}
        codexHome={codexHome}
        onSaved={onConfigSaved}
        onStatus={setStatus}
      />
      <FeishuOAuthPanel
        open={feishuOpen}
        onClose={() => setFeishuOpen(false)}
        onStatus={setStatus}
      />
      <PluginsPanel
        open={pluginsOpen}
        onClose={() => setPluginsOpen(false)}
        codexHome={codexHome}
        onStatus={setStatus}
      />
      <SearchPanel
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        codexHome={codexHome}
        onStatus={setStatus}
      />
    </div>
  );
}