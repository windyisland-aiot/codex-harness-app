//! T06 基础对话 UI：三栏布局（侧栏会话列表 / 中心对话 / 右栏审批详情）
//! + 顶部工具条 + 首次启动向导 + Ask / Code 双模式按钮
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
  SessionMeta,
} from "./codexClient";
import { MODEL_PRESETS, presetFor } from "./models";
import type { ModelPreset } from "./models";

interface Msg {
  role: "user" | "assistant";
  text: string;
}

type SessionStatus = "running" | "approval" | "waiting" | "done" | "error";

interface SessionExt {
  id: string;
  title: string;
  updatedAt?: number;
  status?: SessionStatus;
  provider?: string;
  model?: string;
}

const POLL_MS = 200;
const ONBOARDING_KEY = "harness.onboarding.v1";

/** 基于状态推导会话徽章：running → approval → waiting → done。 */
function deriveBadge(opts: {
  running: boolean;
  approvalCount: number;
  hasMessages: boolean;
  hasError: boolean;
}): SessionStatus {
  if (opts.hasError) return "error";
  if (opts.approvalCount > 0) return "approval";
  if (opts.running) return "running";
  if (opts.hasMessages) return "done";
  return "waiting";
}

const BADGE_LABEL: Record<SessionStatus, string> = {
  running: "运行中",
  approval: "待审批",
  waiting: "待使用",
  done: "已完成",
  error: "出错",
};

const STARTER_CHIPS = [
  {
    icon: "⌨",
    title: "解释代码库",
    text: "帮我分析当前工作目录的代码结构并生成一个 README 摘要",
  },
  {
    icon: "🧪",
    title: "写测试",
    text: "为最近修改过的文件生成单元测试并运行",
  },
  {
    icon: "🐞",
    title: "调试修复",
    text: "运行项目测试套件，若有失败请定位原因并修复",
  },
  {
    icon: "📦",
    title: "构建发布",
    text: "执行打包构建，生成产物并说明部署步骤",
  },
];

