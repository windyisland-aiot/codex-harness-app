//! T06 基础对话 UI：指令输入、流式输出（Markdown 渲染）、会话列表。
//! T08 审批面板：命令/文件变更需审批时弹出确认/拒绝。
//!
//! ⚠️  运行时路径：由 `codex.resolvePaths()` 向 Tauri 后端请求跨平台的
//! codexHome / codexBin / defaultCwd。禁止写死 Linux `/workspace/...`。
import { useEffect, useRef, useState } from "react";
import Markdown from "./components/Markdown";
import ApprovalPanel from "./components/ApprovalPanel";
import ConfigPanel from "./components/ConfigPanel";
import ModelSwitcher from "./components/ModelSwitcher";
import RouterPanel from "./components/RouterPanel";
import FeishuOAuthPanel from "./components/FeishuOAuthPanel";
import PluginsPanel from "./components/PluginsPanel";
import SearchPanel from "./components/SearchPanel";
import SessionsPanel from "./components/SessionsPanel";
import * as codex from "./codexClient";
import type {
  ApprovalRequest,
  AppConfig,
  ProviderConfig,
  RouteDecision,
  ResolvedPaths,
} from "./codexClient";
import type { ModelPreset } from "./models";

interface Msg {
  role: "user" | "assistant";
  text: string;
}

interface Session {
  id: string;
  title: string;
}

const POLL_MS = 200;

export default function App() {
  // 运行时路径：渲染一次后由 harness_resolve_paths 异步填入（跨平台安全）。
  const [paths, setPaths] = useState<ResolvedPaths | null>(null);
  const codexHome = paths?.codexHome ?? "";
  const cwd = paths?.defaultCwd ?? "";

  const [model, setModel] = useState("mock-model");
  const [provider, setProvider] = useState("mock");
  const [cfgOpen, setCfgOpen] = useState(false);
  const [feishuOpen, setFeishuOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);

  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("解析运行路径中…");

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

  // 启动首步：先解析运行时路径，再连接 app-server、加载历史会话。
  // 任何一步失败都会把错误写到状态栏，不会静默。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await codex.resolvePaths();
        if (cancelled) return;
        setPaths(p);
        setStatus(`路径就绪 · codexHome=${p.codexHome}`);

        // 连接 codex app-server
        const ua = await codex.start({ codexBin: p.codexBin, codexHome: p.codexHome });
        if (cancelled) return;
        setConnected(true);
        setStatus(`已连接 · ${ua}`);

        // T16：载入历史会话列表
        try {
          const l = await codex.sessionList(p.codexHome);
          if (!cancelled) setSessions(l.map((m) => ({ id: m.id, title: m.title || m.id })));
        } catch {
          /* 空目录首次运行很常见，不提示错误 */
        }
      } catch (e) {
        if (!cancelled) setStatus(`初始化失败: ${e}`);
      }
    })();
    return () => {
      cancelled = true;
      codex.stop().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // T16 自动持久化当前会话：消息变化即落库（含流式增量汇聚后的最终文本）。
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!activeThread || !codexHome) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const msgs = msgsRef.current.map((m, i) => ({
        seq: i,
        role: m.role,
        text: m.text,
      }));
      const title =
        sessions.find((s) => s.id === activeThread)?.title ||
        msgs[0]?.text.slice(0, 24) ||
        "未命名会话";
      const providerUsed = threadProviderRef.current ?? provider;
      codex
        .sessionSave({
          codexHome,
          id: activeThread,
          title,
          provider: providerUsed,
          model,
          cwd,
          messages: msgs,
        })
        .then(() => {
          setSessions((prev) => {
            if (prev.some((s) => s.id === activeThread)) return prev;
            return [...prev, { id: activeThread, title }];
          });
        })
        .catch(() => {});
    }, 500);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, activeThread, codexHome, cwd, model, provider]);

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
      } catch {
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
    if (!connected || !codexHome) {
      setStatus("运行路径尚未就绪，请稍后");
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
        const nid = await codex.threadStart({
          model: routeModel,
          modelProvider: routeProvider,
          cwd,
        });
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

  /** T16：恢复一个持久化会话（载入消息 + 线程模型/provider）。 */
  function handleLoadSession(d: codex.SessionDetail) {
    setActiveThread(d.meta.id);
    threadProviderRef.current = d.meta.provider;
    setMessages(
      d.messages.map((m) => ({ role: m.role === "user" ? "user" : "assistant", text: m.text }))
    );
    if (d.meta.provider) setProvider(d.meta.provider);
    if (d.meta.model) setModel(d.meta.model);
    setSessions((prev) =>
      prev.some((s) => s.id === d.meta.id)
        ? prev
        : [...prev, { id: d.meta.id, title: d.meta.title || d.meta.id }]
    );
  }

  function onConfigSaved(c: AppConfig) {
    if (c.model) setModel(c.model);
    if (c.modelProvider) setProvider(c.modelProvider);
  }

  /** T10：把某个内置提供商预设设为当前（持久化到 config.toml），并联动线程。 */
  async function applyProvider(preset: ModelPreset) {
    if (!codexHome) {
      setStatus("codexHome 尚未就绪");
      return;
    }
    const nextModel = preset.models.includes(model) ? model : preset.default_model;
    setProvider(preset.id);
    setModel(nextModel);
    // 持久化 provider 预设到 config.toml
    try {
      const cfg = await codex.configRead(codexHome);
      const idx = cfg.modelProviders.findIndex((p) => p.id === preset.id);
      const prov: ProviderConfig = {
        id: preset.id,
        name: preset.name,
        baseUrl: preset.base_url,
        envKey: preset.env_key,
        wireApi: preset.wire_api,
      };
      if (idx >= 0) cfg.modelProviders[idx] = prov;
      else cfg.modelProviders.push(prov);
      cfg.model = nextModel;
      cfg.modelProvider = preset.id;
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
        <button className="new-btn" onClick={() => setSessionsOpen(true)}>
          ☰ 历史
        </button>
        <div className="conn">
          <div className={`dot ${connected ? "on" : "off"}`} /> {status}
        </div>
      </aside>

      <main className="main">
        <ApprovalPanel approvals={approvals} onRespond={respondApproval} />
        <section className="msglist">
          {messages.length === 0 && (
            <div className="placeholder">
              输入指令开始与 Agent 对话
              {paths && (
                <div className="muted">
                  codexHome: {paths.codexHome}
                  <br />
                  cwd: {paths.defaultCwd}
                </div>
              )}
            </div>
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
            disabled={pending || running || !paths}
          />
          <button onClick={send} disabled={pending || running || !paths}>
            发送
          </button>
          <span className="cfg">
            model={model} provider={provider} · cwd={cwd || "…"}
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
      <SessionsPanel
        open={sessionsOpen}
        onClose={() => setSessionsOpen(false)}
        codexHome={codexHome}
        onLoad={handleLoadSession}
        onStatus={setStatus}
      />
    </div>
  );
}
