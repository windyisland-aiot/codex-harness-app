//! T06 基础对话 UI（Trae Work 风格布局 v4）：
//! - 顶栏：品牌 / Work|Code|Design 三段切换 / 新建 / 模型 / 状态 pill
//! - 左栏：窄图标条（对话/文件）+ 宽面板（会话列表 或 文件资源管理器）
//! - 中栏：对话 + 欢迎页 + 输入器（Work|Code 双按钮）
//! - 右栏：抽屉（审批/会话/终端/浏览器/画布/快捷键）+ 可折叠
//! - 主题：浅/深可切换，中性 CTA 按钮，无 emoji
//!
//! 运行时路径：由 `codex.resolvePaths()` 向 Tauri 后端请求跨平台的
//! codexHome / codexBin / defaultCwd。禁止写死 Linux `/workspace/...`。
import { useEffect, useRef, useState } from "react";
import Markdown from "./components/Markdown";
import ConfigPanel from "./components/ConfigPanel";
import ModelSwitcher from "./components/ModelSwitcher";
import RouterPanel from "./components/RouterPanel";
import FeishuOAuthPanel from "./components/FeishuOAuthPanel";
import PluginsPanel from "./components/PluginsPanel";
import SearchPanel from "./components/SearchPanel";
import SessionsPanel from "./components/SessionsPanel";
import ToolPanel from "./components/ToolPanel";
import FileTree from "./components/FileTree";
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

/** 左侧活动面板：会话列表 / 文件树。更多图标功能通过 modal 打开。 */
type LeftPanelKind = "chat" | "files";

interface RailItem {
  id: LeftPanelKind | "search" | "plugins" | "feishu" | "sessions" | "settings" | "approvals";
  label: string;
  glyph: string;
}

const RAIL: RailItem[] = [
  { id: "chat", label: "对话", glyph: "C" },
  { id: "files", label: "文件", glyph: "F" },
  { id: "search", label: "搜索", glyph: "S" },
  { id: "plugins", label: "插件", glyph: "P" },
  { id: "feishu", label: "飞书", glyph: "L" },
  { id: "sessions", label: "会话", glyph: "H" },
  { id: "settings", label: "设置", glyph: "G" },
];

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
  { title: "解释代码库", text: "帮我分析当前工作目录的代码结构并生成一个 README 摘要" },
  { title: "写测试", text: "为最近修改过的文件生成单元测试并运行" },
  { title: "调试修复", text: "运行项目测试套件，若有失败请定位原因并修复" },
  { title: "构建发布", text: "执行打包构建，生成产物并说明部署步骤" },
];