export default function App() {
  // 运行时路径：渲染一次后由 harness_resolve_paths 异步填入（跨平台安全）。
  const [paths, setPaths] = useState<ResolvedPaths | null>(null);
  const codexHome = paths?.codexHome ?? "";
  const cwd = paths?.defaultCwd ?? "";

  // T10 默认模型：用户要求先写死火山方舟 Ark Code（后期可更换）。
  const [model, setModel] = useState("ark-code-latest");
  const [provider, setProvider] = useState("volcengine-ark");

  // 各类 modal 开关
  const [cfgOpen, setCfgOpen] = useState(false);
  const [feishuOpen, setFeishuOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);

  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("解析运行路径中…");
  const [lastError, setLastError] = useState<string | null>(null);

  const [sessions, setSessions] = useState<SessionExt[]>([]);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<"ask" | "code">("code");
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [sideSearch, setSideSearch] = useState("");

  // T11 模型路由
  const [autoRoute, setAutoRoute] = useState(true);
  const [sensitive, setSensitive] = useState(false);

  // 首次启动向导
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [oboUsername, setOboUsername] = useState("");
  const [oboKey, setOboKey] = useState("");

  const threadProviderRef = useRef<string | null>(null);
  const runningRef = useRef(false);
  const activeThreadRef = useRef<string | null>(null);
  const msgsRef = useRef<Msg[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const approvalsRef = useRef<ApprovalRequest[]>([]);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);
  useEffect(() => {
    activeThreadRef.current = activeThread;
  }, [activeThread]);
  useEffect(() => {
    msgsRef.current = messages;
  }, [messages]);
  useEffect(() => {
    approvalsRef.current = approvals;
  }, [approvals]);

  // 启动首步：先解析运行时路径，再连接 app-server、加载历史会话。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await codex.resolvePaths();
        if (cancelled) return;
        setPaths(p);
        setStatus(`路径就绪`);

        const ua = await codex.start({ codexBin: p.codexBin, codexHome: p.codexHome });
        if (cancelled) return;
        setConnected(true);
        setStatus(`已连接 · ${ua}`);

        // 默认模型：若配置文件已写入则优先使用（Rust 侧 default_ark_config 保证首次启动即为 Ark）。
        try {
          const cfg = await codex.configRead(p.codexHome);
          if (cfg.model) setModel(cfg.model);
          if (cfg.modelProvider) setProvider(cfg.modelProvider);
          const preset = presetFor(cfg.modelProvider || "");
          if (preset && cfg.model && !preset.models.includes(cfg.model)) {
            setModel(preset.default_model);
          }
        } catch {
          /* 首次无配置文件时用前端默认 */
        }

        // T16：载入历史会话
        try {
          const l: SessionMeta[] = await codex.sessionList(p.codexHome);
          if (!cancelled) {
            setSessions(
              l.map((m) => ({
                id: m.id,
                title: m.title || m.id,
                updatedAt: m.updatedAt
                  ? new Date(String(m.updatedAt)).getTime()
                  : undefined,
                provider: m.provider,
                model: m.model,
                status: "done",
              }))
            );
          }
        } catch {
          /* 空目录首次运行常见，不提示错误 */
        }

        // 首次启动判断：无历史会话 + localStorage 未标记 → 弹出向导
        try {
          const already = window.localStorage.getItem(ONBOARDING_KEY);
          if (!already && sessions.length === 0) {
            setOnboardingOpen(true);
          }
        } catch {
          /* localStorage 受限环境（SSR/Tauri WebView）静默 */
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!cancelled) {
          setLastError(msg);
          setStatus(`初始化失败: ${msg}`);
        }
      }
    })();
    return () => {
      cancelled = true;
      codex.stop().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // T16 自动持久化当前会话
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
            return [...prev, { id: activeThread, title, provider: providerUsed, model }];
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
            setLastError(null);
            continue;
          }
          if (e.method === "error") {
            const d = (e.params as Record<string, unknown> | undefined);
            const msg = d && typeof d.message === "string" ? d.message : String(d ?? "模型调用错误");
            setLastError(msg);
          }
          const d = codex.textDelta(e);
          if (d === null) continue;
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
        const msg = e instanceof Error ? e.message : String(e);
        setStatus(`事件推送错误: ${msg}`);
        setLastError(msg);
        setRunning(false);
      }
    }, POLL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [running]);

  // 轮询审批请求
  useEffect(() => {
    if (!connected) return;
    const t = setInterval(async () => {
      try {
        const list = await codex.pollApprovals();
        if (list.length > 0) {
          setApprovals((prev) => {
            const seen = new Set(prev.map((a) => a.id));
            return [...prev, ...list.filter((a) => !seen.has(a.id))];
          });
        }
      } catch {
        // 轮询失败静默
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [connected]);

  // 状态栏文本（派生）
  const connDot: "on" | "off" | "warn" = running
    ? "on"
    : approvals.length > 0
    ? "warn"
    : connected
    ? "on"
    : "off";
  const connText = running
    ? "Agent 运行中…"
    : approvals.length > 0
    ? `${approvals.length} 条审批待处理`
    : connected
    ? status
    : lastError
    ? `未连接：${lastError}`
    : status;

  // 当前激活会话状态徽章（仅用于活动线程在侧栏列表里的展示）
  const activeStatus = deriveBadge({
    running,
    approvalCount: approvals.length,
    hasMessages: messages.length > 0,
    hasError: !!lastError,
  });

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
    setLastError(null);

    const next = [...msgsRef.current, { role: "user" as const, text }];
    setMessages(next);

    try {
      // Ask / Code 模式：影响 system hint（通过 T11 路由 sensitive 联动 + 提示词前缀）。
      const promptWithMode = mode === "ask"
        ? `[Ask 模式：只回答问题，不要执行命令或修改文件]\n${text}`
        : text;
      // Code 模式打开更多执行权限（通过 autoRoute 默认即可，ask 时关闭敏感/自动执行）
      const curSensitive = mode === "ask" ? false : sensitive;

      let routeModel = model;
      let routeProvider = provider;
      if (autoRoute) {
        try {
          const d = await codex.route(promptWithMode, { sensitive: curSensitive });
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
          {
            id: nid,
            title: text.slice(0, 24) + (text.length > 24 ? "…" : ""),
            provider: routeProvider,
            model: routeModel,
            status: "running",
          },
        ]);
      } else if (autoRoute && routeModel !== model) {
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
      await codex.turnStart({ threadId: tid, cwd, text: promptWithMode });
      setRunning(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLastError(msg);
      setStatus(`发送失败: ${msg}`);
    } finally {
      setPending(false);
    }
  }

  function newChat() {
    setActiveThread(null);
    setMessages([]);
    setApprovals([]);
    setRunning(false);
    setLastError(null);
    threadProviderRef.current = null;
  }

  /** T16：载入历史会话（通过独立 SessionsPanel modal） */
  function handleLoadSession(d: codex.SessionDetail) {
    setActiveThread(d.meta.id);
    threadProviderRef.current = d.meta.provider ?? null;
    setMessages(
      d.messages.map((m) => ({ role: m.role === "user" ? "user" : "assistant", text: m.text }))
    );
    if (d.meta.provider) setProvider(d.meta.provider);
    if (d.meta.model) setModel(d.meta.model);
    setSessions((prev) =>
      prev.some((s) => s.id === d.meta.id)
        ? prev
        : [...prev, {
            id: d.meta.id,
            title: d.meta.title || d.meta.id,
            provider: d.meta.provider,
            model: d.meta.model,
            status: "done",
          }]
    );
    setSessionsOpen(false);
  }

  /** 点击侧栏某会话：先尝试从磁盘恢复，找不到则空壳切换（后续会被覆盖保存）。 */
  async function handleSideSessionClick(id: string) {
    if (!codexHome) return;
    try {
      const d = await codex.sessionGet(codexHome, id);
      handleLoadSession(d);
    } catch {
      // 侧栏显示但磁盘未保存：仅切换当前活动 ID
      setActiveThread(id);
      setMessages([]);
      setApprovals([]);
      threadProviderRef.current = null;
    }
  }

  function onConfigSaved(c: AppConfig) {
    if (c.model) setModel(c.model);
    if (c.modelProvider) setProvider(c.modelProvider);
  }

  async function applyProvider(preset: ModelPreset) {
    if (!codexHome) {
      setStatus("codexHome 尚未就绪");
      return;
    }
    const nextModel = preset.models.includes(model) ? model : preset.default_model;
    setProvider(preset.id);
    setModel(nextModel);
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
    const tid = activeThreadRef.current;
    if (tid && threadProviderRef.current === preset.id) {
      try {
        await codex.threadSetModel(tid, nextModel);
      } catch (e) {
        setStatus(`切换线程模型失败: ${e}`);
      }
    }
  }

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

  function finishOnboarding() {
    try {
      window.localStorage.setItem(ONBOARDING_KEY, "1");
    } catch {}
    setOnboardingOpen(false);
  }

  const filteredSessions = sessions
    .filter(
      (s) =>
        !sideSearch ||
        s.title.toLowerCase().includes(sideSearch.toLowerCase())
    )
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  const presetName =
    MODEL_PRESETS.find((p) => p.id === provider)?.name || provider || "未知";

  return (
    <div className="app-shell">
      {/* ============ 顶部工具条 ============ */}
      <header className="topbar">
        <div className="brand">
          <div className="brand-logo">C</div>
          <span>Codex Harness</span>
        </div>

        <button
          className="tool-btn"
          onClick={newChat}
          title="新建会话 (Ctrl+N)"
        >
          <span>＋</span> 新建
          <span className="kbd">Ctrl N</span>
        </button>

        <div className="model-switch">
          <ModelSwitcher
            provider={provider}
            model={model}
            onProvider={applyProvider}
            onModel={applyModel}
          />
        </div>

        <div className="spacer" />

        <RouterPanel
          prompt={input}
          disabled={pending || running}
          autoRoute={autoRoute}
          onAutoRouteChange={setAutoRoute}
          sensitive={sensitive}
          onSensitiveChange={setSensitive}
          onRouted={handleRouted}
        />

        <button
          className={`tool-btn ${cfgOpen ? "active" : ""}`}
          onClick={() => setCfgOpen(true)}
          title="配置 (,)"
        >
          ⚙ <span>配置</span>
        </button>
        <button
          className={`tool-btn ${searchOpen ? "active" : ""}`}
          onClick={() => setSearchOpen(true)}
          title="联网搜索"
        >
          ⌕ <span>搜索</span>
        </button>
        <button
          className={`tool-btn ${pluginsOpen ? "active" : ""}`}
          onClick={() => setPluginsOpen(true)}
          title="技能 / 插件"
        >
          ⚇ <span>技能</span>
        </button>
        <button
          className={`tool-btn ${feishuOpen ? "active" : ""}`}
          onClick={() => setFeishuOpen(true)}
          title="飞书 OAuth / MCP"
        >
          ✈ <span>飞书</span>
        </button>

        <div className="model-chip" title={`${presetName} · ${model}`}>
          ▣ {model}
        </div>
        <div className="status-pill" title={connText}>
          <span className={`dot ${connDot}`} />
          <span>{connText}</span>
        </div>
      </header>

      {/* ============ 三栏工作区 ============ */}
      <div className="workspace">
        {/* 左栏：会话列表 */}
        <aside className="sidebar">
          <div className="side-head">
            <button className="new-chat-btn" onClick={newChat}>
              ＋ 新建对话
            </button>
            <input
              className="side-search"
              placeholder="搜索会话…"
              value={sideSearch}
              onChange={(e) => setSideSearch(e.target.value)}
            />
          </div>
          <div className="side-section-label">会话 · Sessions</div>
          <ul className="sessions">
            {filteredSessions.length === 0 && (
              <li style={{ cursor: "default", opacity: 0.7 }}>
                <div className="s-title">（暂无会话）</div>
                <div className="s-meta">输入指令开始第一个任务</div>
              </li>
            )}
            {filteredSessions.map((s) => {
              const isActive = s.id === activeThread;
              const st: SessionStatus = isActive
                ? activeStatus
                : s.status || "done";
              const dayLabel = s.updatedAt
                ? new Date(s.updatedAt).toLocaleDateString(undefined, {
                    month: "2-digit",
                    day: "2-digit",
                  })
                : "—";
              return (
                <li
                  key={s.id}
                  className={isActive ? "active" : ""}
                  onClick={() => handleSideSessionClick(s.id)}
                >
                  <div className="s-title">{s.title}</div>
                  <div className="s-meta">
                    <span className={`badge ${st}`}>{BADGE_LABEL[st]}</span>
                    <span>{s.provider || provider || "—"}</span>
                    <span style={{ marginLeft: "auto" }}>{dayLabel}</span>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="side-footer">
            <div className="avatar" title={oboUsername || "本机用户"}>
              {oboUsername ? oboUsername.slice(0, 1).toUpperCase() : "U"}
            </div>
            <div className="user-info">
              <span className="n">{oboUsername || "本机用户"}</span>
              <span className="r">{cwd ? `cwd: ${shortPath(cwd)}` : "单机模式"}</span>
            </div>
            <button
              className="tool-btn"
              onClick={() => setSessionsOpen(true)}
              title="历史会话管理"
              style={{ padding: "4px 8px" }}
            >
              ☰
            </button>
          </div>
        </aside>

        {/* 中栏：对话 */}
        <main className="center">
          <div className="thread-head">
            <div className="title">
              {activeThread
                ? sessions.find((s) => s.id === activeThread)?.title ||
                  "新对话"
                : messages.length > 0
                ? "对话"
                : "新对话"}
            </div>
            <div className="crumbs">
              <code title={cwd}>{shortPath(cwd || "未就绪")}</code>
              <code>{presetName}</code>
              {activeThread && (
                <code title={activeThread}>#{activeThread.slice(0, 8)}</code>
              )}
            </div>
          </div>

          <section className="msglist">
            {messages.length === 0 ? (
              <div className="placeholder">
                <h2>Codex Agent 工作台</h2>
                <div>
                  以自然语言下达任务，Agent 自动调用工具、执行命令、修改代码。
                </div>
                <div className="muted">
                  当前模型：{presetName} · {model}
                  {paths && (
                    <>
                      <br />
                      codexHome: {shortPath(paths.codexHome)}
                    </>
                  )}
                </div>
                <div className="shortcuts">
                  {STARTER_CHIPS.map((c) => (
                    <div
                      key={c.title}
                      className="chip"
                      onClick={() => {
                        setInput(c.text);
                        setMode("code");
                      }}
                    >
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>
                        {c.icon} {c.title}
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--text-muted)",
                          lineHeight: 1.45,
                        }}
                      >
                        {c.text}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m, i) => (
                <div key={i} className={`msg ${m.role}`}>
                  <div
                    className="avatar-mini"
                    title={m.role === "user" ? oboUsername || "User" : "Agent"}
                  >
                    {m.role === "user"
                      ? oboUsername
                        ? oboUsername.slice(0, 1).toUpperCase()
                        : "U"
                      : "A"}
                  </div>
                  <div className="bubble md">
                    <Markdown text={m.text} />
                  </div>
                </div>
              ))
            )}
            {running && (
              <div className="msg assistant">
                <div className="avatar-mini">A</div>
                <div className="bubble typing">
                  <span className="dots" />
                  <span>
                    {mode === "ask" ? "思考中" : "Agent 正在执行任务"}…
                  </span>
                </div>
              </div>
            )}
            {lastError && !running && (
              <div className="msg assistant">
                <div
                  className="avatar-mini"
                  style={{ background: "linear-gradient(135deg, #f85149, #b62324)" }}
                >
                  !
                </div>
                <div
                  className="bubble"
                  style={{
                    background: "#2a1618",
                    borderColor: "#5a2428",
                    color: "#ffc9cb",
                  }}
                >
                  <strong>出错：</strong>
                  {lastError}
                </div>
              </div>
            )}
          </section>

          {/* 输入栏：Ask / Code 双按钮 */}
          <footer className="composer">
            <div className="composer-inner">
              <textarea
                rows={1}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height =
                    Math.min(e.target.scrollHeight, 180) + "px";
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder={
                  mode === "ask"
                    ? "询问任何问题（Ask 模式：不会执行命令 / 修改文件）…"
                    : "下达一个任务（Code 模式：Agent 将执行命令 / 修改文件 / 调用工具）…"
                }
                disabled={pending || running || !paths}
              />
              <div className="composer-actions">
                <button
                  className="btn-ask"
                  disabled={pending || running || !paths || !input.trim()}
                  onClick={() => {
                    setMode("ask");
                    setTimeout(send, 0);
                  }}
                >
                  💬 Ask
                </button>
                <button
                  className="btn-code"
                  disabled={pending || running || !paths || !input.trim()}
                  onClick={() => {
                    setMode("code");
                    setTimeout(send, 0);
                  }}
                >
                  ▶ Code
                </button>
              </div>
            </div>
            <div className="composer-meta">
              <div className="left">
                <label className="tiny-switch">
                  <input
                    type="checkbox"
                    checked={mode === "code"}
                    onChange={(e) => setMode(e.target.checked ? "code" : "ask")}
                  />
                  允许执行命令 / 改文件
                </label>
                <label className="tiny-switch">
                  <input
                    type="checkbox"
                    checked={autoRoute}
                    onChange={(e) => setAutoRoute(e.target.checked)}
                  />
                  自动路由模型
                </label>
                <label className="tiny-switch">
                  <input
                    type="checkbox"
                    checked={sensitive}
                    onChange={(e) => setSensitive(e.target.checked)}
                  />
                  敏感任务
                </label>
              </div>
              <div className="right">
                <span>
                  Enter 发送 · Shift+Enter 换行
                </span>
              </div>
            </div>
          </footer>
        </main>

        {/* 右栏：审批面板 */}
        <aside className="right">
          <ApprovalPanel approvals={approvals} onRespond={respondApproval} />
        </aside>
      </div>

      {/* ============ Modals ============ */}
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

      {/* ============ 首次启动向导 ============ */}
      {onboardingOpen && (
        <div className="onboarding">
          <div className="onboarding-inner">
            <h1>欢迎使用 Codex Harness</h1>
            <div className="sub">
              你的本地 Agent 工作台。火山方舟 Ark Code 已预置为默认模型。
            </div>
            <div className="steps">
              <div className={`step ${onboardingStep >= 1 ? "done" : onboardingStep === 0 ? "now" : ""}`} />
              <div className={`step ${onboardingStep >= 2 ? "done" : onboardingStep === 1 ? "now" : ""}`} />
              <div className={`step ${onboardingStep === 2 ? "now" : ""}`} />
            </div>

            {onboardingStep === 0 && (
              <div className="onboarding-card">
                <h3>🛠 默认模型已就绪</h3>
                <p>
                  火山方舟 Ark Code（ark-code-latest）已被设为默认模型，
                  API Key 已写死在后端，可直接开箱使用。
                  你稍后可以在「配置」中切换到其他厂商。
                </p>
                <div className="ok">✓ base_url: https://ark.cn-beijing.volces.com/api/coding/v3</div>
                <div className="ok">✓ env_key: VOLCENGINE_ARK_API_KEY 已注入到子进程</div>
              </div>
            )}

            {onboardingStep === 1 && (
              <div className="onboarding-card">
                <h3>👤 账号（单机模式）</h3>
                <p>当前为单机运行。填写以下信息用于界面展示。</p>
                <div className="onboarding-form" style={{ marginTop: 10 }}>
                  <div>
                    <label>昵称</label>
                    <input
                      type="text"
                      value={oboUsername}
                      onChange={(e) => setOboUsername(e.target.value)}
                      placeholder="例如：张三"
                    />
                  </div>
                  <div>
                    <label>自定义 API Key（可选，留空则使用预置）</label>
                    <input
                      type="password"
                      value={oboKey}
                      onChange={(e) => setOboKey(e.target.value)}
                      placeholder="自定义火山方舟 API Key（后期替换用）"
                    />
                  </div>
                </div>
              </div>
            )}

            {onboardingStep === 2 && (
              <div className="onboarding-card">
                <h3>🚀 开始你的第一个任务</h3>
                <p>
                  点击下方完成即可进入工作台。你可以直接尝试让 Agent：
                </p>
                <ul style={{ color: "var(--text-secondary)", fontSize: 12, paddingLeft: 18, margin: 0 }}>
                  <li>分析当前目录下的项目结构</li>
                  <li>运行测试并修复失败的用例</li>
                  <li>为你的代码生成文档</li>
                </ul>
              </div>
            )}

            <div className="onboarding-foot">
              <button
                onClick={() => {
                  if (onboardingStep === 0) finishOnboarding();
                  else setOnboardingStep((s) => s - 1);
                }}
              >
                {onboardingStep === 0 ? "跳过" : "上一步"}
              </button>
              {onboardingStep < 2 ? (
                <button
                  className="primary"
                  onClick={() => setOnboardingStep((s) => s + 1)}
                >
                  下一步
                </button>
              ) : (
                <button className="primary" onClick={finishOnboarding}>
                  完成，开始使用
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 缩小路径显示：保留末两段。 */
function shortPath(p: string): string {
  if (!p) return "—";
  const sep = p.includes("\\") ? "\\" : "/";
  const parts = p.split(sep).filter(Boolean);
  if (parts.length <= 2) return p;
  return "…/" + parts.slice(-2).join(sep);
}