export default function App() {
  // ------- 运行时路径 -------
  const [paths, setPaths] = useState<ResolvedPaths | null>(null);
  const codexHome = paths?.codexHome ?? "";
  const cwd = paths?.defaultCwd ?? "";

  // ------- 默认模型 -------
  const [model, setModel] = useState("ark-code-latest");
  const [provider, setProvider] = useState("volcengine-ark");

  // ------- 各类 modal 开关（点击 rail 图标触发；保留原 ConfigPanel 等独立组件） -------
  const [cfgOpen, setCfgOpen] = useState(false);
  const [feishuOpen, setFeishuOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);

  // ------- 连接 & 状态 -------
  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("解析运行路径中…");
  const [lastError, setLastError] = useState<string | null>(null);

  // ------- 会话 / 对话状态 -------
  const [sessions, setSessions] = useState<SessionExt[]>([]);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<"ask" | "code">("code");
  const [visualMode, setVisualModeState] = useState<"work" | "code" | "design">("code");
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [sideSearch, setSideSearch] = useState("");

  // ------- 主题 -------
  const [theme, setThemeState] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "light";
    const saved = window.localStorage.getItem("harness.theme");
    if (saved === "dark" || saved === "light") return saved;
    const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    return prefersDark ? "dark" : "light";
  });
  const setTheme = (t: "light" | "dark") => {
    setThemeState(t);
    if (typeof window !== "undefined") window.localStorage.setItem("harness.theme", t);
  };

  // ------- 路由 -------
  const [autoRoute, setAutoRoute] = useState(true);
  const [sensitive, setSensitive] = useState(false);

  // ------- Onboarding -------
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [oboUsername, setOboUsername] = useState("");
  const [oboKey, setOboKey] = useState("");

  // ------- Trae Work 新布局：左栏 + 右抽屉状态 -------
  const [leftPanel, setLeftPanel] = useState<LeftPanelKind>("chat");
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  /** 终端 Tab 内显示的命令输出行（从事件流提取 delta）。 */
  const [terminalLines, setTerminalLines] = useState<
    Array<{ ts: number; text: string; stream?: "stdout" | "stderr" | "meta" }>
  >([]);
  const [browserUrl, setBrowserUrl] = useState("");

  // ------- Refs 用于 timer 里拿最新值 -------
  const threadProviderRef = useRef<string | null>(null);
  const runningRef = useRef(false);
  const activeThreadRef = useRef<string | null>(null);
  const msgsRef = useRef<Msg[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const approvalsRef = useRef<ApprovalRequest[]>([]);
  const termRef = useRef(terminalLines);
  useEffect(() => { runningRef.current = running; }, [running]);
  useEffect(() => { activeThreadRef.current = activeThread; }, [activeThread]);
  useEffect(() => { msgsRef.current = messages; }, [messages]);
  useEffect(() => { approvalsRef.current = approvals; }, [approvals]);
  useEffect(() => { termRef.current = terminalLines; }, [terminalLines]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (theme === "dark") document.body.classList.add("theme-dark");
    else document.body.classList.remove("theme-dark");
  }, [theme]);

  useEffect(() => {
    if (mode === "ask") setVisualModeState("work");
    else if (visualMode === "work") setVisualModeState("code");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // ------- 启动首步：解析路径 + 连接 app-server + 加载历史会话 -------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await codex.resolvePaths();
        if (cancelled) return;
        setPaths(p);
        setStatus("路径就绪");

        const ua = await codex.start({ codexBin: p.codexBin, codexHome: p.codexHome });
        if (cancelled) return;
        setConnected(true);
        setStatus(`已连接 · ${ua}`);

        try {
          const cfg = await codex.configRead(p.codexHome);
          if (cfg.model) setModel(cfg.model);
          if (cfg.modelProvider) setProvider(cfg.modelProvider);
          const preset = presetFor(cfg.modelProvider || "");
          if (preset && cfg.model && !preset.models.includes(cfg.model)) {
            setModel(preset.default_model);
          }
        } catch { /* 首次无配置用前端默认 */ }

        try {
          const l: SessionMeta[] = await codex.sessionList(p.codexHome);
          if (!cancelled) {
            setSessions(
              l.map((m) => ({
                id: m.id,
                title: m.title || m.id,
                updatedAt: m.updatedAt ? new Date(String(m.updatedAt)).getTime() : undefined,
                provider: m.provider,
                model: m.model,
                status: "done",
              }))
            );
          }
        } catch { /* 首次空目录常见，静默 */ }

        try {
          const already = window.localStorage.getItem(ONBOARDING_KEY);
          if (!already && sessions.length === 0) setOnboardingOpen(true);
        } catch { /* localStorage 受限 */ }
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

  // ------- T16 自动持久化 -------
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!activeThread || !codexHome) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const msgs = msgsRef.current.map((m, i) => ({ seq: i, role: m.role, text: m.text }));
      const title =
        sessions.find((s) => s.id === activeThread)?.title ||
        msgs[0]?.text.slice(0, 24) ||
        "未命名会话";
      const providerUsed = threadProviderRef.current ?? provider;
      codex
        .sessionSave({
          codexHome, id: activeThread, title, provider: providerUsed, model, cwd, messages: msgs,
        })
        .then(() => {
          setSessions((prev) =>
            prev.some((s) => s.id === activeThread)
              ? prev
              : [...prev, { id: activeThread, title, provider: providerUsed, model }]
          );
        })
        .catch(() => {});
    }, 500);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, activeThread, codexHome, cwd, model, provider]);

  // ------- 轮询流式事件 + 抓取终端输出 -------
  useEffect(() => {
    if (!running) return;
    timerRef.current = setInterval(async () => {
      if (!runningRef.current) return;
      try {
        const events = await codex.pollEvents();
        const termAccum: Array<{ ts: number; text: string; stream?: "stdout" | "stderr" | "meta" }> = [];
        for (const e of events) {
          if (e.method === "turn/completed") { setRunning(false); setLastError(null); continue; }
          if (e.method === "error") {
            const d = e.params as Record<string, unknown> | undefined;
            const msg = d && typeof d.message === "string" ? d.message : String(d ?? "模型调用错误");
            setLastError(msg);
            termAccum.push({ ts: Date.now(), text: "[ERROR] " + msg, stream: "stderr" });
          }
          // --- 抓取命令输出（Codex 两种 method 名做双保险）---
          const cmdDelta = extractCmdDelta(e);
          if (cmdDelta) termAccum.push(cmdDelta);

          const d = codex.textDelta(e);
          if (d === null) continue;
          const cur = msgsRef.current;
          if (cur.length > 0 && cur[cur.length - 1].role === "assistant") {
            const list = [...cur];
            list[list.length - 1] = { ...list[list.length - 1], text: list[list.length - 1].text + d };
            setMessages(list);
          } else {
            setMessages([...cur, { role: "assistant", text: d }]);
          }
        }
        if (termAccum.length > 0) {
          setTerminalLines((prev) => [...prev, ...termAccum].slice(-500));
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setStatus(`事件推送错误: ${msg}`);
        setLastError(msg);
        setRunning(false);
      }
    }, POLL_MS);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [running]);

  // ------- 轮询审批 -------
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
      } catch { /* 静默 */ }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [connected]);

  // ------- 状态派生 -------
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
  const activeStatus = deriveBadge({
    running, approvalCount: approvals.length,
    hasMessages: messages.length > 0, hasError: !!lastError,
  });

  const presetName = MODEL_PRESETS.find((p) => p.id === provider)?.name || provider || "未知";

  // ------- 动作回调 -------
  async function respondApproval(id: number, decision: string) {
    try {
      await codex.respondApproval(id, decision);
      setApprovals((prev) => prev.filter((a) => a.id !== id));
      setTerminalLines((prev) => [
        ...prev,
        { ts: Date.now(), text: `[审批 #${id}] ${decision}`, stream: "meta" as const },
      ].slice(-500));
    } catch (e) { setStatus(`审批回复失败: ${e}`); }
  }

  async function send() {
    const text = input.trim();
    if (!text || pending) return;
    if (!connected || !codexHome) { setStatus("运行路径尚未就绪，请稍后"); return; }
    setPending(true); setInput(""); setLastError(null);

    const next = [...msgsRef.current, { role: "user" as const, text }];
    setMessages(next);
    setTerminalLines((prev) => [
      ...prev, { ts: Date.now(), text: `[user]: ${text.slice(0, 160)}${text.length > 160 ? "…" : ""}`, stream: "meta" as const },
    ].slice(-500));

    try {
      const promptWithMode = mode === "ask"
        ? `[Ask 模式：只回答问题，不要执行命令或修改文件]\n${text}`
        : text;
      const curSensitive = mode === "ask" ? false : sensitive;
      let routeModel = model; let routeProvider = provider;
      if (autoRoute) {
        try {
          const d = await codex.route(promptWithMode, { sensitive: curSensitive });
          routeModel = d.model; routeProvider = d.provider;
        } catch (e) { setStatus(`路由失败，回退当前模型: ${e}`); }
      }
      let threadId = activeThreadRef.current;
      if (!threadId) {
        const nid = await codex.threadStart({ model: routeModel, modelProvider: routeProvider, cwd });
        threadId = nid;
        threadProviderRef.current = routeProvider;
        setActiveThread(nid);
        setSessions((s) => [...s, {
          id: nid,
          title: text.slice(0, 24) + (text.length > 24 ? "…" : ""),
          provider: routeProvider, model: routeModel, status: "running",
        }]);
      } else if (autoRoute && routeModel !== model) {
        try { await codex.threadSetModel(threadId, routeModel); }
        catch (e) { setStatus(`切换路由模型失败: ${e}`); }
      }
      if (routeModel !== model || routeProvider !== provider) {
        setModel(routeModel); setProvider(routeProvider);
      }
      const tid = threadId as string;
      await codex.turnStart({ threadId: tid, cwd, text: promptWithMode });
      setRunning(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLastError(msg); setStatus(`发送失败: ${msg}`);
    } finally { setPending(false); }
  }

  function newChat() {
    setActiveThread(null); setMessages([]); setApprovals([]); setRunning(false);
    setLastError(null); threadProviderRef.current = null;
  }

  function handleLoadSession(d: codex.SessionDetail) {
    setActiveThread(d.meta.id);
    threadProviderRef.current = d.meta.provider ?? null;
    setMessages(d.messages.map((m) => ({ role: m.role === "user" ? "user" : "assistant", text: m.text })));
    if (d.meta.provider) setProvider(d.meta.provider);
    if (d.meta.model) setModel(d.meta.model);
    setSessions((prev) =>
      prev.some((s) => s.id === d.meta.id) ? prev : [...prev, {
        id: d.meta.id, title: d.meta.title || d.meta.id,
        provider: d.meta.provider, model: d.meta.model, status: "done",
      }]
    );
    setSessionsOpen(false);
  }

  async function handleSideSessionClick(id: string) {
    if (!codexHome) return;
    try {
      const d = await codex.sessionGet(codexHome, id);
      handleLoadSession(d);
    } catch {
      setActiveThread(id); setMessages([]); setApprovals([]); threadProviderRef.current = null;
    }
  }

  function onConfigSaved(c: AppConfig) {
    if (c.model) setModel(c.model);
    if (c.modelProvider) setProvider(c.modelProvider);
  }

  async function applyProvider(preset: ModelPreset) {
    if (!codexHome) { setStatus("codexHome 尚未就绪"); return; }
    const nextModel = preset.models.includes(model) ? model : preset.default_model;
    setProvider(preset.id); setModel(nextModel);
    try {
      const cfg = await codex.configRead(codexHome);
      const idx = cfg.modelProviders.findIndex((p) => p.id === preset.id);
      const prov: ProviderConfig = {
        id: preset.id, name: preset.name, baseUrl: preset.base_url,
        envKey: preset.env_key, wireApi: preset.wire_api,
      };
      if (idx >= 0) cfg.modelProviders[idx] = prov; else cfg.modelProviders.push(prov);
      cfg.model = nextModel; cfg.modelProvider = preset.id;
      await codex.configWrite(codexHome, cfg);
      setStatus(`已切换到 ${preset.name} · ${nextModel}`);
    } catch (e) { setStatus(`保存提供商失败: ${e}`); }
    const tid = activeThreadRef.current;
    if (tid && threadProviderRef.current === preset.id) {
      try { await codex.threadSetModel(tid, nextModel); }
      catch (e) { setStatus(`切换线程模型失败: ${e}`); }
    }
  }

  async function applyModel(nextModel: string) {
    setModel(nextModel);
    const tid = activeThreadRef.current;
    if (tid && threadProviderRef.current === provider) {
      try { await codex.threadSetModel(tid, nextModel); setStatus(`本会话模型已切换为 ${nextModel}`); }
      catch (e) { setStatus(`切换线程模型失败: ${e}`); }
    }
  }

  async function handleRouted(d: RouteDecision | null) {
    if (!d || d.model === model) return;
    setModel(d.model); setProvider(d.provider);
    const tid = activeThreadRef.current;
    if (tid) {
      try { await codex.threadSetModel(tid, d.model); setStatus(`已按路由应用 ${d.provider}/${d.model}`); }
      catch (e) { setStatus(`应用路由模型失败: ${e}`); }
    } else {
      setStatus(`路由推荐 ${d.provider}/${d.model}（新会话将使用）`);
    }
  }

  function finishOnboarding() {
    try { window.localStorage.setItem(ONBOARDING_KEY, "1"); } catch {}
    setOnboardingOpen(false);
  }

  function setVisualMode(vm: "work" | "code" | "design") {
    setVisualModeState(vm);
    if (vm === "work") setMode("ask");
    else setMode("code");
  }

  /** 左侧 rail 图标被点击 → 切换面板 或 打开对应 modal。 */
  function onRailClick(id: RailItem["id"]) {
    switch (id) {
      case "chat":
      case "files":
        setLeftPanel(id);
        if (leftCollapsed) setLeftCollapsed(false);
        break;
      case "search": setSearchOpen(true); break;
      case "plugins": setPluginsOpen(true); break;
      case "feishu": setFeishuOpen(true); break;
      case "sessions": setSessionsOpen(true); break;
      case "settings": setCfgOpen(true); break;
      case "approvals": setLeftCollapsed(false); break;
    }
  }

  const filteredSessions = sessions
    .filter((s) => !sideSearch || s.title.toLowerCase().includes(sideSearch.toLowerCase()))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  const approvalCount = approvals.length;

  // ------- 渲染 -------
  return (
    <div className="app-shell">
      {/* ============ 顶部栏 ============ */}
      <header className="topbar">
        <div className="brand">
          <div className="brand-logo">H</div>
          <span>Harness</span>
        </div>

        <div className="mode-switch" role="tablist" aria-label="工作模式">
          <button
            className={`mode-btn ${visualMode === "work" ? "active" : ""}`}
            onClick={() => setVisualMode("work")}
            title="Work 模式：文档 / 数据 / 办公型任务"
          >Work</button>
          <button
            className={`mode-btn ${visualMode === "code" ? "active" : ""}`}
            onClick={() => setVisualMode("code")}
            title="Code 模式：Agent 编程（执行 / 改代码 / 调用工具）"
          >Code</button>
          <button
            className={`mode-btn ${visualMode === "design" ? "active" : ""}`}
            onClick={() => setVisualMode("design")}
            title="Design 模式：AI 设计（视觉/原型/设计系统）"
          >Design</button>
        </div>

        <button className="new-btn" onClick={newChat} title="新建任务 (Ctrl+N)">
          <span>＋</span><span>新建</span><span className="kbd">Ctrl N</span>
        </button>

        <div className="model-switch">
          <ModelSwitcher provider={provider} model={model} onProvider={applyProvider} onModel={applyModel} />
        </div>

        <div className="spacer" />

        <RouterPanel
          prompt={input} disabled={pending || running}
          autoRoute={autoRoute} onAutoRouteChange={setAutoRoute}
          sensitive={sensitive} onSensitiveChange={setSensitive}
          onRouted={handleRouted}
        />

        <button
          className="icon-btn"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
        >{theme === "dark" ? "浅色" : "深色"}</button>

        {approvalCount > 0 && (
          <button
            className="icon-btn active"
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
            title={`${approvalCount} 条审批待处理`}
          >
            审批<span className="badge-dot" />
          </button>
        )}

        <div className="model-chip" title={`${presetName} · ${model}`}>{model}</div>
        <div className="status-pill" title={connText}>
          <span className={`dot ${connDot}`} />
          <span>{connText}</span>
        </div>
      </header>

      {/* ============ 工作区 ============ */}
      <div className="workspace">
        {/* ---------- 左条（图标 rail） ---------- */}
        <nav className="rail" aria-label="功能导航">
          {RAIL.map((r) => {
            const active = (r.id === "chat" && leftPanel === "chat") ||
                           (r.id === "files" && leftPanel === "files");
            const withBadge = r.id === "settings" || r.id === "plugins";
            return (
              <button
                key={r.id}
                className={`rail-item ${active ? "active" : ""}`}
                onClick={() => onRailClick(r.id)}
                title={r.label}
                aria-label={r.label}
              >
                <span className="rail-glyph">{r.glyph}</span>
                {withBadge ? null : <span className="rail-label">{r.label}</span>}
                {r.id === "settings" && <span className="rail-label">设置</span>}
                {r.id === "plugins" && <span className="rail-label">插件</span>}
              </button>
            );
          })}
          <div className="rail-spacer" />
          <button
            className="rail-item collapse-toggle"
            onClick={() => setLeftCollapsed((c) => !c)}
            title={leftCollapsed ? "展开左面板" : "收起左面板"}
          >
            <span className="rail-glyph">{leftCollapsed ? "»" : "«"}</span>
          </button>
        </nav>

        {/* ---------- 左面板（会话列表 / 文件树） ---------- */}
        {!leftCollapsed && (
          <aside className="sidebar panel-left">
            {leftPanel === "chat" && (
              <>
                <div className="side-head">
                  <button className="new-chat-btn" onClick={newChat}>＋ 新建任务</button>
                  <input
                    className="side-search"
                    placeholder="搜索任务…"
                    value={sideSearch}
                    onChange={(e) => setSideSearch(e.target.value)}
                  />
                </div>
                <div className="side-section-label">任务 · Sessions</div>
                <ul className="sessions">
                  {filteredSessions.length === 0 && (
                    <li style={{ cursor: "default", opacity: 0.7 }}>
                      <div className="s-title">（暂无任务）</div>
                      <div className="s-meta">输入指令开始第一个任务</div>
                    </li>
                  )}
                  {filteredSessions.map((s) => {
                    const isActive = s.id === activeThread;
                    const st: SessionStatus = isActive ? activeStatus : s.status || "done";
                    const dayLabel = s.updatedAt
                      ? new Date(s.updatedAt).toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" })
                      : "—";
                    return (
                      <li
                        key={s.id}
                        className={isActive ? "active" : ""}
                        onClick={() => handleSideSessionClick(s.id)}
                      >
                        <div className="s-title">
                          <span className={`s-dot ${st}`} />
                          <span className="s-text">{s.title}</span>
                        </div>
                        <div className="s-meta">
                          <span className={`badge ${st}`}>{BADGE_LABEL[st]}</span>
                          <span>{s.provider || provider || "—"}</span>
                          <span style={{ marginLeft: "auto" }}>{dayLabel}</span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            {leftPanel === "files" && (
              <FileTree
                root={cwd}
                onFileSelect={(rel, e) => setStatus(`选中文件：${rel}（${e.size ?? "?"}B）`)}
              />
            )}
            <div className="side-footer">
              <div className="avatar" title={oboUsername || "本机用户"}>
                {oboUsername ? oboUsername.slice(0, 1).toUpperCase() : "U"}
              </div>
              <div className="user-info">
                <span className="n">{oboUsername || "本机用户"}</span>
                <span className="r">{cwd ? `cwd: ${shortPath(cwd)}` : "单机模式"}</span>
              </div>
              <button
                className="icon-btn"
                onClick={() => setSessionsOpen(true)}
                title="历史会话管理"
                aria-label="历史会话管理"
              >≡</button>
            </div>
          </aside>
        )}

        {/* ---------- 中栏：对话 ---------- */}
        <main className="center">
          <div className="thread-head">
            <div className="title">
              {activeThread
                ? sessions.find((s) => s.id === activeThread)?.title || "新任务"
                : messages.length > 0 ? "任务对话" : "新任务"}
            </div>
            <div className="crumbs">
              <code title={cwd}>{shortPath(cwd || "未就绪")}</code>
              <code>{presetName}</code>
              {activeThread && <code title={activeThread}>#{activeThread.slice(0, 8)}</code>}
            </div>
          </div>

          <section className="msglist">
            {messages.length === 0 ? (
              <div className="placeholder">
                <h2>Harness AI 工作台</h2>
                <div>以自然语言下达任务，Agent 自动调用工具、执行命令、修改代码</div>
                <div className="muted">
                  当前模式：
                  <strong>
                    {visualMode === "work" ? "Work · 办公型"
                      : visualMode === "code" ? "Code · 编程型"
                      : "Design · 设计型"}
                  </strong>
                  {"  ·  "}
                  当前模型：{presetName} · {model}
                  {paths && (<><br />codexHome: {shortPath(paths.codexHome)}</>)}
                </div>
                <div className="shortcuts">
                  {STARTER_CHIPS.map((c) => (
                    <div
                      key={c.title}
                      className="chip"
                      onClick={() => { setInput(c.text); setMode("code"); }}
                    >
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>{c.title}</div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{c.text}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m, i) => (
                <div key={i} className={`msg ${m.role}`}>
                  <div className="avatar-mini" title={m.role === "user" ? oboUsername || "User" : "Agent"}>
                    {m.role === "user" ? (oboUsername ? oboUsername.slice(0, 1).toUpperCase() : "U") : "A"}
                  </div>
                  <div className="bubble md"><Markdown text={m.text} /></div>
                </div>
              ))
            )}
            {running && (
              <div className="msg assistant">
                <div className="avatar-mini">A</div>
                <div className="bubble typing">
                  <span className="dots" />
                  <span>
                    {visualMode === "work" ? "思考中"
                      : visualMode === "design" ? "设计生成中"
                      : "Agent 正在执行任务"}
                    …
                  </span>
                </div>
              </div>
            )}
            {lastError && !running && (
              <div className="msg assistant">
                <div className="avatar-mini" style={{ background: "linear-gradient(135deg,#EF4444,#B91C1C)" }}>!</div>
                <div className="bubble" style={{ background: "#FEF2F2", borderColor: "#FECACA", color: "#991B1B" }}>
                  <strong>出错：</strong>{lastError}
                </div>
              </div>
            )}
          </section>

          <footer className="composer">
            <div className="composer-inner">
              <textarea
                rows={1}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = Math.min(e.target.scrollHeight, 180) + "px";
                }}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder={
                  visualMode === "work"
                    ? "告诉 Harness 你想做什么…（Work 模式：仅回答，不执行命令）"
                    : visualMode === "design"
                    ? "描述你的设计需求…（Design 模式：Agent 将调用工具生成设计/原型）"
                    : "告诉 Harness 要做什么…（Code 模式：Agent 将执行命令 / 修改代码 / 调用工具）"
                }
                disabled={pending || running || !paths}
              />
              <div className="composer-actions">
                <button
                  className="btn-ask"
                  disabled={pending || running || !paths || !input.trim()}
                  onClick={() => { setVisualMode("work"); setTimeout(send, 0); }}
                  title="Work 模式：只回答 / 不执行命令"
                >Work</button>
                <button
                  className="btn-code"
                  disabled={pending || running || !paths || !input.trim()}
                  onClick={() => { setVisualMode(visualMode === "design" ? "design" : "code"); setTimeout(send, 0); }}
                  title={visualMode === "design" ? "Design 模式：调用设计相关工具" : "Code 模式：Agent 执行任务"}
                >{visualMode === "design" ? "Design" : "Code"}</button>
              </div>
            </div>
            <div className="composer-meta">
              <div className="left">
                <label className="tiny-switch">
                  <input type="checkbox" checked={mode === "code"} onChange={(e) => setMode(e.target.checked ? "code" : "ask")} />
                  允许执行命令 / 改文件
                </label>
                <label className="tiny-switch">
                  <input type="checkbox" checked={autoRoute} onChange={(e) => setAutoRoute(e.target.checked)} />
                  自动路由模型
                </label>
                <label className="tiny-switch">
                  <input type="checkbox" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} />
                  敏感任务
                </label>
              </div>
              <div className="right">Enter 发送 · Shift+Enter 换行</div>
            </div>
          </footer>
        </main>

        {/* ---------- 右栏：工具抽屉 ---------- */}
        <aside className="right">
          <ToolPanel
            approvals={approvals}
            onRespond={respondApproval}
            session={{
              title: activeThread ? sessions.find((s) => s.id === activeThread)?.title : undefined,
              model, provider: presetName, cwd, threadId: activeThread ?? undefined,
              msgCount: messages.length, running, approvals: approvals.length,
              username: oboUsername || undefined,
            }}
            terminalLines={terminalLines}
            browserUrl={browserUrl}
            onBrowserUrlChange={setBrowserUrl}
          />
        </aside>
      </div>

      {/* ============ Modals ============ */}
      <ConfigPanel open={cfgOpen} onClose={() => setCfgOpen(false)} codexHome={codexHome} onSaved={onConfigSaved} onStatus={setStatus} />
      <FeishuOAuthPanel open={feishuOpen} onClose={() => setFeishuOpen(false)} onStatus={setStatus} />
      <PluginsPanel open={pluginsOpen} onClose={() => setPluginsOpen(false)} codexHome={codexHome} onStatus={setStatus} />
      <SearchPanel open={searchOpen} onClose={() => setSearchOpen(false)} codexHome={codexHome} onStatus={setStatus} />
      <SessionsPanel open={sessionsOpen} onClose={() => setSessionsOpen(false)} codexHome={codexHome} onLoad={handleLoadSession} onStatus={setStatus} />

      {/* ============ 首次启动向导（已移除 emoji）============ */}
      {onboardingOpen && (
        <div className="onboarding">
          <div className="onboarding-inner">
            <h1>欢迎使用 Harness AI 工作台</h1>
            <div className="sub">
              你的本地 Agent 工作台，Work/Code/Design 三模式切换，
              火山方舟 Ark Code 已预置为默认模型。
            </div>
            <div className="steps">
              <div className={`step ${onboardingStep >= 1 ? "done" : onboardingStep === 0 ? "now" : ""}`} />
              <div className={`step ${onboardingStep >= 2 ? "done" : onboardingStep === 1 ? "now" : ""}`} />
              <div className={`step ${onboardingStep === 2 ? "now" : ""}`} />
            </div>

            {onboardingStep === 0 && (
              <div className="onboarding-card">
                <h3>工具 · 默认模型已就绪</h3>
                <p>
                  火山方舟 Ark Code（<code>ark-code-latest</code>）已被设为默认模型，
                  API Key 由后端内嵌网关持有，可直接开箱使用。
                  你稍后可以在「设置」中切换到其他厂商。
                </p>
                <div className="ok">· 内嵌 Ark 网关 127.0.0.1:18762 转发真实 Ark 端点</div>
                <div className="ok">· wire_api: responses（Codex 新版协议）</div>
              </div>
            )}

            {onboardingStep === 1 && (
              <div className="onboarding-card">
                <h3>用户 · 账号信息（单机模式）</h3>
                <p>当前为单机运行。填写以下信息用于界面展示。</p>
                <div className="onboarding-form" style={{ marginTop: 10 }}>
                  <div>
                    <label>昵称</label>
                    <input type="text" value={oboUsername} onChange={(e) => setOboUsername(e.target.value)} placeholder="例如：张三" />
                  </div>
                  <div>
                    <label>自定义 API Key（可选，留空则使用预置）</label>
                    <input type="password" value={oboKey} onChange={(e) => setOboKey(e.target.value)} placeholder="自定义火山方舟 API Key（后期替换用）" />
                  </div>
                </div>
              </div>
            )}

            {onboardingStep === 2 && (
              <div className="onboarding-card">
                <h3>开始你的第一个任务</h3>
                <p>点击下方完成即可进入工作台。你可以直接尝试：</p>
                <ul style={{ color: "var(--text-secondary)", fontSize: 13, paddingLeft: 18, margin: 0, lineHeight: 1.8 }}>
                  <li>分析当前目录下的项目结构并生成 README</li>
                  <li>运行测试套件，定位并修复失败用例</li>
                  <li>为最近修改过的代码生成单元测试</li>
                </ul>
              </div>
            )}

            <div className="onboarding-foot">
              <button onClick={() => { if (onboardingStep === 0) finishOnboarding(); else setOnboardingStep((s) => s - 1); }}>
                {onboardingStep === 0 ? "跳过" : "上一步"}
              </button>
              {onboardingStep < 2 ? (
                <button className="primary" onClick={() => setOnboardingStep((s) => s + 1)}>下一步</button>
              ) : (
                <button className="primary" onClick={finishOnboarding}>完成，开始使用</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- 工具函数 ---------- */

function shortPath(p: string): string {
  if (!p) return "—";
  const sep = p.includes("\\") ? "\\" : "/";
  const parts = p.split(sep).filter(Boolean);
  if (parts.length <= 2) return p;
  return "…/" + parts.slice(-2).join(sep);
}

/** 从事件抽取 exec 输出 delta，馈入右栏「终端」Tab。 */
function extractCmdDelta(
  e: codex.AppEvent
): null | { ts: number; text: string; stream?: "stdout" | "stderr" | "meta" } {
  const p = e.params as Record<string, unknown> | undefined;
  if (!p) return null;
  // Codex 双方法名兼容
  let delta: unknown = null;
  let streamName: "stdout" | "stderr" | undefined;
  if (e.method === "commandExecution/outputDeltaNotification") {
    delta = p.delta;
    const s = p.outputStream as string | undefined;
    streamName = s === "stderr" ? "stderr" : "stdout";
  } else if (e.method === "item/commandExecution/outputDelta") {
    delta = p.delta;
    const s = p.outputStream as string | undefined;
    streamName = s === "stderr" ? "stderr" : "stdout";
  } else if (e.method === "item/commandExecution/requestApproval") {
    const kind = (p.kind ?? p.commandExecutionKind ?? "命令执行") as string;
    return { ts: Date.now(), text: `[请求审批] ${kind}`, stream: "meta" };
  }
  if (typeof delta === "string" && delta.length > 0) {
    return { ts: Date.now(), text: delta, stream: streamName };
  }
  return null;
}
